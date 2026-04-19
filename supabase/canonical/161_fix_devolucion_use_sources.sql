-- 161_fix_devolucion_use_sources.sql
-- Ajusta rpc_mark_order_as_devolucion para devolver stock respetando
-- order_item_stock_sources cuando existen trazas por deposito.

create or replace function public.rpc_mark_order_as_devolucion(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_warehouse_general_id uuid;
  v_item record;
  v_src record;
  v_normalized_size text;
  v_qty int;
  v_has_sources boolean;
begin
  if not exists (
    select 1 from public.admins
    where user_id = auth.uid()
  ) then
    raise exception 'Solo administradores pueden marcar pedidos como devolución';
  end if;

  if not exists (
    select 1 from public.orders
    where id = p_order_id
      and status in ('sent', 'closed')
  ) then
    raise exception 'El pedido no existe o no está en un estado válido para devolución (debe estar en estado sent o closed)';
  end if;

  if exists (
    select 1 from public.orders
    where id = p_order_id
      and status = 'devolución'
  ) then
    raise exception 'El pedido ya está marcado como devolución';
  end if;

  select id into v_warehouse_general_id
  from public.warehouses
  where code = 'general'
  limit 1;

  if v_warehouse_general_id is null then
    raise exception 'No se encontró el almacén general';
  end if;

  for v_item in
    select
      oi.id,
      oi.variant_id,
      oi.size,
      greatest(0, coalesce(oi.quantity, 0)::int) as item_qty
    from public.order_items oi
    where oi.order_id = p_order_id
      and oi.variant_id is not null
      and coalesce(oi.quantity, 0) > 0
  loop
    v_qty := v_item.item_qty;
    if v_qty <= 0 then
      continue;
    end if;

    v_normalized_size := trim(coalesce(v_item.size::text, ''));
    if v_normalized_size = '' then
      v_normalized_size := null;
    elsif v_normalized_size ~ '^\d+(\.\d+)?$' then
      v_normalized_size := split_part(v_normalized_size, '.', 1);
    end if;

    select exists (
      select 1
      from public.order_item_stock_sources s
      where s.order_item_id = v_item.id
    ) into v_has_sources;

    -- Prioridad: restaurar exactamente por las fuentes registradas.
    if v_has_sources then
      if v_normalized_size is not null then
        for v_src in
          select s.warehouse_id, greatest(0, coalesce(s.qty, 0))::int as qty
          from public.order_item_stock_sources s
          where s.order_item_id = v_item.id
            and coalesce(s.qty, 0) > 0
        loop
          update public.variant_size_warehouse_stock
          set stock_qty = stock_qty + v_src.qty,
              updated_at = now()
          where variant_id = v_item.variant_id
            and warehouse_id = v_src.warehouse_id
            and trim(coalesce(size::text, '')) = v_normalized_size;

          if not found then
            insert into public.variant_size_warehouse_stock (variant_id, warehouse_id, size, stock_qty, updated_at)
            values (v_item.variant_id, v_src.warehouse_id, v_normalized_size, v_src.qty, now());
          end if;
        end loop;
      else
        for v_src in
          select s.warehouse_id, greatest(0, coalesce(s.qty, 0))::int as qty
          from public.order_item_stock_sources s
          where s.order_item_id = v_item.id
            and coalesce(s.qty, 0) > 0
        loop
          insert into public.variant_warehouse_stock (variant_id, warehouse_id, stock_qty, updated_at)
          values (v_item.variant_id, v_src.warehouse_id, v_src.qty, now())
          on conflict (variant_id, warehouse_id)
          do update set
            stock_qty = public.variant_warehouse_stock.stock_qty + excluded.stock_qty,
            updated_at = now();
        end loop;
      end if;
    else
      -- Fallback legacy: si no hay trazas, restaurar al almacen general.
      if v_normalized_size is not null then
        update public.variant_size_warehouse_stock
        set stock_qty = stock_qty + v_qty,
            updated_at = now()
        where variant_id = v_item.variant_id
          and warehouse_id = v_warehouse_general_id
          and trim(coalesce(size::text, '')) = v_normalized_size;

        if not found then
          insert into public.variant_size_warehouse_stock (variant_id, warehouse_id, size, stock_qty, updated_at)
          values (v_item.variant_id, v_warehouse_general_id, v_normalized_size, v_qty, now());
        end if;
      else
        insert into public.variant_warehouse_stock (variant_id, warehouse_id, stock_qty, updated_at)
        values (v_item.variant_id, v_warehouse_general_id, v_qty, now())
        on conflict (variant_id, warehouse_id)
        do update set
          stock_qty = public.variant_warehouse_stock.stock_qty + excluded.stock_qty,
          updated_at = now();
      end if;
    end if;
  end loop;

  perform 1
  from public.orders
  where id = p_order_id
    and status in ('sent', 'closed')
  for update;

  if not found then
    raise exception 'No se pudo marcar el pedido como devolución. El pedido podría haber cambiado de estado o no estar en un estado válido (sent/closed).';
  end if;

  update public.orders
  set status = 'devolución',
      updated_at = now()
  where id = p_order_id
    and status in ('sent', 'closed');

  if not found then
    raise exception 'No se pudo marcar el pedido como devolución. El pedido podría haber cambiado de estado durante el procesamiento.';
  end if;
end;
$$;

comment on function public.rpc_mark_order_as_devolucion(uuid) is
'Marca un pedido como devolución, restaura stock usando order_item_stock_sources si existe traza y fallback a almacén general cuando no hay fuentes.';

select pg_notify('pgrst','reload schema');
