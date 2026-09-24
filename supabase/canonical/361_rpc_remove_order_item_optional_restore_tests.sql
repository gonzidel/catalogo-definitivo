-- 361_rpc_remove_order_item_optional_restore_tests.sql
-- Readonly post-apply.

SELECT
  to_regprocedure('public.rpc_remove_order_item_restore_stock(uuid, boolean)') IS NOT NULL AS fn_2arg_ok,
  to_regprocedure('public.rpc_remove_order_item_restore_stock(uuid)') IS NULL AS old_1arg_dropped,
  pg_get_function_identity_arguments(
    'public.rpc_remove_order_item_restore_stock(uuid, boolean)'::regprocedure
  ) AS identity_args,
  (SELECT obj_description('public.rpc_remove_order_item_restore_stock(uuid, boolean)'::regprocedure)) AS cmt;

-- Expect: fn_2arg_ok true, old_1arg_dropped true, cmt contains canonical:361
-- Default p_restore_stock=true: callers de 1 arg posicional siguen funcionando.
