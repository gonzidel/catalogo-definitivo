-- 126_rpc_cancel_order_item_return_stock.sql
-- Al quitar un producto del pedido, devolver su cantidad al stock real:
-- variant_size_warehouse_stock (por talle) o variant_warehouse_stock (sin talle), almacén general.
-- La versión anterior solo tocaba product_variants.stock_qty, que no es la fuente de stock del catálogo;
-- por eso el stock no subía y podía quedar inconsistente.

drop function if exists public.rpc_cancel_order_item(uuid);

create or replace function public.rpc_cancel_order_item(p_item_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item record;
  v_item_status text;
  v_variant_id uuid;
  v_quantity int;
  v_was_picked boolean := false;
  v_warehouse_id uuid;
  v_warehouse_general_id uuid;
  v_warehouse_venta_id uuid;
  v_size_normalized text;
  v_has_sources boolean := false;
  v_src record;
begin
  select
    oi.id,
    oi.order_id,
    oi.variant_id,
    oi.quantity,
    oi.product_name,
    oi.color,
    oi.size,
    oi.price_snapshot,
    oi.status,
    o.id as order_id_full,
    o.order_number,
    o.customer_id,
    c.full_name as customer_name,
    c.customer_number
  into v_item
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  left join public.customers c on c.id = o.customer_id
  where oi.id = p_item_id
  for update of oi;

  if v_item.id is null then
    raise exception 'Item no encontrado';
  end if;

  if v_item.customer_id != auth.uid() then
    if not exists (select 1 from public.admins where user_id = auth.uid()) then
      raise exception 'No tienes permiso para cancelar este item';
    end if;
  end if;

  v_item_status := v_item.status;
  v_variant_id := v_item.variant_id;
  v_quantity := greatest(0, coalesce(v_item.quantity, 0)::int);
  v_was_picked := (v_item_status = 'picked');

  if v_item_status = 'cancelled' then
    raise exception 'Item ya cancelado';
  end if;

  if v_quantity <= 0 then
    raise exception 'Item sin unidades cancelables';
  end if;

  if v_variant_id is not null then
    perform 1
    from public.product_variants pv
    where pv.id = v_variant_id
    for update;
  end if;

  -- Notificación al admin si estaba apartado
  if v_was_picked then
    insert into public.admin_notifications (
      order_id, order_number, item_id, product_name, color, size, quantity,
      customer_name, customer_number, notification_type, message
    ) values (
      v_item.order_id_full,
      v_item.order_number,
      p_item_id,
      v_item.product_name,
      v_item.color,
      v_item.size,
      v_quantity,
      v_item.customer_name,
      v_item.customer_number,
      'item_cancelled',
      format(
        'El cliente %s (Nº %s) canceló el producto "%s" (Color: %s, Talle: %s, Cantidad: %s) del pedido #%s que ya estaba apartado.',
        coalesce(v_item.customer_name, 'Cliente'),
        coalesce(v_item.customer_number, '-'),
        coalesce(v_item.product_name, 'Producto'),
        coalesce(v_item.color, '-'),
        coalesce(v_item.size, '-'),
        v_quantity,
        coalesce(v_item.order_number, 'Sin número')
      )
    );
  end if;

  -- Devolver stock SOLO si el item estaba en reserved o waiting.
  -- Si estaba en picked, el stock NO vuelve automáticamente: queda pendiente
  -- para que el admin lo confirme via rpc_remove_order_item_restore_stock.
  if v_variant_id is not null and v_quantity > 0 and v_item_status in ('reserved', 'waiting') then
    select id into v_warehouse_general_id from public.warehouses where code = 'general' limit 1;
    select id into v_warehouse_venta_id from public.warehouses where code = 'venta-publico' limit 1;

    select exists (
      select 1
      from public.order_item_stock_sources s
      where s.order_item_id = p_item_id
    ) into v_has_sources;

    if v_has_sources then
      for v_src in
        select s.id, s.warehouse_id, greatest(coalesce(s.qty, 0), 0) as qty
        from public.order_item_stock_sources s
        where s.order_item_id = p_item_id
        order by s.warehouse_id, s.id
      loop
        if coalesce(v_src.qty, 0) <= 0 then
          continue;
        end if;

        v_size_normalized := trim(coalesce(v_item.size::text, ''));
        if v_size_normalized ~ '^\d+(\.\d+)?$' then
          v_size_normalized := split_part(v_size_normalized, '.', 1);
        end if;

        if v_size_normalized <> '' then
          insert into public.variant_size_warehouse_stock (variant_id, warehouse_id, size, stock_qty)
          values (v_variant_id, v_src.warehouse_id, v_size_normalized, 0)
          on conflict (variant_id, warehouse_id, size) do nothing;

          perform 1
          from public.variant_size_warehouse_stock
          where variant_id = v_variant_id
            and trim(coalesce(size, '')) = v_size_normalized
            and warehouse_id = v_src.warehouse_id
          for update;

          update public.variant_size_warehouse_stock
          set stock_qty = stock_qty + v_src.qty,
              updated_at = now()
          where variant_id = v_variant_id
            and trim(coalesce(size, '')) = v_size_normalized
            and warehouse_id = v_src.warehouse_id;
        else
          insert into public.variant_warehouse_stock (variant_id, warehouse_id, stock_qty)
          values (v_variant_id, v_src.warehouse_id, v_src.qty)
          on conflict (variant_id, warehouse_id)
          do update set stock_qty = variant_warehouse_stock.stock_qty + v_src.qty, updated_at = now();
        end if;
      end loop;

      -- Evita doble devolución en limpiezas futuras de ítems cancelados.
      delete from public.order_item_stock_sources
      where order_item_id = p_item_id;
    else
      -- Fallback sin trazas: waiting vuelve a venta-publico; reserved vuelve a general.
      v_warehouse_id := case
        when v_item_status = 'waiting' then v_warehouse_venta_id
        else v_warehouse_general_id
      end;

      if v_warehouse_id is not null then
        v_size_normalized := trim(coalesce(v_item.size::text, ''));
        if v_size_normalized ~ '^\d+(\.\d+)?$' then
          v_size_normalized := split_part(v_size_normalized, '.', 1);
        end if;

        if v_size_normalized <> '' then
          insert into public.variant_size_warehouse_stock (variant_id, warehouse_id, size, stock_qty)
          values (v_variant_id, v_warehouse_id, v_size_normalized, 0)
          on conflict (variant_id, warehouse_id, size) do nothing;

          perform 1
          from public.variant_size_warehouse_stock
          where variant_id = v_variant_id
            and trim(coalesce(size, '')) = v_size_normalized
            and warehouse_id = v_warehouse_id
          for update;

          update public.variant_size_warehouse_stock
          set stock_qty = stock_qty + v_quantity,
              updated_at = now()
          where variant_id = v_variant_id
            and trim(coalesce(size, '')) = v_size_normalized
            and warehouse_id = v_warehouse_id;
        else
          insert into public.variant_warehouse_stock (variant_id, warehouse_id, stock_qty)
          values (v_variant_id, v_warehouse_id, v_quantity)
          on conflict (variant_id, warehouse_id)
          do update set stock_qty = variant_warehouse_stock.stock_qty + v_quantity, updated_at = now();
        end if;
      end if;
    end if;

    begin
      update public.product_variants
      set reserved_qty = greatest(reserved_qty - v_quantity, 0)
      where id = v_variant_id;
    exception
      when undefined_table or undefined_object or others then
        null;
    end;
  end if;

  -- Actualizar total del pedido
  update public.orders
  set total_amount = greatest(
    coalesce(total_amount, 0) - (coalesce(v_item.price_snapshot, 0) * v_quantity),
    0
  ),
  updated_at = now()
  where id = v_item.order_id_full;

  -- Marcar ítem como cancelado
  update public.order_items
  set status = 'cancelled',
      updated_at = now()
  where id = p_item_id;

  return json_build_object(
    'item_id', p_item_id,
    'order_id', v_item.order_id_full,
    'was_picked', v_was_picked,
    'notification_created', v_was_picked,
    'applied', true,
    'idempotent_noop', false
  );
end;
$$;

comment on function public.rpc_cancel_order_item(uuid) is
  'Cancela un ítem de pedido y devuelve su cantidad al stock (variant_size_warehouse_stock por talle o variant_warehouse_stock).';

select pg_notify('pgrst', 'reload schema');
