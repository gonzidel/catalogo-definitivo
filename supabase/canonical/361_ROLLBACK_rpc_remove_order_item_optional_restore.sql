-- 361_ROLLBACK_rpc_remove_order_item_optional_restore.sql
-- Quita la firma (uuid, boolean) y deja explícito que hay que reaplicar 356
-- para restaurar rpc_remove_order_item_restore_stock(uuid).

DROP FUNCTION IF EXISTS public.rpc_remove_order_item_restore_stock(uuid, boolean);

-- Luego ejecutar íntegro:
--   supabase/canonical/356_order_item_missing_total_trigger.sql
-- (recrea rpc_remove_order_item_restore_stock(uuid) + grants/comments de 356).

SELECT pg_notify('pgrst', 'reload schema');
