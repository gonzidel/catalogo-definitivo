-- 341_ROLLBACK_stock_audit_untracked_sales_watchlist.sql
-- Revierte 341_stock_audit_untracked_sales_watchlist.sql (solo vistas, sin datos).

DROP VIEW IF EXISTS public.vw_stock_audit_untracked_sales_watchlist;
DROP VIEW IF EXISTS public.vw_stock_audit_untracked_sales;

SELECT pg_notify('pgrst', 'reload schema');
