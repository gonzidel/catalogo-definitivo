-- 127_rpc_delete_empty_order.sql
-- Permite al cliente eliminar su pedido cuando ya no tiene productos (todos cancelados).
-- Sin esta RPC, el cliente no puede hacer DELETE en orders por RLS.

create or replace function public.rpc_delete_empty_order(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_customer_id uuid;
  v_non_cancelled_count int;
begin
  select customer_id into v_customer_id
  from public.orders
  where id = p_order_id;

  if v_customer_id is null then
    raise exception 'Pedido no encontrado';
  end if;

  if v_customer_id != auth.uid() then
    if not exists (select 1 from public.admins where user_id = auth.uid()) then
      raise exception 'No tienes permiso para eliminar este pedido';
    end if;
  end if;

  select count(*)::int into v_non_cancelled_count
  from public.order_items
  where order_id = p_order_id
    and coalesce(status, '') != 'cancelled';

  if coalesce(v_non_cancelled_count, 0) > 0 then
    raise exception 'El pedido aún tiene productos. Solo se puede eliminar cuando no queden productos.';
  end if;

  delete from public.orders where id = p_order_id;
end;
$$;

comment on function public.rpc_delete_empty_order(uuid) is
  'Elimina un pedido que ya no tiene productos (solo ítems cancelados). Solo el dueño o admin.';

select pg_notify('pgrst', 'reload schema');
