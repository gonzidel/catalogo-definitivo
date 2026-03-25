-- 84_sync_variant_sizes_on_warehouse_stock.sql
-- Mantener variant_sizes.stock_qty sincronizado con la suma de variant_size_warehouse_stock
-- cuando cambia el stock por talle (checkout, venta pública, admin stock, etc.).

CREATE OR REPLACE FUNCTION public.sync_variant_sizes_stock_from_warehouse()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_variant_id uuid;
  v_size text;
  v_total int;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_variant_id := OLD.variant_id;
    v_size := OLD.size;
  ELSE
    v_variant_id := NEW.variant_id;
    v_size := NEW.size;
  END IF;

  SELECT COALESCE(SUM(stock_qty), 0) INTO v_total
  FROM public.variant_size_warehouse_stock
  WHERE variant_id = v_variant_id AND size = v_size;

  INSERT INTO public.variant_sizes (variant_id, size, stock_qty, updated_at)
  VALUES (v_variant_id, v_size, v_total, now())
  ON CONFLICT (variant_id, size)
  DO UPDATE SET stock_qty = EXCLUDED.stock_qty, updated_at = now();

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS trigger_sync_variant_sizes_on_warehouse_stock ON public.variant_size_warehouse_stock;
CREATE TRIGGER trigger_sync_variant_sizes_on_warehouse_stock
  AFTER INSERT OR UPDATE OR DELETE ON public.variant_size_warehouse_stock
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_variant_sizes_stock_from_warehouse();

select pg_notify('pgrst', 'reload schema');
