-- 404 - Purga semanal de cron.job_run_details (APLICADA en fyl-core el 2026-11-04 como job "cron-job-run-details-purge")
--
-- Motivo: alerta de Disk IO de Supabase (2026-11-04). pg_cron inserta y actualiza una fila en
-- cron.job_run_details por cada ejecución (~3.100 por día entre los 10 jobs; meli-publish corre
-- cada minuto). Hoy la tabla tiene ~53.000 filas desde el 01/08 y no hay ningún job que la purgue
-- (verificado en cron.job el 2026-11-04).
--
-- Qué hace: borra el historial de ejecuciones de más de 7 días. No toca cron.job ni los jobs.
-- Qué no toca: datos de negocio, pedidos, stock ni ninguna tabla de public.
-- Efecto colateral: se pierde el historial de ejecuciones viejas, que hoy se consulta solo para
-- diagnóstico (ver comentarios en 255 y 265). Si se quiere conservar más, cambiar el intervalo.
--
-- Antes de aplicar, vista previa (solo lectura):
--   select count(*) filter (where end_time < now() - interval '7 days') as a_borrar, count(*) as total
--   from cron.job_run_details;

select cron.schedule(
  'cron-job-run-details-purge',
  '17 3 * * 0',
  $$delete from cron.job_run_details where end_time < now() - interval '7 days';$$
);

-- Rollback: select cron.unschedule('cron-job-run-details-purge');
