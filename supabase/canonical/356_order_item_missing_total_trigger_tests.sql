-- 356_order_item_missing_total_trigger_tests.sql
-- Readonly post-apply.

SELECT
  to_regprocedure('public.trg_order_item_missing_adjust_total()') IS NOT NULL AS trg_fn_ok,
  (SELECT tgname FROM pg_trigger
    WHERE tgrelid = 'public.order_items'::regclass
      AND tgname = 'trg_order_item_missing_adjust_total') AS trg_name,
  (SELECT obj_description('public.rpc_admin_mark_item_missing(uuid)'::regprocedure)) AS mark_cmt,
  (SELECT obj_description('public.rpc_remove_missing_order_item(uuid)'::regprocedure)) AS remove_cmt;

-- Expect: trg_fn_ok true, trg_name presente, comments canonical:356
