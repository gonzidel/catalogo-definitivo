-- 320_closed_order_fulfillment.sql
-- Cierre clienta → campana admin, confirmación de pago y flujo Correo Argentino.
-- NO APLICAR en producción sin aprobación explícita.

-- =============================================================================
-- Columnas en orders
-- =============================================================================

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS payment_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS correo_shipping_cost numeric(12, 2),
  ADD COLUMN IF NOT EXISTS closed_fulfillment_status text;

COMMENT ON COLUMN public.orders.closed_fulfillment_status IS
  'ready | awaiting_customer_message | awaiting_payment | awaiting_correo_cost';

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS preferred_payment_method text;

COMMENT ON COLUMN public.customers.preferred_payment_method IS
  'Preferencia persistente admin (ej. Pagado). En transportes COD (MyM/SEDE/Expreso Norte) activa protocolo transferencia.';

-- =============================================================================
-- Tabla: pagos pendientes de confirmación (panel Pagos Kanban)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.admin_order_payment_pending (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  customer_name text NOT NULL DEFAULT '',
  customer_phone text,
  transport_name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  CONSTRAINT admin_order_payment_pending_order_id_key UNIQUE (order_id)
);

CREATE INDEX IF NOT EXISTS idx_admin_payment_pending_open
  ON public.admin_order_payment_pending (created_at DESC)
  WHERE confirmed_at IS NULL;

ALTER TABLE public.admin_order_payment_pending ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'admin_order_payment_pending'
       AND policyname = 'admin_payment_pending_admin_all'
  ) THEN
    CREATE POLICY admin_payment_pending_admin_all
      ON public.admin_order_payment_pending
      FOR ALL
      TO authenticated
      USING (EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()))
      WITH CHECK (EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()));
  END IF;
END $$;

-- =============================================================================
-- Helpers: transporte y totales
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_normalize_transport_key(p_input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
  SELECT trim(regexp_replace(
    lower(
      translate(
        coalesce(p_input, ''),
        'áéíóúüñÁÉÍÓÚÜÑ',
        'aeiouunAEIOUUN'
      )
    ),
    '\s+', ' ', 'g'
  ));
$$;

CREATE OR REPLACE FUNCTION public.fn_canonicalize_transport_name(p_input text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_key text;
BEGIN
  v_key := public.fn_normalize_transport_key(p_input);
  IF v_key = '' THEN
    RETURN trim(coalesce(p_input, ''));
  END IF;
  IF v_key IN ('mym') THEN RETURN 'MyM'; END IF;
  IF v_key IN ('sede') THEN RETURN 'SEDE'; END IF;
  IF v_key IN ('via cargo', 'viacargo') THEN RETURN 'Via Cargo'; END IF;
  IF v_key IN ('credifin') THEN RETURN 'Credifin'; END IF;
  IF v_key IN ('snaider', 'transporte snaider') THEN RETURN 'Snaider'; END IF;
  IF v_key IN ('correo argentino') THEN RETURN 'Correo Argentino'; END IF;
  IF v_key IN ('expreso norte') THEN RETURN 'Expreso Norte'; END IF;
  IF v_key IN ('retira local', 'retiro de local', 'retiro del local', 'retiro local') THEN
    RETURN 'Retira local';
  END IF;
  RETURN trim(coalesce(p_input, ''));
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_closed_order_transport_category(p_transport_name text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_canon text;
BEGIN
  v_canon := public.fn_canonicalize_transport_name(p_transport_name);
  IF v_canon IN ('MyM', 'SEDE', 'Expreso Norte') THEN
    RETURN 'cod';
  END IF;
  IF v_canon IN ('Via Cargo', 'Credifin', 'Snaider') THEN
    RETURN 'transfer';
  END IF;
  IF v_canon = 'Correo Argentino' THEN
    RETURN 'correo';
  END IF;
  IF v_canon = 'Retira local' THEN
    RETURN 'local_pickup';
  END IF;
  RETURN 'other';
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_normalize_payment_method_key(p_input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
  SELECT lower(trim(coalesce(p_input, '')));
$$;

CREATE OR REPLACE FUNCTION public.fn_is_pagado_payment_method(p_input text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
  SELECT public.fn_normalize_payment_method_key(p_input) IN ('pagado', 'pago', 'transferencia', 'transferencia bancaria');
$$;

CREATE OR REPLACE FUNCTION public.fn_customer_prefers_pagado(p_customer_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT public.fn_is_pagado_payment_method(c.preferred_payment_method)
    FROM public.customers c
   WHERE c.id = p_customer_id;
$$;

CREATE OR REPLACE FUNCTION public.fn_effective_closed_fulfillment_category(
  p_transport_name text,
  p_customer_id uuid,
  p_order_payment_method text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_base text;
BEGIN
  v_base := public.fn_closed_order_transport_category(p_transport_name);
  IF v_base = 'cod' AND (
    public.fn_customer_prefers_pagado(p_customer_id)
    OR public.fn_is_pagado_payment_method(p_order_payment_method)
  ) THEN
    RETURN 'transfer';
  END IF;
  RETURN v_base;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_compute_closed_order_products_total(p_order_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_subtotal numeric := 0;
  v_notes jsonb;
  v_shipping numeric := 0;
  v_discount numeric := 0;
  v_extras numeric := 0;
  v_extras_pct numeric := 0;
BEGIN
  SELECT coalesce(sum((coalesce(oi.quantity, 0)::numeric * coalesce(oi.price_snapshot, 0)::numeric)), 0)
    INTO v_subtotal
    FROM public.order_items oi
   WHERE oi.order_id = p_order_id
     AND coalesce(oi.status, '') <> 'cancelled';

  SELECT coalesce(o.notes::jsonb, '{}'::jsonb)
    INTO v_notes
    FROM public.orders o
   WHERE o.id = p_order_id;

  v_shipping := coalesce((v_notes->>'shipping')::numeric, (v_notes->>'shipping_cost')::numeric, 0);
  v_discount := coalesce((v_notes->>'discount')::numeric, 0);
  v_extras := coalesce((v_notes->>'extras_amount')::numeric, (v_notes->>'extras')::numeric, 0);
  v_extras_pct := coalesce((v_notes->>'extras_percentage')::numeric, 0);

  RETURN greatest(0,
    v_subtotal + v_shipping - v_discount + v_extras + (v_subtotal * v_extras_pct / 100)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_format_price_ar(p_amount numeric)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_n bigint;
BEGIN
  v_n := round(coalesce(p_amount, 0))::bigint;
  RETURN '$' || to_char(v_n, 'FM999G999G999G999');
END;
$$;

-- Constantes bancarias FYL
CREATE OR REPLACE FUNCTION public.fn_fyl_transfer_alias()
RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT '0170218940000003684953'::text $$;

CREATE OR REPLACE FUNCTION public.fn_fyl_transfer_cbu()
RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT 'calzados.fyl.2025'::text $$;

CREATE OR REPLACE FUNCTION public.fn_fyl_transfer_titular()
RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT 'DE LA FUENTE FERNANDO'::text $$;

-- =============================================================================
-- Builders de mensajes WhatsApp (paridad nj/lib/orders/closed-order-messages.ts)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_build_closed_order_cod_message(
  p_transporte text,
  p_total numeric
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
BEGIN
  RETURN 'Hola 👋 Tu pedido fue finalizado correctamente.' || E'\n\n'
    || '🚚 El transporte asignado para tu envío es *' || coalesce(p_transporte, 'tu transporte') || '*.' || E'\n\n'
    || 'El total de tu pedido es de *' || public.fn_format_price_ar(p_total) || '*. '
    || 'Este monto deberás abonarlo *en efectivo al transportista al momento de recibir el paquete*, '
    || 'junto con el costo del envío.' || E'\n\n'
    || 'Cualquier duda que tengas sobre tu envío o el pago, podés escribirnos 😊';
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_build_closed_order_transfer_message(
  p_transporte text,
  p_total numeric
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
BEGIN
  RETURN 'Hola 👋 Tu pedido fue finalizado correctamente.' || E'\n\n'
    || '🚚 El transporte asignado para tu envío es *' || coalesce(p_transporte, 'tu transporte') || '*.' || E'\n\n'
    || 'El total de tu pedido es de *' || public.fn_format_price_ar(p_total)
    || '* y deberá abonarse por transferencia antes del envío.' || E'\n\n'
    || '🏦 *Datos para la transferencia*' || E'\n'
    || 'Alias: ' || public.fn_fyl_transfer_alias() || E'\n'
    || 'CBU/CVU: ' || public.fn_fyl_transfer_cbu() || E'\n'
    || 'Titular: ' || public.fn_fyl_transfer_titular() || E'\n\n'
    || 'Una vez realizada la transferencia, por favor envianos el comprobante por este medio.' || E'\n\n'
    || 'Cualquier duda que tengas, podés escribirnos 😊';
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_build_closed_order_correo_message(
  p_total_productos numeric,
  p_costo_envio numeric
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_total numeric;
BEGIN
  v_total := coalesce(p_total_productos, 0) + coalesce(p_costo_envio, 0);
  RETURN 'Hola 👋 Tu pedido fue finalizado correctamente.' || E'\n\n'
    || '📦 El envío se realizará por *Correo Argentino*.' || E'\n\n'
    || 'Para realizar el despacho, deberás abonar previamente el valor del pedido y el costo del envío.' || E'\n\n'
    || 'Productos: *' || public.fn_format_price_ar(p_total_productos) || '*' || E'\n'
    || 'Envío: *' || public.fn_format_price_ar(p_costo_envio) || '*' || E'\n'
    || '*Total a transferir: ' || public.fn_format_price_ar(v_total) || '*' || E'\n\n'
    || 'El costo del envío es calculado por Correo Argentino según el peso y tamaño del paquete.' || E'\n\n'
    || '🏦 *Datos para la transferencia*' || E'\n'
    || 'Alias: ' || public.fn_fyl_transfer_alias() || E'\n'
    || 'CBU/CVU: ' || public.fn_fyl_transfer_cbu() || E'\n'
    || 'Titular: ' || public.fn_fyl_transfer_titular() || E'\n\n'
    || 'Una vez realizada la transferencia, por favor envianos el comprobante por este medio.' || E'\n\n'
    || 'Cualquier duda que tengas, podés escribirnos 😊';
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_build_payment_confirmed_message()
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
  SELECT 'Confirmamos correctamente el pago de tu pedido.' || E'\n\n'
    || 'Ahora vamos a prepararlo para el despacho. Una vez enviado, te enviaremos los datos de seguimiento '
    || 'para que puedas consultar el estado de tu envío.' || E'\n\n'
    || 'Cualquier consulta, podés escribirnos 😊';
$$;

-- =============================================================================
-- Resolver transporte de un pedido cerrado
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_resolve_order_transport_name(p_order_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_name text;
BEGIN
  SELECT coalesce(t_order.name, t_customer.name, '')
    INTO v_name
    FROM public.orders o
    LEFT JOIN public.customers c ON c.id = o.customer_id
    LEFT JOIN public.transports t_order ON t_order.id = o.transport_id
    LEFT JOIN public.transports t_customer ON t_customer.id = c.transport_id
   WHERE o.id = p_order_id;

  RETURN public.fn_canonicalize_transport_name(v_name);
END;
$$;

-- =============================================================================
-- Crear fila payment pending (idempotente)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_ensure_payment_pending(
  p_order_id uuid,
  p_customer_name text,
  p_customer_phone text,
  p_transport_name text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  INSERT INTO public.admin_order_payment_pending (
    order_id, customer_name, customer_phone, transport_name
  )
  VALUES (
    p_order_id,
    coalesce(p_customer_name, ''),
    p_customer_phone,
    coalesce(p_transport_name, '')
  )
  ON CONFLICT (order_id) DO UPDATE
    SET customer_name = excluded.customer_name,
        customer_phone = excluded.customer_phone,
        transport_name = excluded.transport_name
  WHERE public.admin_order_payment_pending.confirmed_at IS NULL;
END;
$$;

-- =============================================================================
-- RPC: encolar notificación al cerrar pedido (llamada desde rpc_close_order)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_enqueue_customer_closed_notifications(p_order_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_transport text;
  v_category text;
  v_total numeric;
  v_customer_name text;
  v_customer_phone text;
  v_customer_id uuid;
  v_payment_method text;
  v_notes jsonb;
  v_msg text;
  v_kind text;
  v_notif_id uuid;
  v_fulfillment text;
  v_is_customer_caller boolean;
  v_customer_requested_close boolean;
  v_self_service boolean;
BEGIN
  SELECT o.customer_id,
         o.payment_method,
         coalesce(o.notes::jsonb, '{}'::jsonb)
    INTO v_customer_id, v_payment_method, v_notes
    FROM public.orders o
   WHERE o.id = p_order_id;

  IF v_customer_id IS NULL THEN
    RETURN json_build_object('ok', false, 'error', 'order_not_found');
  END IF;

  -- Solo auto-gestión clienta (dashboard) o auto-cierre tras customer_requested_close.
  -- Cierre manual admin (orders.html / Kanban) → sin campana. Ver migración 321.
  v_is_customer_caller := (auth.uid() = v_customer_id);
  v_customer_requested_close := coalesce(
    (v_notes->>'customer_requested_close')::boolean,
    false
  );
  v_self_service := v_is_customer_caller OR v_customer_requested_close;

  IF NOT v_self_service THEN
    UPDATE public.orders
       SET closed_fulfillment_status = 'ready',
           payment_confirmed_at = coalesce(payment_confirmed_at, now())
     WHERE id = p_order_id;
    RETURN json_build_object(
      'ok', true,
      'skipped', true,
      'reason', 'admin_manual_close'
    );
  END IF;

  v_transport := public.fn_resolve_order_transport_name(p_order_id);
  v_category := public.fn_effective_closed_fulfillment_category(
    v_transport,
    v_customer_id,
    v_payment_method
  );

  IF v_category IN ('local_pickup', 'other') THEN
    UPDATE public.orders
       SET closed_fulfillment_status = 'ready',
           payment_confirmed_at = coalesce(payment_confirmed_at, now())
     WHERE id = p_order_id;
    RETURN json_build_object('ok', true, 'skipped', true, 'reason', v_category);
  END IF;

  SELECT coalesce(c.full_name, 'Cliente'), c.phone
    INTO v_customer_name, v_customer_phone
    FROM public.orders o
    JOIN public.customers c ON c.id = o.customer_id
   WHERE o.id = p_order_id;

  v_total := public.fn_compute_closed_order_products_total(p_order_id);

  IF v_category = 'cod' THEN
    v_kind := 'customer_closed_cod';
    v_msg := public.fn_build_closed_order_cod_message(v_transport, v_total);
    v_fulfillment := 'ready';
  ELSIF v_category = 'transfer' THEN
    v_kind := 'customer_closed_transfer';
    v_msg := public.fn_build_closed_order_transfer_message(v_transport, v_total);
    v_fulfillment := 'awaiting_customer_message';
  ELSIF v_category = 'correo' THEN
    UPDATE public.orders
       SET closed_fulfillment_status = 'awaiting_correo_cost',
           correo_shipping_cost = NULL
     WHERE id = p_order_id;
    RETURN json_build_object('ok', true, 'skipped', true, 'reason', 'awaiting_correo_cost');
  ELSE
    RETURN json_build_object('ok', true, 'skipped', true);
  END IF;

  -- Evitar duplicados
  IF EXISTS (
    SELECT 1 FROM public.admin_order_message_notifications
     WHERE order_id = p_order_id
       AND kind = v_kind
       AND dismissed_at IS NULL
  ) THEN
    RETURN json_build_object('ok', true, 'duplicate', true);
  END IF;

  INSERT INTO public.admin_order_message_notifications (
    order_id, customer_name, customer_phone, message, kind
  )
  VALUES (p_order_id, v_customer_name, v_customer_phone, v_msg, v_kind)
  RETURNING id INTO v_notif_id;

  UPDATE public.orders
     SET closed_fulfillment_status = v_fulfillment
   WHERE id = p_order_id;

  RETURN json_build_object(
    'ok', true,
    'notification_id', v_notif_id,
    'kind', v_kind,
    'fulfillment_status', v_fulfillment
  );
END;
$$;

-- =============================================================================
-- RPC: completar mensaje cerrado (enviar o dismiss) → payment pending si aplica
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_complete_customer_closed_notification(
  p_notification_id uuid,
  p_mark_copied boolean DEFAULT false
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_notif record;
  v_transport text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Solo administradores';
  END IF;

  SELECT id, order_id, customer_name, customer_phone, kind, dismissed_at
    INTO v_notif
    FROM public.admin_order_message_notifications
   WHERE id = p_notification_id;

  IF v_notif.id IS NULL THEN
    RAISE EXCEPTION 'Notificación no encontrada';
  END IF;

  IF v_notif.dismissed_at IS NOT NULL THEN
    RETURN json_build_object('ok', true, 'already_done', true);
  END IF;

  UPDATE public.admin_order_message_notifications
     SET copied_at = CASE WHEN p_mark_copied THEN coalesce(copied_at, now()) ELSE copied_at END,
         dismissed_at = now()
   WHERE id = p_notification_id;

  IF v_notif.kind IN ('customer_closed_transfer', 'customer_closed_correo') THEN
    v_transport := public.fn_resolve_order_transport_name(v_notif.order_id);

    UPDATE public.orders
       SET closed_fulfillment_status = 'awaiting_payment'
     WHERE id = v_notif.order_id;

    PERFORM public.fn_ensure_payment_pending(
      v_notif.order_id,
      v_notif.customer_name,
      v_notif.customer_phone,
      v_transport
    );

    RETURN json_build_object('ok', true, 'payment_pending', true);
  END IF;

  RETURN json_build_object('ok', true, 'payment_pending', false);
END;
$$;

-- =============================================================================
-- RPC: costo envío Correo Argentino
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_set_correo_shipping_cost(
  p_order_id uuid,
  p_cost numeric
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_transport text;
  v_category text;
  v_total numeric;
  v_customer_name text;
  v_customer_phone text;
  v_msg text;
  v_notif_id uuid;
  v_cost numeric;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Solo administradores';
  END IF;

  v_cost := greatest(0, coalesce(p_cost, 0));
  IF v_cost <= 0 THEN
    RAISE EXCEPTION 'El costo de envío debe ser mayor a cero';
  END IF;

  v_transport := public.fn_resolve_order_transport_name(p_order_id);
  v_category := public.fn_closed_order_transport_category(v_transport);

  IF v_category <> 'correo' THEN
    RAISE EXCEPTION 'El pedido no es de Correo Argentino';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.orders
     WHERE id = p_order_id
       AND status = 'closed'
       AND closed_fulfillment_status = 'awaiting_correo_cost'
  ) THEN
    RAISE EXCEPTION 'El pedido no está pendiente de costo de envío';
  END IF;

  SELECT coalesce(c.full_name, 'Cliente'), c.phone
    INTO v_customer_name, v_customer_phone
    FROM public.orders o
    JOIN public.customers c ON c.id = o.customer_id
   WHERE o.id = p_order_id;

  v_total := public.fn_compute_closed_order_products_total(p_order_id);
  v_msg := public.fn_build_closed_order_correo_message(v_total, v_cost);

  UPDATE public.orders
     SET correo_shipping_cost = v_cost,
         closed_fulfillment_status = 'awaiting_customer_message'
   WHERE id = p_order_id;

  IF EXISTS (
    SELECT 1 FROM public.admin_order_message_notifications
     WHERE order_id = p_order_id
       AND kind = 'customer_closed_correo'
       AND dismissed_at IS NULL
  ) THEN
    RETURN json_build_object('ok', true, 'duplicate', true);
  END IF;

  INSERT INTO public.admin_order_message_notifications (
    order_id, customer_name, customer_phone, message, kind
  )
  VALUES (p_order_id, v_customer_name, v_customer_phone, v_msg, 'customer_closed_correo')
  RETURNING id INTO v_notif_id;

  RETURN json_build_object('ok', true, 'notification_id', v_notif_id);
END;
$$;

-- =============================================================================
-- RPC: confirmar pago
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_confirm_closed_order_payment(p_order_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Solo administradores';
  END IF;

  UPDATE public.orders
     SET payment_confirmed_at = coalesce(payment_confirmed_at, now()),
         closed_fulfillment_status = 'ready'
   WHERE id = p_order_id;

  UPDATE public.admin_order_payment_pending
     SET confirmed_at = coalesce(confirmed_at, now())
   WHERE order_id = p_order_id
     AND confirmed_at IS NULL;

  RETURN json_build_object('ok', true);
END;
$$;

-- =============================================================================
-- RPC: listar pagos pendientes
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_list_admin_payment_pending()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_rows json;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Solo administradores';
  END IF;

  SELECT coalesce(json_agg(row_to_json(t)), '[]'::json)
    INTO v_rows
    FROM (
      SELECT id, order_id, customer_name, customer_phone, transport_name, created_at
        FROM public.admin_order_payment_pending
       WHERE confirmed_at IS NULL
       ORDER BY created_at DESC
       LIMIT 50
    ) t;

  RETURN json_build_object('ok', true, 'payments', v_rows);
END;
$$;

-- =============================================================================
-- RPC: listar pedidos correo pendientes de costo (closed-orders.html)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_list_correo_pending_shipping_cost()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_rows json;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Solo administradores';
  END IF;

  SELECT coalesce(json_agg(row_to_json(t)), '[]'::json)
    INTO v_rows
    FROM (
      SELECT o.id AS order_id,
             coalesce(c.full_name, 'Cliente') AS customer_name,
             o.order_number,
             o.closed_at
        FROM public.orders o
        JOIN public.customers c ON c.id = o.customer_id
       WHERE o.status = 'closed'
         AND o.closed_fulfillment_status = 'awaiting_correo_cost'
       ORDER BY o.closed_at DESC NULLS LAST
       LIMIT 50
    ) t;

  RETURN json_build_object('ok', true, 'orders', v_rows);
END;
$$;

-- =============================================================================
-- RPC: COD (MyM/SEDE/Expreso Norte) → Pagado desde closed-orders
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_switch_cod_order_to_pagado(
  p_order_id uuid,
  p_persist boolean DEFAULT false
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_transport text;
  v_base_category text;
  v_customer_id uuid;
  v_customer_name text;
  v_customer_phone text;
  v_order_status text;
  v_total numeric;
  v_msg text;
  v_notif_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Solo administradores';
  END IF;

  SELECT o.customer_id, o.status
    INTO v_customer_id, v_order_status
    FROM public.orders o
   WHERE o.id = p_order_id;

  IF v_customer_id IS NULL THEN
    RAISE EXCEPTION 'Pedido no encontrado';
  END IF;

  IF v_order_status <> 'closed' THEN
    RAISE EXCEPTION 'El pedido no está cerrado';
  END IF;

  v_transport := public.fn_resolve_order_transport_name(p_order_id);
  v_base_category := public.fn_closed_order_transport_category(v_transport);

  IF v_base_category <> 'cod' THEN
    RAISE EXCEPTION 'Solo aplica a transportes MyM, SEDE o Expreso Norte';
  END IF;

  SELECT coalesce(c.full_name, 'Cliente'), c.phone
    INTO v_customer_name, v_customer_phone
    FROM public.customers c
   WHERE c.id = v_customer_id;

  -- Descartar aviso COD previo si existía
  UPDATE public.admin_order_message_notifications
     SET dismissed_at = coalesce(dismissed_at, now())
   WHERE order_id = p_order_id
     AND kind = 'customer_closed_cod'
     AND dismissed_at IS NULL;

  IF p_persist THEN
    UPDATE public.customers
       SET preferred_payment_method = 'Pagado'
     WHERE id = v_customer_id;

    v_total := public.fn_compute_closed_order_products_total(p_order_id);
    v_msg := public.fn_build_closed_order_transfer_message(v_transport, v_total);

    UPDATE public.admin_order_message_notifications
       SET dismissed_at = coalesce(dismissed_at, now())
     WHERE order_id = p_order_id
       AND kind IN ('customer_closed_transfer', 'customer_closed_correo')
       AND dismissed_at IS NULL;

    INSERT INTO public.admin_order_message_notifications (
      order_id, customer_name, customer_phone, message, kind
    )
    VALUES (p_order_id, v_customer_name, v_customer_phone, v_msg, 'customer_closed_transfer')
    RETURNING id INTO v_notif_id;

    UPDATE public.orders
       SET payment_method = 'Pagado',
           payment_confirmed_at = NULL,
           closed_fulfillment_status = 'awaiting_customer_message'
     WHERE id = p_order_id;

    RETURN json_build_object(
      'ok', true,
      'mode', 'persist',
      'notification_id', v_notif_id,
      'fulfillment_status', 'awaiting_customer_message'
    );
  END IF;

  UPDATE public.orders
     SET payment_method = 'Pagado',
         payment_confirmed_at = coalesce(payment_confirmed_at, now()),
         closed_fulfillment_status = 'ready'
   WHERE id = p_order_id;

  RETURN json_build_object(
    'ok', true,
    'mode', 'single_shipment',
    'fulfillment_status', 'ready'
  );
END;
$$;

-- =============================================================================
-- Hook en rpc_close_order
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_close_order(p_order_id uuid, p_payment_method text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_customer_id uuid;
  v_is_admin boolean;
  v_status text;
  v_dismantle_at timestamptz;
  v_pending_count int;
BEGIN
  SELECT EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()) INTO v_is_admin;

  SELECT customer_id, status, dismantle_at
  INTO v_customer_id, v_status, v_dismantle_at
  FROM public.orders
  WHERE id = p_order_id;

  IF v_customer_id IS NULL THEN
    RAISE EXCEPTION 'Pedido no encontrado';
  END IF;

  IF v_status = 'expired' THEN
    RAISE EXCEPTION 'Pedido vencido';
  END IF;

  IF v_dismantle_at IS NOT NULL AND now() >= v_dismantle_at THEN
    RAISE EXCEPTION 'Pedido vencido';
  END IF;

  IF NOT v_is_admin AND v_customer_id != auth.uid() THEN
    RAISE EXCEPTION 'No tienes permiso para cerrar este pedido';
  END IF;

  SELECT count(*)
  INTO v_pending_count
  FROM public.order_items
  WHERE order_id = p_order_id
    AND status IN ('reserved', 'waiting', 'awaiting_apartado');

  IF v_pending_count > 0 THEN
    RAISE EXCEPTION 'No se puede cerrar: hay % ítem(s) todavía reservado(s) o en espera', v_pending_count;
  END IF;

  UPDATE public.orders
  SET status = 'closed',
      payment_method = p_payment_method,
      closed_at = now(),
      updated_at = now()
  WHERE id = p_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No se pudo cerrar el pedido.';
  END IF;

  PERFORM public.rpc_enqueue_customer_closed_notifications(p_order_id);
END;
$function$;

-- Realtime para payment pending
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'admin_order_payment_pending'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.admin_order_payment_pending;
  END IF;
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

GRANT EXECUTE ON FUNCTION public.rpc_enqueue_customer_closed_notifications(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_complete_customer_closed_notification(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_set_correo_shipping_cost(uuid, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_confirm_closed_order_payment(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_list_admin_payment_pending() TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_list_correo_pending_shipping_cost() TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_switch_cod_order_to_pagado(uuid, boolean) TO authenticated;
