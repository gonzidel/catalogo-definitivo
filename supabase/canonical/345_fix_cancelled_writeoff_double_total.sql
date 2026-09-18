-- 345_fix_cancelled_writeoff_double_total.sql
--
-- BUG REAL (2026-09-16, A57074): rpc_cancel_order_item ya descuenta la linea
-- de orders.total_amount cuando la clienta cancela. Luego
-- rpc_admin_remove_cancelled_item_writeoff volvia a restar la misma linea al
-- confirmar "sin devolver stock". A57074 paso correctamente de 59000 a 50500
-- al cancelar GLE ($8500), y despues incorrectamente a 42000 al confirmar.
--
-- Fix:
--   - eliminar la fila cancelada y sus fuentes sin volver a tocar el total;
--   - si 344 prueba que venia de missing, no restar reserved_qty otra vez;
--   - para picked/manual, liberar por la suma real de fuentes, no por quantity.
--
-- Riesgo: bajo. La RPC solo acepta items ya cancelled y usuarios admin.

CREATE OR REPLACE FUNCTION public.rpc_admin_remove_cancelled_item_writeoff(
  p_order_item_id uuid
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_uid uuid;
  v_item public.order_items%rowtype;
  v_order_id uuid;
  v_product_id uuid;
  v_size_norm text;
  v_src record;
  v_before int;
  v_source_qty int := 0;
  v_order_deleted boolean := false;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = v_uid) THEN
    RAISE EXCEPTION 'Solo administradores pueden confirmar sin devolver stock';
  END IF;

  SELECT *
  INTO v_item
  FROM public.order_items
  WHERE id = p_order_item_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ítem no encontrado';
  END IF;

  IF lower(trim(coalesce(v_item.status, ''))) <> 'cancelled' THEN
    RAISE EXCEPTION 'Este ítem no está cancelado';
  END IF;

  v_order_id := v_item.order_id;
  IF NOT EXISTS (SELECT 1 FROM public.orders WHERE id = v_order_id) THEN
    RAISE EXCEPTION 'Pedido no encontrado';
  END IF;

  IF v_item.variant_id IS NOT NULL THEN
    SELECT pv.product_id
    INTO v_product_id
    FROM public.product_variants pv
    WHERE pv.id = v_item.variant_id
    FOR UPDATE;
  END IF;

  v_size_norm := trim(coalesce(v_item.size::text, ''));
  IF v_size_norm = '' THEN
    v_size_norm := NULL;
  ELSIF v_size_norm ~ '^\d+(\.\d+)?$' THEN
    v_size_norm := split_part(v_size_norm, '.', 1);
  END IF;

  FOR v_src IN
    SELECT
      s.warehouse_id,
      greatest(coalesce(s.qty, 0), 0)::int AS qty
    FROM public.order_item_stock_sources s
    WHERE s.order_item_id = p_order_item_id
    ORDER BY s.id
    FOR UPDATE
  LOOP
    IF v_src.qty <= 0 THEN
      CONTINUE;
    END IF;

    v_before := 0;
    IF v_item.variant_id IS NOT NULL AND v_size_norm IS NOT NULL THEN
      SELECT coalesce(vsws.stock_qty, 0)
      INTO v_before
      FROM public.variant_size_warehouse_stock vsws
      WHERE vsws.variant_id = v_item.variant_id
        AND vsws.warehouse_id = v_src.warehouse_id
        AND trim(coalesce(vsws.size::text, '')) = trim(coalesce(v_item.size::text, ''))
      LIMIT 1;
    ELSIF v_item.variant_id IS NOT NULL THEN
      SELECT coalesce(vws.stock_qty, 0)
      INTO v_before
      FROM public.variant_warehouse_stock vws
      WHERE vws.variant_id = v_item.variant_id
        AND vws.warehouse_id = v_src.warehouse_id
      LIMIT 1;
    END IF;

    v_before := coalesce(v_before, 0);

    INSERT INTO public.stock_history (
      product_id,
      variant_id,
      size,
      warehouse_id,
      change_type,
      stock_before,
      stock_after,
      quantity_changed,
      user_id,
      notes
    )
    VALUES (
      v_product_id,
      v_item.variant_id,
      v_size_norm,
      v_src.warehouse_id,
      'writeoff_missing',
      v_before,
      v_before,
      0,
      v_uid,
      format(
        'rpc_admin_remove_cancelled_item_writeoff 345: sin devolver stock, order_item=%s qty=%s',
        p_order_item_id,
        v_src.qty
      )
    );

    v_source_qty := v_source_qty + v_src.qty;
  END LOOP;

  DELETE FROM public.order_item_stock_sources
  WHERE order_item_id = p_order_item_id;

  IF v_item.variant_id IS NOT NULL
     AND v_source_qty > 0
     AND lower(trim(coalesce(v_item.cancelled_from_status, ''))) <> 'missing'
  THEN
    UPDATE public.product_variants
    SET reserved_qty = greatest(coalesce(reserved_qty, 0) - v_source_qty, 0)
    WHERE id = v_item.variant_id;
  END IF;

  DELETE FROM public.order_items
  WHERE id = p_order_item_id;

  -- total_amount NO se modifica: rpc_cancel_order_item / _units ya descontó
  -- la porción cancelada en el momento de la cancelación.
  UPDATE public.orders
  SET updated_at = now()
  WHERE id = v_order_id;

  IF public.order_eligible_for_empty_deletion(v_order_id) THEN
    SELECT coalesce(
      public.maint_try_delete_order_if_eligible(
        v_order_id,
        'rpc_admin_remove_cancelled_item_writeoff'
      ),
      false
    )
    INTO v_order_deleted;
  END IF;

  RETURN json_build_object(
    'ok', true,
    'order_id', v_order_id,
    'order_deleted', v_order_deleted
  );
END;
$$;

COMMENT ON FUNCTION public.rpc_admin_remove_cancelled_item_writeoff(uuid) IS
  '345: elimina cancelled sin devolver stock y sin descontar total_amount por segunda vez; usa cancelled_from_status para no liberar dos veces reserved_qty.';

REVOKE ALL ON FUNCTION public.rpc_admin_remove_cancelled_item_writeoff(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_admin_remove_cancelled_item_writeoff(uuid)
  TO authenticated, service_role;

SELECT pg_notify('pgrst', 'reload schema');
