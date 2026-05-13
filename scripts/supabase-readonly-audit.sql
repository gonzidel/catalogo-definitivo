-- scripts/supabase-readonly-audit.sql
--
-- Checks read-only post-deploy para FYL Supabase.
-- Ejecutar en SQL Editor o via herramienta SQL con permisos admin.

-- 1) Tablas public sin RLS
SELECT schemaname, tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
  AND rowsecurity IS DISTINCT FROM true
ORDER BY tablename;

-- 2) Superficie anon fuera de allowlist
WITH allowlist(table_name) AS (
  VALUES
    ('catalog_public_view'),
    ('catalog_public_available_view'),
    ('catalog_public_snapshot'),
    ('products'),
    ('product_variants'),
    ('variant_warehouse_stock'),
    ('variant_size_warehouse_stock')
)
SELECT table_name, privilege_type
FROM information_schema.role_table_grants g
WHERE table_schema = 'public'
  AND grantee = 'anon'
  AND privilege_type = 'SELECT'
  AND NOT EXISTS (SELECT 1 FROM allowlist a WHERE a.table_name = g.table_name)
ORDER BY table_name;

-- 3) RPCs SECURITY DEFINER aun ejecutables por anon
SELECT p.oid::regprocedure AS function_signature
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prosecdef
  AND has_function_privilege('anon', p.oid, 'EXECUTE')
ORDER BY p.oid::regprocedure::text;

-- 4) SECURITY DEFINER sin search_path seguro
SELECT p.oid::regprocedure AS function_signature, p.proconfig
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prosecdef
  AND NOT coalesce(p.proconfig::text, '') ILIKE '%search_path=public%'
ORDER BY p.oid::regprocedure::text;

-- 5) Top sequential scans acumulados
SELECT relname, seq_scan, seq_tup_read, idx_scan, n_live_tup
FROM pg_stat_user_tables
ORDER BY seq_tup_read DESC NULLS LAST
LIMIT 25;

-- 6) Indices creados por hardening y uso observado
SELECT indexrelname, idx_scan, idx_tup_read, idx_tup_fetch
FROM pg_stat_user_indexes
WHERE schemaname = 'public'
  AND indexrelname IN (
    'idx_carts_customer_status_created_at',
    'idx_cart_items_cart_id',
    'idx_cart_items_variant_size_status',
    'idx_orders_customer_status_created_at',
    'idx_orders_status_updated_at',
    'idx_orders_created_at_desc',
    'idx_order_items_order_id',
    'idx_order_items_variant_size',
    'idx_order_item_stock_sources_order_item_id',
    'idx_order_item_stock_sources_warehouse_id',
    'idx_variant_size_wh_stock_variant_size_wh'
  )
ORDER BY indexrelname;

-- 7) Invariantes de stock
SELECT 'variant_size_warehouse_stock_negative' AS check_name, count(*) AS rows
FROM public.variant_size_warehouse_stock
WHERE stock_qty < 0
UNION ALL
SELECT 'variant_warehouse_stock_negative', count(*)
FROM public.variant_warehouse_stock
WHERE stock_qty < 0
UNION ALL
SELECT 'product_variants_reserved_negative', count(*)
FROM public.product_variants
WHERE reserved_qty < 0;

-- 8) Snapshot catalogo vs view viva
SELECT
  (SELECT count(*) FROM public.catalog_public_available_view) AS view_rows,
  (SELECT count(*) FROM public.catalog_public_snapshot) AS snapshot_rows,
  (SELECT refreshed_at FROM public.catalog_public_snapshot_meta WHERE id = true) AS snapshot_refreshed_at;
