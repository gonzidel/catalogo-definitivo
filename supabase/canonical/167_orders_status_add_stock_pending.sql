-- 167_orders_status_add_stock_pending.sql
--
-- Fase corta de consistencia de órdenes (Etapa 2).
-- Extiende el dominio de public.orders.status para aceptar 'stock_pending'.
--
-- Propósito de 'stock_pending':
-- Marcar una orden cuando la creación/edición persistió la orden y sus items
-- en base, pero el descuento de stock (rpc_apply_order_stock_deduction) falló
-- por una causa recuperable (stock insuficiente, concurrencia, timeout, etc.)
-- y el rollback manual desde el cliente tampoco se pudo concretar.
--
-- Estas órdenes requieren intervención manual del admin:
--   - reintentar el descuento
--   - cancelar la orden
--   - ajustar items para que haya stock
--
-- Compatibilidad:
--   - No se remueve ningún valor previo del dominio → queries existentes que
--     filtran por 'active' / 'closed' / 'sent' / 'devolución' no se ven afectadas.
--   - El frontend admin debe, en un paso posterior, listar stock_pending en el
--     panel para que no queden invisibles. Esta migración solo habilita el valor.
--
-- Ejecución idempotente: si la constraint ya incluye stock_pending, no hace nada.

do $$
declare
  v_constraint_def text;
begin
  select pg_get_constraintdef(c.oid)
  into v_constraint_def
  from pg_constraint c
  join pg_class t      on t.oid = c.conrelid
  join pg_namespace n  on n.oid = t.relnamespace
  where n.nspname = 'public'
    and t.relname = 'orders'
    and c.conname = 'orders_status_check';

  -- Si el constraint no existe o ya incluye stock_pending, no hacer nada.
  if v_constraint_def is null then
    raise notice 'orders_status_check no existe; se omite alter';
    return;
  end if;

  if position('stock_pending' in v_constraint_def) > 0 then
    raise notice 'orders_status_check ya incluye stock_pending; se omite alter';
    return;
  end if;

  alter table public.orders
    drop constraint orders_status_check;

  alter table public.orders
    add constraint orders_status_check
    check (status in (
      'active',
      'closing_soon',
      'closed',
      'sent',
      'expired',
      'devolución',
      'stock_pending'
    ));
end $$;
