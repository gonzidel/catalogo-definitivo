-- 370_ROLLBACK_advisors_stock_audit_views_invoker_cod_tables.sql
--
-- Revierte 370. Reabre la exposicion detectada por el Security Advisor:
-- usar solo si admin/stock-audit.html deja de funcionar y no hay otra salida.
-- No se restaura SELECT para anon en las vistas (era una fuga, no un contrato).

BEGIN;

ALTER VIEW public.vw_stock_audit_untracked_sales RESET (security_invoker);
ALTER VIEW public.vw_stock_audit_untracked_sales_watchlist RESET (security_invoker);
GRANT SELECT ON public.vw_stock_audit_untracked_sales TO authenticated;
GRANT SELECT ON public.vw_stock_audit_untracked_sales_watchlist TO authenticated;

ALTER TABLE public._cod_fase5_test_log  DISABLE ROW LEVEL SECURITY;
ALTER TABLE public._cod_286_sql_chunks  DISABLE ROW LEVEL SECURITY;
ALTER TABLE public._cod_286_b64_parts   DISABLE ROW LEVEL SECURITY;

COMMIT;

NOTIFY pgrst, 'reload schema';
