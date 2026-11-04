-- 354_exclude_missing_from_order_total_tests.sql
-- Readonly checks post-apply. No mutates.

-- A) Helper + funciones existen
SELECT
  to_regprocedure('public.fn_orders_exclude_missing_from_total(uuid)') IS NOT NULL AS helper_ok,
  to_regprocedure('public.rpc_admin_mark_item_missing(uuid)') IS NOT NULL AS mark_ok,
  to_regprocedure('public.rpc_close_order(uuid,text)') IS NOT NULL AS close_ok,
  to_regprocedure('public.trg_orders_total_exclude_missing()') IS NOT NULL AS trg_fn_ok;

-- B) Trigger activo
SELECT tgname, tgenabled
FROM pg_trigger
WHERE tgrelid = 'public.orders'::regclass
  AND tgname = 'trg_orders_total_exclude_missing';

-- C) A57282 corregido: total = solo picked, RT ya no missing
SELECT
  o.order_number,
  o.total_amount,
  (SELECT coalesce(sum(quantity * price_snapshot), 0)
     FROM order_items oi
    WHERE oi.order_id = o.id AND oi.status = 'picked') AS sum_picked,
  (SELECT count(*) FROM order_items oi WHERE oi.order_id = o.id AND oi.status = 'missing') AS missing_cnt,
  (SELECT status FROM order_items WHERE id = '09cfe942-4413-4e8d-bb4a-b73e147e7902') AS rt_status
FROM orders o
WHERE o.order_number = 'A57282';

-- Expect: total_amount=107800, missing_cnt=0, rt_status=cancelled, total=sum_picked
