-- 356_ROLLBACK_order_item_missing_total_trigger.sql
-- Quita trigger 356. Restaura mark (resta manual 354) y remove_missing (resta al borrar).
-- Tras este rollback, re-aplicar 355 si hace falta el cuerpo actual de restore_stock.

DROP TRIGGER IF EXISTS trg_order_item_missing_adjust_total ON public.order_items;
DROP FUNCTION IF EXISTS public.trg_order_item_missing_adjust_total();

-- mark: volver a restar a mano (como 354)
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
  v_prev_status text;
  v_line_total numeric := 0;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = v_uid) THEN
    RAISE EXCEPTION 'Solo administradores pueden marcar un producto sin stock';
  END IF;

  SELECT * INTO v_item FROM public.order_items WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ítem no encontrado'; END IF;

  v_prev_status := lower(trim(coalesce(v_item.status, '')));
  IF v_prev_status = 'cancelled' THEN RAISE EXCEPTION 'Este ítem ya está cancelado'; END IF;

  IF v_item.variant_id IS NOT NULL THEN
    SELECT pv.product_id INTO v_product_id FROM public.product_variants pv WHERE pv.id = v_item.variant_id;
  END IF;

  v_size_norm := trim(coalesce(v_item.size::text, ''));
  IF v_size_norm = '' THEN v_size_norm := NULL;
  ELSIF v_size_norm ~ '^\d+(\.\d+)?$' THEN v_size_norm := split_part(v_size_norm, '.', 1);
  END IF;

  FOR v_src IN
    SELECT warehouse_id, greatest(coalesce(qty, 0), 0) AS qty
    FROM public.order_item_stock_sources WHERE order_item_id = p_item_id
  LOOP
    IF coalesce(v_src.qty, 0) <= 0 THEN CONTINUE; END IF;
    v_before := 0;
    IF v_item.variant_id IS NOT NULL THEN
      FOR v_row IN
        SELECT vsws.size, vsws.stock_qty FROM public.variant_size_warehouse_stock vsws
        WHERE vsws.variant_id = v_item.variant_id AND vsws.warehouse_id = v_src.warehouse_id
      LOOP
        IF trim(coalesce(v_row.size::text, '')) IS NOT DISTINCT FROM v_size_norm THEN
          v_before := coalesce(v_row.stock_qty, 0); EXIT;
        END IF;
      END LOOP;
    END IF;
    IF v_product_id IS NOT NULL THEN
      PERFORM public.log_stock_change(
        v_product_id, v_item.variant_id, v_size_norm, v_src.warehouse_id,
        'sin_stock_baja', v_before, v_before, NULL, NULL,
        format('Marcado sin stock (Kanban): baja de reserva sin reingresar. order_item=%s', p_item_id)
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

  IF v_prev_status IS DISTINCT FROM 'missing' THEN
    v_line_total := coalesce(v_item.quantity, 0)::numeric * coalesce(v_item.price_snapshot, 0);
    IF v_line_total > 0 AND v_item.order_id IS NOT NULL THEN
      UPDATE public.orders
      SET total_amount = greatest(coalesce(total_amount, 0) - v_line_total, 0), updated_at = now()
      WHERE id = v_item.order_id;
    END IF;
  END IF;

  RETURN json_build_object(
    'ok', true, 'item_id', p_item_id,
    'qty_written_off', v_qty_released, 'total_reduced_by', coalesce(v_line_total, 0)
  );
END;
$function$;

COMMENT ON FUNCTION public.rpc_admin_mark_item_missing(uuid) IS
  'canonical:354 | Marca ítem sin stock (writeoff reserva) y resta su línea de orders.total_amount.';

-- remove_missing: volver a restar al borrar (pre-356 / 136)
CREATE OR REPLACE FUNCTION public.rpc_remove_missing_order_item(p_item_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_order_id uuid;
  v_customer_id uuid;
  v_status text;
  v_qty int;
  v_price numeric;
  v_item_total numeric;
BEGIN
  SELECT oi.order_id, o.customer_id, oi.status,
         coalesce(oi.quantity, 0)::int, coalesce(oi.price_snapshot, 0)
  INTO v_order_id, v_customer_id, v_status, v_qty, v_price
  FROM public.order_items oi
  JOIN public.orders o ON o.id = oi.order_id
  WHERE oi.id = p_item_id;

  IF v_order_id IS NULL THEN RAISE EXCEPTION 'Item no encontrado'; END IF;
  IF lower(trim(coalesce(v_status, ''))) <> 'missing' THEN
    RAISE EXCEPTION 'Solo se puede quitar así un producto sin stock (faltante)';
  END IF;
  IF v_customer_id IS DISTINCT FROM auth.uid() THEN
    IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()) THEN
      RAISE EXCEPTION 'No tienes permiso para quitar este producto';
    END IF;
  END IF;

  v_item_total := v_price * v_qty;
  DELETE FROM public.order_items WHERE id = p_item_id;
  UPDATE public.orders
  SET total_amount = greatest(coalesce(total_amount, 0) - v_item_total, 0), updated_at = now()
  WHERE id = v_order_id;

  RETURN json_build_object('removed', true, 'order_id', v_order_id);
END;
$function$;

COMMENT ON FUNCTION public.rpc_remove_missing_order_item(uuid) IS
  'Elimina un order_item en estado missing y ajusta total_amount del pedido (SECURITY DEFINER; uso desde app cliente).';

GRANT EXECUTE ON FUNCTION public.rpc_remove_missing_order_item(uuid) TO authenticated;

-- restore_stock: re-aplicar 355_stock_history_readable_labels.sql completo tras este rollback.

SELECT pg_notify('pgrst', 'reload schema');
