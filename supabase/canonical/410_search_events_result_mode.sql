-- 410_search_events_result_mode.sql
-- Columna opcional para medir cascade (exact|relaxed|suggest|empty).
-- REQUIERE aprobación explícita antes de aplicar en producción.
-- Rollback: 410_ROLLBACK_search_events_result_mode.sql

alter table public.search_events
  add column if not exists result_mode text null;

comment on column public.search_events.result_mode is
  'Modo de resultado del buscador v2: exact | relaxed | suggest | empty';

select pg_notify('pgrst', 'reload schema');
