-- Marca ítem como waiting y fija depósito (general = fábrica, venta-publico = local).
-- Usado desde nj/admin/orders al elegir espera por origen.

drop function if exists public.rpc_mark_order_item_waiting_source(uuid, text, uuid);

create or replace function public.rpc_mark_order_item_waiting_source(
  p_item_id uuid,
  p_source_code text,
  p_checked_by uuid
)
returns json
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_row public.order_items%rowtype;
  v_order_id uuid;
  v_warehouse_id uuid;
  v_all_picked boolean;
begin
  if not exists (select 1 from public.admins where user_id = auth.uid()) then
    raise exception 'Solo administradores pueden marcar ítems en espera';
  end if;

  if p_source_code not in ('general', 'venta-publico') then
    raise exception 'Código de depósito inválido: %', p_source_code;
  end if;

  select id into v_warehouse_id
  from public.warehouses
  where code = p_source_code
  limit 1;

  if v_warehouse_id is null then
    raise exception 'Depósito no encontrado: %', p_source_code;
  end if;

  select * into v_row from public.order_items where id = p_item_id;
  if not found then
    raise exception 'Ítem no encontrado';
  end if;

  v_order_id := v_row.order_id;

  update public.order_items
     set status = 'waiting',
         checked_by = p_checked_by,
         checked_at = now()
   where id = p_item_id;

  delete from public.order_item_stock_sources
  where order_item_id = p_item_id;

  if coalesce(v_row.quantity, 0) > 0 then
    insert into public.order_item_stock_sources (order_item_id, warehouse_id, qty)
    values (p_item_id, v_warehouse_id, v_row.quantity);
  end if;

  select public.has_all_items_picked(v_order_id) into v_all_picked;

  return json_build_object(
    'order_id', v_order_id,
    'all_items_picked', v_all_picked,
    'source_code', p_source_code
  );
end;
$$;

comment on function public.rpc_mark_order_item_waiting_source(uuid, text, uuid) is
  'Admin: marca order_item como waiting y asigna depósito general (fábrica) o venta-publico (local).';

revoke all on function public.rpc_mark_order_item_waiting_source(uuid, text, uuid) from public;
grant execute on function public.rpc_mark_order_item_waiting_source(uuid, text, uuid) to authenticated;
