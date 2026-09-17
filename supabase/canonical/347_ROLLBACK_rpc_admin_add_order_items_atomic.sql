-- Rollback de 347_rpc_admin_add_order_items_atomic.sql.
--
-- Afecta únicamente la RPC y su tabla de idempotencia. No revierte pedidos ya
-- editados correctamente por 347: esas mutaciones son datos de negocio válidos.

DROP FUNCTION IF EXISTS public.rpc_admin_add_order_items_atomic(
  uuid,
  jsonb,
  uuid
);

DROP TABLE IF EXISTS public.admin_order_edit_idempotency;

SELECT pg_notify('pgrst', 'reload schema');
