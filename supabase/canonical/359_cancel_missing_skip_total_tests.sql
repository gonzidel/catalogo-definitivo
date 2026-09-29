-- 359_cancel_missing_skip_total_tests.sql
-- Readonly post-apply. No mutates.

-- A) Comentarios canónicos 359
SELECT
  obj_description('public.rpc_cancel_order_item(uuid)'::regprocedure) AS cancel_cmt,
  obj_description('public.rpc_cancel_order_item_units(uuid,integer)'::regprocedure) AS units_cmt,
  obj_description('public.rpc_customer_replace_missing_item(uuid,uuid,text,text,text,text)'::regprocedure) AS replace_cmt;

-- Expect: los tres contienen 'canonical:359'

-- B) Cuerpos: skip total si missing + replace excluye missing
SELECT
  (pg_get_functiondef('public.rpc_cancel_order_item(uuid)'::regprocedure)
    LIKE '%v_item_status is distinct from ''missing''%') AS cancel_skips_missing_total,
  (pg_get_functiondef('public.rpc_cancel_order_item_units(uuid,integer)'::regprocedure)
    LIKE '%v_item_status is distinct from ''missing''%') AS units_skips_missing_total,
  (pg_get_functiondef('public.rpc_customer_replace_missing_item(uuid,uuid,text,text,text,text)'::regprocedure)
    LIKE '%NOT IN (''cancelled'', ''missing'')%') AS replace_excludes_missing,
  -- No reintroducir deferred 312 en units (prod no lo tenía)
  (pg_get_functiondef('public.rpc_cancel_order_item_units(uuid,integer)'::regprocedure)
    LIKE '%deferred_stock_pending%') AS units_has_deferred_unexpected;

-- Expect: true, true, true, false

-- C) Pedidos backfill (tras 359_BACKFILL): delta ~ 0
SELECT
  o.order_number,
  o.total_amount::numeric AS total,
  round(coalesce(sum(oi.quantity * oi.price_snapshot) FILTER (
    WHERE oi.status NOT IN ('cancelled', 'missing')), 0), 2) AS expected,
  round(o.total_amount - coalesce(sum(oi.quantity * oi.price_snapshot) FILTER (
    WHERE oi.status NOT IN ('cancelled', 'missing')), 0), 2) AS delta
FROM orders o
JOIN order_items oi ON oi.order_id = o.id
WHERE o.order_number IN ('A57356', 'A57180', 'A57219', 'A56761')
GROUP BY o.order_number, o.total_amount
ORDER BY o.order_number;

-- Expect post-backfill: delta = 0 en los cuatro
