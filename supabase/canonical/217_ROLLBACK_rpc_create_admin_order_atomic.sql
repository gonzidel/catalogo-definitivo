-- Rollback de 217_rpc_create_admin_order_atomic.sql (staging / emergencia).

drop function if exists public.rpc_create_admin_order_atomic(jsonb, uuid);

select pg_notify('pgrst', 'reload schema');
