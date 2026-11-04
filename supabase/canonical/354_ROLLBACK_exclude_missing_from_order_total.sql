-- 354_ROLLBACK_exclude_missing_from_order_total.sql
-- Revierte 354. Restaura mark_item_missing / close_order previos a 354.
-- rpc_close_order vuelve a la versión 351 (pago por transporte, sin strip missing).

DROP TRIGGER IF EXISTS trg_orders_total_exclude_missing ON public.orders;
DROP FUNCTION IF EXISTS public.trg_orders_total_exclude_missing();
DROP FUNCTION IF EXISTS public.fn_orders_exclude_missing_from_total(uuid);

-- Restaurar rpc_admin_mark_item_missing (pre-354, change_type writeoff_missing)
CREATE OR REPLACE FUNCTION public.rpc_admin_mark_item_missing(p_item_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_uid uuid;
  v_item public.order_items%rowtype;
  v_product_id uuid;
  v_size_norm text;
  v_src record;
  v_row record;
  v_before int;
  v_qty_released int := 0;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = v_uid) THEN
    RAISE EXCEPTION 'Solo administradores pueden marcar un producto sin stock';
  END IF;

  SELECT * INTO v_item FROM public.order_items WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ítem no encontrado';
  END IF;

  IF lower(trim(coalesce(v_item.status, ''))) = 'cancelled' THEN
    RAISE EXCEPTION 'Este ítem ya está cancelado';
  END IF;

  IF v_item.variant_id IS NOT NULL THEN
    SELECT pv.product_id INTO v_product_id FROM public.product_variants pv WHERE pv.id = v_item.variant_id;
  END IF;

  v_size_norm := trim(coalesce(v_item.size::text, ''));
  IF v_size_norm = '' THEN
    v_size_norm := NULL;
  ELSIF v_size_norm ~ '^\d+(\.\d+)?$' THEN
    v_size_norm := split_part(v_size_norm, '.', 1);
  END IF;

  FOR v_src IN
    SELECT warehouse_id, greatest(coalesce(qty, 0), 0) AS qty
    FROM public.order_item_stock_sources
    WHERE order_item_id = p_item_id
  LOOP
    IF coalesce(v_src.qty, 0) <= 0 THEN
      CONTINUE;
    END IF;

    v_before := 0;
    IF v_item.variant_id IS NOT NULL THEN
      FOR v_row IN
        SELECT vsws.size, vsws.stock_qty
        FROM public.variant_size_warehouse_stock vsws
        WHERE vsws.variant_id = v_item.variant_id
          AND vsws.warehouse_id = v_src.warehouse_id
      LOOP
        IF trim(coalesce(v_row.size::text, '')) IS NOT DISTINCT FROM v_size_norm THEN
          v_before := coalesce(v_row.stock_qty, 0);
          EXIT;
        END IF;
      END LOOP;
    END IF;

    IF v_product_id IS NOT NULL THEN
      PERFORM public.log_stock_change(
        v_product_id, v_item.variant_id, v_size_norm, v_src.warehouse_id,
        'writeoff_missing', v_before, v_before, NULL, NULL,
        format('rpc_admin_mark_item_missing: reserva dada de baja (sin stock real), order_item=%s', p_item_id)
      );
    END IF;

    v_qty_released := v_qty_released + v_src.qty;
  END LOOP;

  DELETE FROM public.order_item_stock_sources WHERE order_item_id = p_item_id;

  IF v_item.variant_id IS NOT NULL AND v_qty_released > 0 THEN
    UPDATE public.product_variants
    SET reserved_qty = greatest(coalesce(reserved_qty, 0) - v_qty_released, 0)
    WHERE id = v_item.variant_id;
  END IF;

  UPDATE public.order_items
  SET status = 'missing', checked_by = v_uid, checked_at = now(), updated_at = now()
  WHERE id = p_item_id;

  RETURN json_build_object('ok', true, 'item_id', p_item_id, 'qty_written_off', v_qty_released);
END;
$function$;

-- Restaurar rpc_close_order a 351 (sin exclude missing)
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
  'canonical:351 | Cierra pedido sin re-descontar stock. Pago por transporte: COD→Contra Reembolso, resto→Pagado.';

SELECT pg_notify('pgrst', 'reload schema');
