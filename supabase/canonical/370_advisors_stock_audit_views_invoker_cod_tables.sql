-- 370_advisors_stock_audit_views_invoker_cod_tables.sql
--
-- YA APLICADA EN PRODUCCION (fyl-core, 2026-10-08) via MCP apply_migration
-- con nombre `advisor_fix_stock_audit_views_and_cod_tables`. Este archivo es el
-- registro versionado; es idempotente y se puede re-ejecutar.
--
-- Origen: Security Advisor de Supabase (lints 0010 security_definer_view y
-- 0013 rls_disabled_in_public). Auditoria completa en
-- docs/FYL-Obsidian/73-SUPABASE-ADVISORS-SECURITY-DEFINER-RLS-2026-10-08.md
--
-- 1) vw_stock_audit_untracked_sales / vw_stock_audit_untracked_sales_watchlist
--    (341/343). Corrian como owner (postgres, sin RLS) y `anon` tenia SELECT por
--    default privileges: cualquier visitante leia 8.538 eventos de auditoria y
--    565 filas de watchlist con 170 emails de admins (join a public.admins).
--    Cualquier cliente logueado veia lo mismo.
--    Fix: revocar anon, dejar solo SELECT a authenticated y security_invoker.
--    Con invoker el admin ve exactamente lo mismo (hash identico verificado) por
--    las policies *_admin_all / *_admin_manage; un cliente no admin ve 0 filas.
--
-- 2) _cod_fase5_test_log, _cod_286_sql_chunks, _cod_286_b64_parts: restos de
--    pruebas COD del 2026-08-21, sin RLS y con ALL para anon/authenticated.
--    Sin referencias en codigo, vistas ni funciones. Se bloquean (no se borran).
--
-- IMPORTANTE: si una migracion futura recrea estas vistas (CREATE OR REPLACE /
-- DROP + CREATE como en 341/343), debe incluir WITH (security_invoker = true) y
-- no otorgar nada a anon; de lo contrario vuelve la exposicion.
--
-- NO incluido a proposito: catalog_public_available_view queda como
-- security definer (excepcion documentada en la nota 73).
--
-- Riesgo: BAJO. Rollback: 370_ROLLBACK_advisors_stock_audit_views_invoker_cod_tables.sql

BEGIN;

REVOKE ALL ON public.vw_stock_audit_untracked_sales,
              public.vw_stock_audit_untracked_sales_watchlist FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.vw_stock_audit_untracked_sales,
     public.vw_stock_audit_untracked_sales_watchlist FROM authenticated;
ALTER VIEW public.vw_stock_audit_untracked_sales SET (security_invoker = true);
ALTER VIEW public.vw_stock_audit_untracked_sales_watchlist SET (security_invoker = true);

ALTER TABLE public._cod_fase5_test_log  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public._cod_286_sql_chunks  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public._cod_286_b64_parts   ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public._cod_fase5_test_log, public._cod_286_sql_chunks,
              public._cod_286_b64_parts FROM anon, authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- Verificacion post-cambio (read-only):
--
-- select c.relname, c.reloptions, c.relrowsecurity,
--        has_table_privilege('anon', c.oid, 'SELECT') as anon_sel,
--        has_table_privilege('authenticated', c.oid, 'SELECT') as auth_sel
-- from pg_class c join pg_namespace n on n.oid = c.relnamespace
-- where n.nspname = 'public'
--   and c.relname in ('vw_stock_audit_untracked_sales',
--                     'vw_stock_audit_untracked_sales_watchlist',
--                     '_cod_fase5_test_log', '_cod_286_sql_chunks', '_cod_286_b64_parts');
--
-- Esperado: vistas con {security_invoker=true}, anon_sel=false, auth_sel=true;
-- tablas _cod_* con relrowsecurity=true, anon_sel=false, auth_sel=false.
