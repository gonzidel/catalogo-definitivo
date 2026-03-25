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
  v_size_normalized text;
  v_return_rows int;
  v_current_stock numeric;
  v_new_stock numeric;
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
  where oi.id = p_item_id;

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

  -- Devolver stock al almacén general (variant_size_warehouse_stock por talle o variant_warehouse_stock sin talle)
  if v_variant_id is not null and v_quantity > 0 then
    select id into v_warehouse_id from public.warehouses where code = 'general' limit 1;

    if v_warehouse_id is not null then
      v_size_normalized := trim(coalesce(v_item.size::text, ''));
      if v_size_normalized ~ '^\d+(\.\d+)?$' then
        v_size_normalized := split_part(v_size_normalized, '.', 1);
      end if;

      if v_size_normalized <> '' then
        -- Con talle: devolver a variant_size_warehouse_stock
        update public.variant_size_warehouse_stock
        set stock_qty = stock_qty + v_quantity,
            updated_at = now()
        where variant_id = v_variant_id
          and trim(coalesce(size, '')) = v_size_normalized
          and warehouse_id = v_warehouse_id;
        get diagnostics v_return_rows = row_count;

        if v_return_rows = 0 then
          insert into public.variant_size_warehouse_stock (variant_id, warehouse_id, size, stock_qty)
          values (v_variant_id, v_warehouse_id, v_size_normalized, v_quantity);
        end if;
      else
        -- Sin talle: devolver a variant_warehouse_stock
        select stock_qty into v_current_stock
        from public.variant_warehouse_stock
        where variant_id = v_variant_id and warehouse_id = v_warehouse_id;
        v_current_stock := coalesce(v_current_stock, 0);
        v_new_stock := v_current_stock + v_quantity;

        insert into public.variant_warehouse_stock (variant_id, warehouse_id, stock_qty)
        values (v_variant_id, v_warehouse_id, v_new_stock)
        on conflict (variant_id, warehouse_id)
        do update set stock_qty = variant_warehouse_stock.stock_qty + v_quantity, updated_at = now();
      end if;
    end if;

    -- reserved_qty en product_variants (opcional; no fallar si no existe)
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
    'notification_created', v_was_picked
  );
end;
$$;

comment on function public.rpc_cancel_order_item(uuid) is
  'Cancela un ítem de pedido y devuelve su cantidad al stock (variant_size_warehouse_stock por talle o variant_warehouse_stock).';

select pg_notify('pgrst', 'reload schema');
