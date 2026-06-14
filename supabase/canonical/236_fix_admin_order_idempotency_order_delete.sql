-- 236_fix_admin_order_idempotency_order_delete.sql
--
-- Bug: rpc_cancel_order_full / maint_try_delete_order_if_eligible fallan al desarmar
-- pedidos creados con rpc_create_admin_order_atomic.
--
-- Causa: admin_order_create_idempotency.order_id tiene ON DELETE SET NULL, pero el
-- check admin_order_create_idempotency_success_requires_order exige order_id NOT NULL
-- cuando status = 'success'. Al borrar el pedido → SET NULL → violación 23514.
--
-- Fix: CASCADE — al eliminar el pedido, la fila de idempotencia se elimina también.
-- Esto es correcto: permite reutilizar la misma idempotency_key para un pedido nuevo.
--
-- Rollback: ver 236_ROLLBACK_fix_admin_order_idempotency_order_delete.sql

ALTER TABLE public.admin_order_create_idempotency
  DROP CONSTRAINT IF EXISTS admin_order_create_idempotency_order_id_fkey;

ALTER TABLE public.admin_order_create_idempotency
  ADD CONSTRAINT admin_order_create_idempotency_order_id_fkey
  FOREIGN KEY (order_id) REFERENCES public.orders (id) ON DELETE CASCADE;

COMMENT ON CONSTRAINT admin_order_create_idempotency_order_id_fkey
  ON public.admin_order_create_idempotency IS
  'CASCADE: desarme/borrado de pedido elimina dedupe asociado (evita 23514 con success_requires_order).';

SELECT pg_notify('pgrst', 'reload schema');
