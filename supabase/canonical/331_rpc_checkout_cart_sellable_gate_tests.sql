-- 331_rpc_checkout_cart_sellable_gate_tests.sql
-- Read-only + source assertions. No INSERT/UPDATE/DELETE de stock ni pedidos.
-- No llama rpc_checkout_cart (evitar pedidos reales).

-- A) Fingerprints
SELECT
  md5(pg_get_functiondef('public.rpc_checkout_cart()'::regprocedure)) AS checkout_md5,
  md5(pg_get_functiondef('public.rpc_checkout_cart(uuid, jsonb)'::regprocedure)) AS wrapper_md5,
  md5(pg_get_functiondef('public.fn_commit_deferred_order_item_stock(uuid)'::regprocedure)) AS commit_309_md5,
  md5(pg_get_functiondef('public.fn_order_item_physical_stock_available(uuid,text,integer)'::regprocedure)) AS physical_309_md5,
  md5(pg_get_functiondef('public.rpc_cancel_order_item(uuid)'::regprocedure)) AS cancel_item_md5,
  md5(pg_get_functiondef('public.rpc_remove_order_item_restore_stock(uuid)'::regprocedure)) AS restore_md5;

-- B) Source: gate viejo ausente; 309 / write reserved / locks presentes
SELECT
  (p.prosrc !~ 'get_total_stock\(r\.variant_id\)') AS dropped_total_stock_gate,
  (p.prosrc !~ 'v_available := coalesce\(v_total_stock') AS dropped_reserved_gate,
  (p.prosrc ~ 'awaiting_apartado') AS keeps_309,
  (p.prosrc ~ 'fn_order_item_physical_stock_available') AS keeps_309_physical,
  (p.prosrc ~ 'SET reserved_qty = greatest\(reserved_qty - v_qty, 0\)') AS keeps_reserved_write,
  (p.prosrc ~ 'FOR UPDATE') AS keeps_locks,
  (p.prosrc ~ 'order_item_stock_sources') AS keeps_oiss,
  (obj_description(p.oid, 'pg_proc') LIKE 'canonical:331%') AS comment_331
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'rpc_checkout_cart'
  AND pg_get_function_identity_arguments(p.oid) = '';

-- C) Wrapper intacto
SELECT
  md5(pg_get_functiondef('public.rpc_checkout_cart(uuid, jsonb)'::regprocedure))
    = '2bd85c8f59a82692e6cd92293f561459' AS wrapper_unchanged;

-- D) Dry-run de decisión (misma semántica que el gate post-lock)
-- sellable = fn_sellable_qty; legacy = get_total_stock - reserved_qty
WITH variants AS (
  SELECT p.handle AS art, pv.id AS variant_id, pv.color, pv.reserved_qty,
         public.get_total_stock(pv.id) AS total_stock
  FROM public.products p
  JOIN public.product_variants pv ON pv.product_id = p.id
  WHERE p.handle IN ('855','12','400','90')
)
SELECT
  v.art,
  v.color,
  s.size,
  s.sellable_qty AS sellable,
  v.reserved_qty,
  greatest(v.total_stock - coalesce(v.reserved_qty,0), 0) AS legacy_available,
  CASE WHEN s.sellable_qty >= 1 THEN 'PASS' ELSE 'FAIL' END AS checkout_qty1,
  CASE WHEN s.sellable_qty >= 2 THEN 'PASS' ELSE 'FAIL' END AS checkout_qty2,
  CASE WHEN greatest(v.total_stock - coalesce(v.reserved_qty,0), 0) >= 1
       THEN 'PASS' ELSE 'FAIL' END AS old_gate_qty1
FROM variants v
JOIN public.fn_sellable_stock_batch(ARRAY(SELECT DISTINCT variant_id FROM variants)) s
  ON s.variant_id = v.variant_id
WHERE (v.art, v.color, s.size) IN (
  ('855','Negro','36'),
  ('400','Chocolate','37'),
  ('90','Negro','38'),
  ('12','Lila','35')
)
ORDER BY v.art, s.size;
