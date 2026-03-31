-- Quitar ítem "missing" (sin stock) del pedido desde el cliente.
-- El dashboard hacía DELETE directo sobre order_items, pero RLS solo permite SELECT al cliente
-- (ver order_items_self_select en 10_checkout_flow.sql), por eso no se eliminaba nada.

create or replace function public.rpc_remove_missing_order_item(p_item_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id uuid;
  v_customer_id uuid;
  v_status text;
  v_qty int;
  v_price numeric;
  v_item_total numeric;
begin
  select
    oi.order_id,
    o.customer_id,
    oi.status,
    coalesce(oi.quantity, 0)::int,
    coalesce(oi.price_snapshot, 0)
  into v_order_id, v_customer_id, v_status, v_qty, v_price
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  where oi.id = p_item_id;

  if v_order_id is null then
    raise exception 'Item no encontrado';
  end if;

  if lower(trim(coalesce(v_status, ''))) <> 'missing' then
    raise exception 'Solo se puede quitar así un producto sin stock (faltante)';
  end if;

  if v_customer_id is distinct from auth.uid() then
    if not exists (select 1 from public.admins where user_id = auth.uid()) then
      raise exception 'No tienes permiso para quitar este producto';
    end if;
  end if;

  v_item_total := v_price * v_qty;

  delete from public.order_items where id = p_item_id;

  update public.orders
  set
    total_amount = greatest(coalesce(total_amount, 0) - v_item_total, 0),
    updated_at = now()
  where id = v_order_id;

  return json_build_object('removed', true, 'order_id', v_order_id);
end;
$$;

comment on function public.rpc_remove_missing_order_item(uuid) is
  'Elimina un order_item en estado missing y ajusta total_amount del pedido (SECURITY DEFINER; uso desde app cliente).';

grant execute on function public.rpc_remove_missing_order_item(uuid) to authenticated;

-- Por si en el proyecto nunca se otorgó explícitamente:
grant execute on function public.rpc_cancel_order_item(uuid) to authenticated;

select pg_notify('pgrst', 'reload schema');
