-- 130_rpc_delete_local_order.sql
-- Elimina un pedido local y devuelve el stock reservado a venta-publico.
-- Importante: si el item tiene talle, devuelve stock en variant_size_warehouse_stock.
-- Si no hay registros por warehouse para ese variant+talle, también actualiza variant_sizes.stock_qty (fallback).

create or replace function public.rpc_delete_local_order(p_local_order_id uuid)
returns json
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_user_id uuid;
  v_warehouse_venta_publico_id uuid;
  v_has_warehouse_rows boolean;
  v_item record;
  v_normalized_size text;
  v_deleted boolean := false;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  if not exists (select 1 from public.admins where user_id = v_user_id) then
    raise exception 'No tienes permiso para borrar pedidos';
  end if;

  if not exists (select 1 from public.local_orders where id = p_local_order_id) then
    raise exception 'Pedido local no encontrado';
  end if;

  select id into v_warehouse_venta_publico_id from public.warehouses where code = 'venta-publico' limit 1;
  if v_warehouse_venta_publico_id is null then
    raise exception 'Warehouse venta-publico no encontrado';
  end if;

  -- Devolver stock de todos los items con variant_id
  for v_item in
    select variant_id, size, quantity
    from public.local_order_items
    where local_order_id = p_local_order_id
      and variant_id is not null
  loop
    if coalesce(v_item.size, '') <> '' then
      v_normalized_size := trim(v_item.size);
      if v_normalized_size ~ '^\d+(\.\d+)?$' then
        v_normalized_size := split_part(v_normalized_size, '.', 1);
      end if;

      -- Si existen registros por warehouse para este variant+talle, devolver ahí; si no, usar fallback variant_sizes
      select exists(
        select 1
        from public.variant_size_warehouse_stock
        where variant_id = v_item.variant_id
          and size = v_normalized_size
        limit 1
      ) into v_has_warehouse_rows;

      if v_has_warehouse_rows then
        insert into public.variant_size_warehouse_stock (variant_id, size, warehouse_id, stock_qty, updated_at)
        values (v_item.variant_id, v_normalized_size, v_warehouse_venta_publico_id, v_item.quantity, now())
        on conflict (variant_id, size, warehouse_id)
        do update set
          stock_qty = public.variant_size_warehouse_stock.stock_qty + v_item.quantity,
          updated_at = now();
      else
        update public.variant_sizes
        set stock_qty = coalesce(stock_qty, 0) + v_item.quantity,
            updated_at = now()
        where variant_id = v_item.variant_id
          and size = v_normalized_size;
      end if;
    else
      insert into public.variant_warehouse_stock (variant_id, warehouse_id, stock_qty, updated_at)
      values (v_item.variant_id, v_warehouse_venta_publico_id, v_item.quantity, now())
      on conflict (variant_id, warehouse_id)
      do update set
        stock_qty = public.variant_warehouse_stock.stock_qty + v_item.quantity,
        updated_at = now();
    end if;
  end loop;

  -- Borrar pedido (cascade borra items)
  delete from public.local_orders where id = p_local_order_id;
  v_deleted := true;

  return json_build_object(
    'success', v_deleted,
    'local_order_id', p_local_order_id
  );
end $$;

comment on function public.rpc_delete_local_order(uuid) is
  'Elimina un pedido local y devuelve stock a venta-publico (por talle si aplica). Solo admin.';

select pg_notify('pgrst', 'reload schema');

