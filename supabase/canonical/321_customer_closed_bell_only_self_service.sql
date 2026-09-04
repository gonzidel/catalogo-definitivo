-- 321_customer_closed_bell_only_self_service.sql
-- Regla: campana de cierre (customer_closed_*) solo para auto-gestión de la clienta
-- desde su dashboard, NO para cierres manuales del admin (orders.html / Kanban).
--
-- Casos que SÍ encolan campana:
--   1) La clienta llama rpc_close_order (auth.uid() = customer_id)
--   2) Admin auto-cierra tras customer_requested_close (clienta lo inició antes)
--
-- Casos que NO encolan:
--   - Admin cierra a mano (orders.html / botón Cerrar del Kanban) sin pedido previo
--     de la clienta → fulfillment ready, sin mensaje en campana.
--
-- NO APLICAR sin aprobación explícita (regla FYL).

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
  v_is_admin boolean;
  v_is_customer_caller boolean;
  v_customer_requested_close boolean;
  v_self_service boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid())
    INTO v_is_admin;

  SELECT o.customer_id,
         o.payment_method,
         coalesce(o.notes::jsonb, '{}'::jsonb)
    INTO v_customer_id, v_payment_method, v_notes
    FROM public.orders o
   WHERE o.id = p_order_id;

  IF v_customer_id IS NULL THEN
    RETURN json_build_object('ok', false, 'error', 'order_not_found');
  END IF;

  -- Clienta auto-gestiona: el caller es el dueño del pedido.
  v_is_customer_caller := (auth.uid() = v_customer_id);

  -- Pedido iniciado por la clienta (dashboard) y auto-cerrado después por admin.
  v_customer_requested_close := coalesce(
    (v_notes->>'customer_requested_close')::boolean,
    false
  );

  v_self_service := v_is_customer_caller OR v_customer_requested_close;

  -- Cierre manual admin (sin pedido de la clienta): sin campana, liberado en closed-orders.
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
    FROM public.customers c
   WHERE c.id = v_customer_id;

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
    'fulfillment_status', v_fulfillment,
    'self_service', true
  );
END;
$$;

COMMENT ON FUNCTION public.rpc_enqueue_customer_closed_notifications(uuid) IS
  'Campana cierre: solo auto-gestión clienta (dashboard) o auto-cierre tras customer_requested_close. Cierre manual admin → skip.';

GRANT EXECUTE ON FUNCTION public.rpc_enqueue_customer_closed_notifications(uuid) TO authenticated;
