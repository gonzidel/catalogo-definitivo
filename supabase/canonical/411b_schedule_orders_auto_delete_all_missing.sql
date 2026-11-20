-- 411b_schedule_orders_auto_delete_all_missing.sql
--
-- Activa el job de cron de 411. Se aplica DESPUÉS de 411 y de verificar con dry-run:
--   SELECT public.rpc_orders_auto_delete_all_missing(20, true);
-- (cantidad de pedidos que borraría; no modifica nada).
--
-- Frecuencia: cada hora al minuto 7 (la regla es de 5 días; no hace falta más seguido
-- y evita carga extra de cron/IO).
--
-- Rollback: 411_ROLLBACK_orders_auto_delete_all_missing_5d.sql
-- NO APLICAR en producción sin aprobación explícita.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'orders-auto-delete-all-missing') THEN
    PERFORM cron.unschedule('orders-auto-delete-all-missing');
  END IF;

  PERFORM cron.schedule(
    'orders-auto-delete-all-missing',
    '7 * * * *',
    'SELECT public.rpc_orders_auto_delete_all_missing(20, false);'
  );
END $$;
