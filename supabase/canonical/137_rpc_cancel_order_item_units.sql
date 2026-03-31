-- 137_rpc_cancel_order_item_units.sql
-- Permite cancelar N unidades de un order_item (sin cancelar necesariamente toda la línea).
-- Si p_units = quantity: se comporta como cancelación total (status -> cancelled).
-- Si p_units < quantity: reduce quantity y devuelve stock + descuenta total por esas unidades.

drop function if exists public.rpc_cancel_order_item_units(uuid, int);

create or replace function public.rpc_cancel_order_item_units(
  p_item_id uuid,
  p_units int
)
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
  v_cancel_qty int;
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
  v_cancel_qty := greatest(1, least(coalesce(p_units, 0)::int, v_quantity));
  v_was_picked := (v_item_status = 'picked');

  -- Notificación al admin si estaba apartado (con cantidad parcial si aplica)
  if v_was_picked and v_cancel_qty > 0 then
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
      v_cancel_qty,
      v_item.customer_name,
      v_item.customer_number,
      'item_cancelled',
      format(
        'El cliente %s (Nº %s) canceló %s unidad(es) del producto "%s" (Color: %s, Talle: %s) del pedido #%s que ya estaba apartado.',
        coalesce(v_item.customer_name, 'Cliente'),
        coalesce(v_item.customer_number, '-'),
        v_cancel_qty,
        coalesce(v_item.product_name, 'Producto'),
        coalesce(v_item.color, '-'),
        coalesce(v_item.size, '-'),
        coalesce(v_item.order_number, 'Sin número')
      )
    );
  end if;

  -- Devolver stock al almacén general
  if v_variant_id is not null and v_cancel_qty > 0 then
    select id into v_warehouse_id from public.warehouses where code = 'general' limit 1;

    if v_warehouse_id is not null then
      v_size_normalized := trim(coalesce(v_item.size::text, ''));
      if v_size_normalized ~ '^\d+(\.\d+)?$' then
        v_size_normalized := split_part(v_size_normalized, '.', 1);
      end if;

      if v_size_normalized <> '' then
        update public.variant_size_warehouse_stock
        set stock_qty = stock_qty + v_cancel_qty,
            updated_at = now()
        where variant_id = v_variant_id
          and trim(coalesce(size, '')) = v_size_normalized
          and warehouse_id = v_warehouse_id;
        get diagnostics v_return_rows = row_count;

        if v_return_rows = 0 then
          insert into public.variant_size_warehouse_stock (variant_id, warehouse_id, size, stock_qty)
          values (v_variant_id, v_warehouse_id, v_size_normalized, v_cancel_qty);
        end if;
      else
        select stock_qty into v_current_stock
        from public.variant_warehouse_stock
        where variant_id = v_variant_id and warehouse_id = v_warehouse_id;
        v_current_stock := coalesce(v_current_stock, 0);
        v_new_stock := v_current_stock + v_cancel_qty;

        insert into public.variant_warehouse_stock (variant_id, warehouse_id, stock_qty)
        values (v_variant_id, v_warehouse_id, v_new_stock)
        on conflict (variant_id, warehouse_id)
        do update set stock_qty = variant_warehouse_stock.stock_qty + v_cancel_qty, updated_at = now();
      end if;
    end if;

    -- reserved_qty en product_variants (opcional)
    begin
      update public.product_variants
      set reserved_qty = greatest(reserved_qty - v_cancel_qty, 0)
      where id = v_variant_id;
    exception
      when undefined_table or undefined_object or others then
        null;
    end;
  end if;

  -- Actualizar total del pedido
  update public.orders
  set total_amount = greatest(
    coalesce(total_amount, 0) - (coalesce(v_item.price_snapshot, 0) * v_cancel_qty),
    0
  ),
  updated_at = now()
  where id = v_item.order_id_full;

  -- Reducir quantity o cancelar la línea
  if v_cancel_qty >= v_quantity then
    update public.order_items
    set status = 'cancelled',
        updated_at = now()
    where id = p_item_id;
  else
    update public.order_items
    set quantity = greatest(coalesce(quantity, 0) - v_cancel_qty, 0),
        updated_at = now()
    where id = p_item_id;
  end if;

  return json_build_object(
    'item_id', p_item_id,
    'order_id', v_item.order_id_full,
    'cancelled_units', v_cancel_qty,
    'was_picked', v_was_picked,
    'cancelled_entire_line', (v_cancel_qty >= v_quantity)
  );
end;
$$;

comment on function public.rpc_cancel_order_item_units(uuid, int) is
  'Cancela N unidades de un ítem de pedido y devuelve stock; reduce quantity o marca cancelled.';

select pg_notify('pgrst', 'reload schema');

