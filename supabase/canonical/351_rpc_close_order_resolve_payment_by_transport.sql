-- 351_rpc_close_order_resolve_payment_by_transport.sql
--
-- Bug A56696 / remesa SEDE 2026-09-22: el cierre desde dashboard/cliente
-- (rpc_customer_request_close, ActiveOrderTab, auto-close NJ) guardaba
-- payment_method = 'Pendiente'. La conciliación COD exige exactamente
-- 'Contra Reembolso', así que pedidos SEDE/MyM/Expreso Norte quedaban
-- fuera del universo y no liquidaban.
--
-- Regla de negocio (paridad closed-orders / fn_closed_order_transport_category):
--   - SEDE / MyM / Expreso Norte → Contra Reembolso
--     (salvo preferred_payment_method Pagado del cliente → Pagado)
--   - resto de transportes → Pagado
--   - Si admin/PAU pasa un método explícito distinto de Pendiente
--     (Efectivo, Tarjeta, Pagado, Contra Reembolso, …) se respeta.
--
-- 'Pendiente' deja de ser un valor final de cierre.

-- =============================================================================
-- Resolver método de pago al cerrar
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_resolve_order_close_payment_method(
  p_order_id uuid,
  p_payment_method text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_explicit text;
  v_customer_id uuid;
  v_transport_name text := '';
  v_category text;
BEGIN
  v_explicit := nullif(trim(coalesce(p_payment_method, '')), '');

  -- Métodos reales elegidos a mano (admin / PAU / cobro local). No reescribir.
  IF v_explicit IS NOT NULL
     AND lower(v_explicit) NOT IN ('pendiente', 'pending') THEN
    RETURN v_explicit;
  END IF;

  SELECT
    o.customer_id,
    coalesce(nullif(trim(t_order.name), ''), nullif(trim(t_cust.name), ''), '')
  INTO v_customer_id, v_transport_name
  FROM public.orders o
  LEFT JOIN public.transports t_order ON t_order.id = o.transport_id
  LEFT JOIN public.customers c ON c.id = o.customer_id
  LEFT JOIN public.transports t_cust ON t_cust.id = c.transport_id
  WHERE o.id = p_order_id;

  IF v_customer_id IS NULL THEN
    RETURN 'Pagado';
  END IF;

  v_category := public.fn_effective_closed_fulfillment_category(
    v_transport_name,
    v_customer_id,
    NULL
  );

  IF v_category = 'cod' THEN
    RETURN 'Contra Reembolso';
  END IF;

  RETURN 'Pagado';
END;
$function$;

COMMENT ON FUNCTION public.fn_resolve_order_close_payment_method(uuid, text) IS
  'canonical:351 | Al cerrar: COD→Contra Reembolso, resto→Pagado; respeta método explícito ≠ Pendiente.';

-- =============================================================================
-- rpc_close_order: nunca persistir Pendiente
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_close_order(
  p_order_id uuid,
  p_payment_method text DEFAULT NULL::text
)
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
  v_payment_method text;
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

  -- stock ya se descontó en rpc_checkout_cart (fingerprint guard 150 / canon close)
  v_payment_method := public.fn_resolve_order_close_payment_method(
    p_order_id,
    p_payment_method
  );

  UPDATE public.orders
  SET status = 'closed',
      payment_method = v_payment_method,
      closed_at = now(),
      updated_at = now()
  WHERE id = p_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No se pudo cerrar el pedido.';
  END IF;

  PERFORM public.rpc_enqueue_customer_closed_notifications(p_order_id);
END;
$function$;

COMMENT ON FUNCTION public.rpc_close_order(uuid, text) IS
  'canonical:351 | Cierra pedido sin re-descontar stock (stock ya se descontó en rpc_checkout_cart). Pago por transporte: COD→Contra Reembolso, resto→Pagado; no persiste Pendiente.';

-- =============================================================================
-- rpc_customer_request_close: deja que rpc_close_order resuelva el pago
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_customer_request_close(p_order_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_order record;
  v_notes jsonb;
  v_pending_count int;
  v_transport_name text := '';
  v_is_local_pickup boolean := false;
  v_closed boolean := false;
BEGIN
  SELECT o.id, o.customer_id, o.status, o.notes, o.dismantle_at, o.transport_id
  INTO v_order
  FROM public.orders o
  WHERE o.id = p_order_id
  FOR UPDATE;

  IF v_order.id IS NULL THEN
    RAISE EXCEPTION 'Pedido no encontrado';
  END IF;

  IF v_order.customer_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'No tenés permiso para modificar este pedido';
  END IF;

  IF lower(trim(coalesce(v_order.status, ''))) NOT IN ('active', 'closing_soon') THEN
    RAISE EXCEPTION 'El pedido no está en un estado que permita solicitar cierre';
  END IF;

  IF v_order.dismantle_at IS NOT NULL AND now() >= v_order.dismantle_at THEN
    RAISE EXCEPTION 'Pedido vencido';
  END IF;

  v_notes := coalesce(v_order.notes::jsonb, '{}'::jsonb);
  v_notes := jsonb_set(v_notes, '{customer_requested_close}', 'true'::jsonb);

  UPDATE public.orders
  SET notes = v_notes::text,
      updated_at = now()
  WHERE id = p_order_id;

  SELECT count(*)::int
  INTO v_pending_count
  FROM public.order_items
  WHERE order_id = p_order_id
    AND status IN ('reserved', 'waiting', 'awaiting_apartado');

  SELECT coalesce(nullif(trim(t.name), ''), '')
  INTO v_transport_name
  FROM public.transports t
  WHERE t.id = v_order.transport_id;

  v_transport_name := coalesce(v_transport_name, '');
  v_is_local_pickup :=
    lower(v_transport_name) IN ('retira local', 'retiro de local');

  IF coalesce(v_pending_count, 0) = 0 AND NOT v_is_local_pickup THEN
    -- NULL → rpc_close_order resuelve Contra Reembolso / Pagado por transporte
    PERFORM public.rpc_close_order(p_order_id, NULL);
    v_closed := true;
  END IF;

  RETURN json_build_object(
    'ok', true,
    'order_id', p_order_id,
    'closed', v_closed,
    'pending_items', coalesce(v_pending_count, 0),
    'local_pickup', v_is_local_pickup
  );
END;
$function$;

COMMENT ON FUNCTION public.rpc_customer_request_close(uuid) IS
  'Cliente: marca customer_requested_close. Si ya listo y no es retiro local, cierra vía rpc_close_order (pago por transporte). Retiro local solo deja el flag.';

-- =============================================================================
-- Sweep 349: no escribir Pendiente; usar el mismo resolver
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_close_stuck_customer_requested_orders()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  r record;
  v_closed int := 0;
  v_skipped_local int := 0;
  v_errors int := 0;
  v_payment text;
BEGIN
  FOR r IN
    SELECT o.id, o.order_number, coalesce(t.name, '') AS transport_name
    FROM public.orders o
    LEFT JOIN public.transports t ON t.id = o.transport_id
    WHERE o.status IN ('active', 'closing_soon')
      AND coalesce((o.notes::jsonb ->> 'customer_requested_close')::boolean, false) = true
      AND NOT EXISTS (
        SELECT 1
        FROM public.order_items oi
        WHERE oi.order_id = o.id
          AND oi.status IN ('reserved', 'waiting', 'awaiting_apartado')
      )
      AND EXISTS (
        SELECT 1
        FROM public.order_items oi
        WHERE oi.order_id = o.id
          AND oi.status = 'picked'
      )
  LOOP
    IF lower(trim(r.transport_name)) IN ('retira local', 'retiro de local') THEN
      v_skipped_local := v_skipped_local + 1;
      CONTINUE;
    END IF;

    BEGIN
      v_payment := public.fn_resolve_order_close_payment_method(r.id, NULL);

      UPDATE public.orders
      SET
        status = 'closed',
        payment_method = v_payment,
        closed_at = coalesce(closed_at, now()),
        updated_at = now()
      WHERE id = r.id
        AND status IN ('active', 'closing_soon');

      IF FOUND THEN
        BEGIN
          PERFORM public.rpc_enqueue_customer_closed_notifications(r.id);
        EXCEPTION
          WHEN OTHERS THEN
            RAISE NOTICE 'rpc_close_stuck: notify failed for %: %', r.order_number, SQLERRM;
        END;
        v_closed := v_closed + 1;
      END IF;
    EXCEPTION
      WHEN OTHERS THEN
        v_errors := v_errors + 1;
        RAISE NOTICE 'rpc_close_stuck: failed %: %', r.order_number, SQLERRM;
    END;
  END LOOP;

  RETURN json_build_object(
    'ok', true,
    'closed', v_closed,
    'skipped_local_pickup', v_skipped_local,
    'errors', v_errors
  );
END;
$function$;

COMMENT ON FUNCTION public.rpc_close_stuck_customer_requested_orders() IS
  'canonical:351 | Sweep: cierra pedidos stuck con customer_requested_close; pago por transporte (sin Pendiente).';

GRANT EXECUTE ON FUNCTION public.fn_resolve_order_close_payment_method(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_close_order(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_customer_request_close(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_close_stuck_customer_requested_orders() TO authenticated;

-- =============================================================================
-- Guard 150: actualizar fingerprint de rpc_close_order a canonical:351
-- =============================================================================

DO $$
DECLARE
  v_def text;
  v_comment text;
BEGIN
  SELECT pg_get_functiondef('public.rpc_close_order(uuid,text)'::regprocedure) INTO v_def;
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'Guard 351: falta public.rpc_close_order(uuid,text)';
  END IF;

  SELECT obj_description('public.rpc_close_order(uuid,text)'::regprocedure, 'pg_proc') INTO v_comment;
  IF coalesce(v_comment, '') !~ '^canonical:351([[:space:]]|$)' THEN
    RAISE EXCEPTION
      'Guard 351: rpc_close_order fuera de canon (esperado canonical:351, actual: %)',
      coalesce(v_comment, '<sin comentario>');
  END IF;

  IF position('stock ya se descontó en rpc_checkout_cart' in v_def) = 0
     OR position('fn_resolve_order_close_payment_method' in v_def) = 0
     OR position('status = ''closed''' in v_def) = 0 THEN
    RAISE EXCEPTION 'Guard 351: rpc_close_order no coincide con fingerprint canónico esperado';
  END IF;
END $$;
