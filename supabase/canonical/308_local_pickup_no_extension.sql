-- 308_local_pickup_no_extension.sql
--
-- Clientes de retiro local acotado (Resistencia, Barranqueras, Puerto Vilelas,
-- Fontana — Chaco) no pueden solicitar prórroga de 24 h desde el dashboard.
-- El mínimo de 4 unidades para cerrar se maneja en frontend (sin chequeo en
-- rpc_close_order); esta migración solo refuerza la prórroga en servidor.

CREATE OR REPLACE FUNCTION public.rpc_customer_request_order_extension_24h(p_order_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $function$
DECLARE
  v_uid uuid;
  v_order record;
  v_notes_obj jsonb;
  v_customer_uses int;
  v_new_dismantle timestamptz;
  v_province text;
  v_city text;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  SELECT id, customer_id, status, dismantle_at, notes
  INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF v_order.id IS NULL THEN
    RAISE EXCEPTION 'Pedido no encontrado';
  END IF;

  IF v_order.customer_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'No tenés permiso para modificar este pedido';
  END IF;

  SELECT c.province, c.city
  INTO v_province, v_city
  FROM public.customers c
  WHERE c.id = v_order.customer_id;

  IF public.fn_is_local_pickup_short_deadline_zone(v_province, v_city) THEN
    RAISE EXCEPTION 'Los pedidos de retiro en local de tu zona no admiten prórroga de 24 horas';
  END IF;

  IF lower(trim(coalesce(v_order.status, ''))) NOT IN ('active', 'closing_soon') THEN
    RAISE EXCEPTION 'Este pedido no admite prórroga';
  END IF;

  IF v_order.dismantle_at IS NULL OR now() < v_order.dismantle_at THEN
    RAISE EXCEPTION 'El pedido aún no venció';
  END IF;

  v_notes_obj := '{}'::jsonb;
  IF v_order.notes IS NOT NULL AND trim(v_order.notes) <> '' THEN
    BEGIN
      v_notes_obj := v_order.notes::jsonb;
      IF jsonb_typeof(v_notes_obj) <> 'object' THEN
        RAISE EXCEPTION 'Estado del pedido inválido (notes)';
      END IF;
    EXCEPTION
      WHEN others THEN
        RAISE EXCEPTION 'Estado del pedido inválido (notes)';
    END;
  END IF;

  v_customer_uses := COALESCE((v_notes_obj->>'customer_enable_24h_uses')::int, 0);
  IF v_customer_uses >= 1 THEN
    RAISE EXCEPTION 'Ya usaste la prórroga de 24 horas para este pedido';
  END IF;

  v_new_dismantle := public.fn_compute_order_deadline(now(), 1);

  UPDATE public.orders
  SET
    dismantle_at = v_new_dismantle,
    notes = (v_notes_obj || jsonb_build_object('customer_enable_24h_uses', 1))::text,
    status = CASE
      WHEN lower(trim(coalesce(status, ''))) = 'closing_soon' THEN 'active'
      ELSE status
    END,
    updated_at = now()
  WHERE id = p_order_id;

  RETURN json_build_object(
    'ok', true,
    'order_id', p_order_id,
    'dismantle_at', v_new_dismantle
  );
END;
$function$;

SELECT pg_notify('pgrst', 'reload schema');
