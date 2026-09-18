-- 344_ROLLBACK_cleanup_missing_sources_on_cancel.sql
--
-- Revierte solamente el guard preventivo de la migracion 344.
-- No recrea fuentes que 344 ya haya descartado: esas fuentes representaban
-- items missing sin existencia fisica y restaurarlas reintroduciria el riesgo
-- de stock fantasma.
-- cancelled_from_status queda como columna nullable e inerte para no perder
-- trazabilidad ya escrita; no afecta ningun flujo sin los triggers.

DROP TRIGGER IF EXISTS order_items_before_missing_cancel_cleanup
  ON public.order_items;

DROP FUNCTION IF EXISTS public.trg_cleanup_missing_sources_on_cancel();
DROP FUNCTION IF EXISTS public.cleanup_missing_order_item_sources(uuid, text);

CREATE OR REPLACE FUNCTION public.order_has_cancelled_items_pending_stock_return(
  p_order_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.order_items oi
    JOIN public.order_item_stock_sources s ON s.order_item_id = oi.id
    WHERE oi.order_id = p_order_id
      AND lower(trim(coalesce(oi.status, ''))) = 'cancelled'
      AND greatest(coalesce(s.qty, 0), 0) > 0
  );
$$;

COMMENT ON FUNCTION public.order_has_cancelled_items_pending_stock_return(uuid) IS
  '340: true si el pedido tiene items cancelled con order_item_stock_sources qty > 0.';

SELECT pg_notify('pgrst', 'reload schema');
