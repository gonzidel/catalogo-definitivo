-- 335_rpc_checkout_cart_effective_price_tests.sql
-- Source + read-only assertions. No muta stock ni pedidos.

-- A) Fingerprints (live post-335)
-- checkout_md5 esperado: 1498a355d635d6bbd902f0b5086257c7
-- wrapper_md5 esperado:  2bd85c8f59a82692e6cd92293f561459
SELECT
  md5(pg_get_functiondef('public.rpc_checkout_cart()'::regprocedure)) AS checkout_md5,
  md5(pg_get_functiondef('public.rpc_checkout_cart(uuid, jsonb)'::regprocedure)) AS wrapper_md5,
  obj_description('public.rpc_checkout_cart()'::regprocedure, 'pg_proc') AS domain_comment,
  md5(pg_get_functiondef('public.rpc_checkout_cart()'::regprocedure))
    = '1498a355d635d6bbd902f0b5086257c7' AS checkout_md5_ok;

-- B) Dominio: autoridad de precio + stock/309 intactos
SELECT
  (p.prosrc ~ 'get_effective_price\(r\.variant_id\)') AS uses_effective_price,
  ((length(p.prosrc) - length(replace(p.prosrc, 'get_effective_price(r.variant_id)', '')))
    / length('get_effective_price(r.variant_id)')) = 2 AS effective_price_twice,
  (p.prosrc !~ 'NULLIF\(r\.price_snapshot, 0\)') AS dropped_snapshot_authority,
  (p.prosrc ~ 'Precio inválido') AS aborts_invalid_price,
  (p.prosrc ~ 'awaiting_apartado') AS keeps_309,
  (p.prosrc ~ 'fn_order_item_physical_stock_available') AS keeps_309_physical,
  (p.prosrc ~ 'SET reserved_qty = greatest\(reserved_qty - v_qty, 0\)') AS keeps_reserved_write,
  (p.prosrc ~ 'FOR UPDATE') AS keeps_locks,
  (p.prosrc ~ 'order_item_stock_sources') AS keeps_oiss,
  (p.prosrc ~ 'get_active_promotions_for_variants') AS keeps_promos,
  (obj_description(p.oid, 'pg_proc') LIKE 'canonical:335%') AS comment_335
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'rpc_checkout_cart'
  AND pg_get_function_identity_arguments(p.oid) = '';

-- C) Wrapper intacto (replay/idempotencia)
SELECT
  md5(pg_get_functiondef('public.rpc_checkout_cart(uuid, jsonb)'::regprocedure))
    = '2bd85c8f59a82692e6cd92293f561459' AS wrapper_unchanged;

-- D) get_effective_price semántica (8000 + 51030)
SELECT
  p.handle,
  pv.color,
  pv.price::numeric AS list_price,
  public.get_effective_price(pv.id) AS effective
FROM public.products p
JOIN public.product_variants pv ON pv.product_id = p.id
WHERE p.handle IN ('8000', '51030')
  AND pv.color IN ('Negro', 'suela', 'Suela')
ORDER BY p.handle, pv.color;

-- E) Snapshot duplicado de 8000 suela no cambia get_effective_price
SELECT
  count(*) AS snapshot_suela_rows,
  count(DISTINCT variant_id) AS distinct_variant_ids,
  public.get_effective_price('4bd582fd-f391-44b5-b037-dce1cb31ba15') AS effective_suela
FROM public.catalog_public_snapshot
WHERE "Articulo" = '8000' AND "Color" = 'suela';
