-- 349_ROLLBACK_close_stuck_customer_requested_orders.sql
-- Quitar sweep + restaurar cron solo a daily_maintenance.

DROP FUNCTION IF EXISTS public.rpc_close_stuck_customer_requested_orders();

-- Si el cron fue actualizado a llamar ambas, volver a solo maintenance:
-- SELECT cron.alter_job(
--   <jobid>,
--   command := 'SELECT public.rpc_orders_daily_maintenance();'
-- );
