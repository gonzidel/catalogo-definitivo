-- 255_pg_cron_orders_maintenance.sql
--
-- Fix critico: rpc_orders_daily_maintenance() (ver 123_order_expiry_and_notifications.sql
-- y 147_order_window_7d.sql) es la funcion que pasa pedidos active -> closing_soon,
-- los expira cuando pasa dismantle_at, devuelve el stock reservado y llena el
-- outbox order_notifications. Hasta ahora SOLO se disparaba desde
-- client/dashboard-instant.js, detras de un flag (window.FYL_ENABLE_ORDERS_MAINTENANCE)
-- que nunca se activa en ningun HTML/JS del repo -> la funcion nunca corre en
-- producción sin intervencion manual.
--
-- Evidencia (fyl-core, 2026-08-01): ultima fila en order_notifications es del
-- 2026-04-14 (~3.5 meses sin correr). Pedidos con dismantle_at vencido quedan
-- 'active' para siempre; el stock reservado nunca se libera.
--
-- Esta migracion agrega un disparador de servidor real via pg_cron, que no
-- depende de que ningun cliente visite ningun dashboard.

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Idempotente: si ya existe un job con este nombre (re-ejecucion de esta
-- migracion), lo reemplaza en vez de duplicarlo.
DO $$
BEGIN
  PERFORM cron.unschedule('orders-daily-maintenance');
EXCEPTION
  WHEN OTHERS THEN
    NULL; -- el job no existia todavia, no hay nada que desprogramar
END $$;

-- Cada 15 minutos: los vencimientos son a hora exacta (dismantle_at guarda
-- hora, no solo fecha), asi que una corrida "diaria" real haria que un
-- pedido quede vencido varias horas antes de expirar de verdad.
SELECT cron.schedule(
  'orders-daily-maintenance',
  '*/15 * * * *',
  $$SELECT public.rpc_orders_daily_maintenance();$$
);

-- Verificacion post-deploy (ejecutar manualmente):
-- SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname = 'orders-daily-maintenance';
-- SELECT * FROM cron.job_run_details WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'orders-daily-maintenance') ORDER BY start_time DESC LIMIT 5;
