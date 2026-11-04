-- 378_ROLLBACK_size_charts.sql
--
-- Revierte 378_size_charts.sql por completo. PIERDE las tablas de talles y
-- las asignaciones products.size_chart_id: es el último recurso. Si el
-- problema es solo de interfaz, revertir el frontend y dejar la base inerte.
--
-- Antes de ejecutar, exportar (solo lectura) y guardar fuera de la base:
--   SELECT to_jsonb(c) FROM public.size_charts c;
--   SELECT to_jsonb(r) FROM public.size_chart_rows r;
--   SELECT id, size_chart_id FROM public.products WHERE size_chart_id IS NOT NULL;
--
-- No afecta stock, variantes, talles comerciales, pedidos ni catálogo público.

BEGIN;

SET LOCAL lock_timeout = '5s';

DROP TRIGGER IF EXISTS trg_products_size_chart_guard ON public.products;
DROP FUNCTION IF EXISTS public.fn_products_size_chart_guard();

DROP FUNCTION IF EXISTS public.rpc_admin_delete_size_chart(uuid, integer);
DROP FUNCTION IF EXISTS public.rpc_admin_set_size_chart_archived(uuid, integer, boolean);
DROP FUNCTION IF EXISTS public.rpc_admin_save_size_chart(uuid, integer, text, text, text, jsonb);
DROP FUNCTION IF EXISTS public.rpc_admin_get_size_chart(uuid);
DROP FUNCTION IF EXISTS public.rpc_admin_size_charts_overview();
DROP FUNCTION IF EXISTS public.fn_size_chart_assert_permission(text);

DROP INDEX IF EXISTS public.ix_products_size_chart_id;
ALTER TABLE public.products DROP CONSTRAINT IF EXISTS products_size_chart_id_fkey;
ALTER TABLE public.products DROP COLUMN IF EXISTS size_chart_id;

DROP TABLE IF EXISTS public.size_chart_rows;
DROP TABLE IF EXISTS public.size_charts;

SELECT pg_notify('pgrst', 'reload schema');

COMMIT;
