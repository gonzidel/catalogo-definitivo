-- 145_sync_variant_warehouse_stock.sql
-- Mantener variant_warehouse_stock.stock_qty sincronizado con la suma de
-- variant_size_warehouse_stock agrupada por (variant_id, warehouse_id).
-- Complemento del trigger 84 (que sincroniza variant_sizes por talle).

CREATE OR REPLACE FUNCTION public.sync_variant_warehouse_stock_from_sizes()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_variant_id uuid;
  v_warehouse_id uuid;
  v_total int;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_variant_id := OLD.variant_id;
    v_warehouse_id := OLD.warehouse_id;
  ELSE
    v_variant_id := NEW.variant_id;
    v_warehouse_id := NEW.warehouse_id;
  END IF;

  SELECT COALESCE(SUM(stock_qty), 0) INTO v_total
  FROM public.variant_size_warehouse_stock
  WHERE variant_id = v_variant_id AND warehouse_id = v_warehouse_id;

  INSERT INTO public.variant_warehouse_stock (variant_id, warehouse_id, stock_qty, updated_at)
  VALUES (v_variant_id, v_warehouse_id, v_total, now())
  ON CONFLICT (variant_id, warehouse_id)
  DO UPDATE SET stock_qty = EXCLUDED.stock_qty, updated_at = now();

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS trigger_sync_variant_warehouse_stock ON public.variant_size_warehouse_stock;
CREATE TRIGGER trigger_sync_variant_warehouse_stock
  AFTER INSERT OR UPDATE OR DELETE ON public.variant_size_warehouse_stock
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_variant_warehouse_stock_from_sizes();

SELECT pg_notify('pgrst', 'reload schema');
