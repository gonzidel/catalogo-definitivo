-- 411_ROLLBACK_orders_auto_delete_all_missing_5d.sql
--
-- Desactiva y elimina la regla de auto-borrado a los 5 días (411 / 411b).
-- NO restaura pedidos ya borrados: su rastro queda en order_empty_deletion_audit
-- y stock_history ('writeoff_missing').

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'orders-auto-delete-all-missing') THEN
    PERFORM cron.unschedule('orders-auto-delete-all-missing');
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.rpc_orders_auto_delete_all_missing(integer, boolean);

SELECT pg_notify('pgrst', 'reload schema');
