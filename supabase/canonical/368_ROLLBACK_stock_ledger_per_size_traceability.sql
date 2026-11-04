-- 368_ROLLBACK_stock_ledger_per_size_traceability.sql
--
-- Quita los triggers de trazabilidad. No toca stock ni pedidos.
-- La tabla stock_ledger se conserva por defecto (es evidencia de auditoría);
-- descomentar el DROP TABLE solo si se quiere eliminar también el registro.

BEGIN;

DROP TRIGGER IF EXISTS trg_stock_ledger_size_stock         ON public.variant_size_warehouse_stock;
DROP TRIGGER IF EXISTS trg_stock_ledger_item_source        ON public.order_item_stock_sources;
DROP TRIGGER IF EXISTS trg_stock_ledger_order_item_deleted ON public.order_items;
DROP TRIGGER IF EXISTS trg_stock_ledger_order_deleted      ON public.orders;

DROP FUNCTION IF EXISTS public.trgfn_stock_ledger_size_stock();
DROP FUNCTION IF EXISTS public.trgfn_stock_ledger_item_source();
DROP FUNCTION IF EXISTS public.trgfn_stock_ledger_order_item_deleted();
DROP FUNCTION IF EXISTS public.trgfn_stock_ledger_order_deleted();
DROP FUNCTION IF EXISTS public.fn_stock_ledger_origin();
DROP FUNCTION IF EXISTS public.fn_stock_ledger_api_role();

-- DROP VIEW  IF EXISTS public.vw_stock_ledger_readable;
-- DROP TABLE IF EXISTS public.stock_ledger;

COMMIT;
