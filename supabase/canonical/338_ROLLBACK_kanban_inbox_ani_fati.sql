-- 338_ROLLBACK_kanban_inbox_ani_fati.sql
-- Revierte canonical/338_kanban_inbox_ani_fati.sql

DROP TRIGGER IF EXISTS trg_orders_assign_kanban_inbox ON public.orders;
DROP FUNCTION IF EXISTS public.fn_orders_assign_kanban_inbox();

DROP TRIGGER IF EXISTS trg_customers_protect_kanban_inbox ON public.customers;
DROP FUNCTION IF EXISTS public.fn_customers_protect_kanban_inbox();

DROP FUNCTION IF EXISTS public.rpc_set_kanban_inbox_owner(uuid, text);
DROP FUNCTION IF EXISTS public.fn_order_is_shipping_kanban_inbox(public.orders);

DROP POLICY IF EXISTS kanban_inbox_rr_admin_all ON public.kanban_inbox_rr;
DROP TABLE IF EXISTS public.kanban_inbox_rr;

DROP INDEX IF EXISTS public.idx_customers_kanban_inbox_owner;

ALTER TABLE public.customers
  DROP CONSTRAINT IF EXISTS customers_kanban_inbox_owner_chk;

ALTER TABLE public.customers
  DROP COLUMN IF EXISTS kanban_inbox_owner,
  DROP COLUMN IF EXISTS kanban_inbox_assigned_at;
