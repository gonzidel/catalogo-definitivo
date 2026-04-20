-- 178_order_items_admin_confirmed_missing.sql
--
-- Diferencia semántica para order_items.status='missing':
-- - missing real (sin stock confirmado por sistema)
-- - missing manual confirmado por admin (excepción operativa)
--
-- Este flag NO cambia la lógica de stock ni reserved_qty.

alter table public.order_items
  add column if not exists admin_confirmed_missing boolean not null default false;

comment on column public.order_items.admin_confirmed_missing is
  'true = item missing agregado manualmente por admin sin stock confirmado; false = missing real por faltante.';

-- Backfill mínimo para pedidos creados desde admin:
-- cuando un item quedó en missing y el pedido es source=admin, se considera missing manual.
update public.order_items oi
set admin_confirmed_missing = true
from public.orders o
where o.id = oi.order_id
  and coalesce(oi.status, '') = 'missing'
  and coalesce(oi.admin_confirmed_missing, false) = false
  and coalesce(o.source, '') = 'admin';

select pg_notify('pgrst', 'reload schema');
