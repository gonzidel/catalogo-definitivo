-- 236_ROLLBACK_fix_admin_order_idempotency_order_delete.sql

ALTER TABLE public.admin_order_create_idempotency
  DROP CONSTRAINT IF EXISTS admin_order_create_idempotency_order_id_fkey;

ALTER TABLE public.admin_order_create_idempotency
  ADD CONSTRAINT admin_order_create_idempotency_order_id_fkey
  FOREIGN KEY (order_id) REFERENCES public.orders (id) ON DELETE SET NULL;

SELECT pg_notify('pgrst', 'reload schema');
