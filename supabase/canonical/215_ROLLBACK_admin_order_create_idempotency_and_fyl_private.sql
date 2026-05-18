-- 215_ROLLBACK_admin_order_create_idempotency_and_fyl_private.sql
-- Emergencia / staging: revertir 215 (orden inverso).
--
-- ATENCIÓN: elimina filas de dedupe. Solo ejecutar en staging o con backup.

drop table if exists public.admin_order_create_idempotency cascade;

-- No eliminar schema fyl_private si ya hay otras funciones; descomentar si 215 fue lo único:
-- drop schema if exists fyl_private cascade;

select pg_notify('pgrst', 'reload schema');
