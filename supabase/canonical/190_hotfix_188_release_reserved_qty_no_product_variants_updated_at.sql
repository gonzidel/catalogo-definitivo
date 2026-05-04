-- 190_hotfix_188_release_reserved_qty_no_product_variants_updated_at.sql
--
-- HOTFIX post-deploy 188: product_variants no tiene columna updated_at.
-- La función release_reserved_qty_for_order() no debe referenciarla.
--
-- Seguro de pegar en Supabase SQL Editor: solo reemplaza la función interna;
-- no toca ledger, trigger, stock físico, variant_size_warehouse_stock ni oiss.

CREATE OR REPLACE FUNCTION public.release_reserved_qty_for_order(
  p_order_id   uuid,
  p_old_status text,
  p_new_status text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_inserted int;
  rec record;
BEGIN
  IF p_order_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.order_reserved_qty_released (order_id, old_status, new_status)
  VALUES (p_order_id, p_old_status, p_new_status)
  ON CONFLICT (order_id) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    RETURN;
  END IF;

  FOR rec IN
    SELECT
      oi.variant_id,
      SUM(COALESCE(s.qty, 0))::int AS units
    FROM public.order_items oi
    INNER JOIN public.order_item_stock_sources s ON s.order_item_id = oi.id
    WHERE oi.order_id = p_order_id
      AND oi.variant_id IS NOT NULL
      AND COALESCE(s.qty, 0) > 0
      AND COALESCE(oi.status, '') <> 'cancelled'
    GROUP BY oi.variant_id
    ORDER BY oi.variant_id
  LOOP
    IF rec.units IS NULL OR rec.units <= 0 THEN
      CONTINUE;
    END IF;

    UPDATE public.product_variants pv
    SET
      reserved_qty = GREATEST(COALESCE(pv.reserved_qty, 0) - rec.units, 0)
    WHERE pv.id = rec.variant_id;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.release_reserved_qty_for_order(uuid, text, text) IS
  'Interna: libera reserved_qty por variante según SUM(order_item_stock_sources.qty) del pedido. Idempotente vía order_reserved_qty_released. No modifica almacenes ni oiss. Hotfix 190: sin product_variants.updated_at.';

REVOKE ALL ON FUNCTION public.release_reserved_qty_for_order(uuid, text, text) FROM PUBLIC;

SELECT pg_notify('pgrst', 'reload schema');
