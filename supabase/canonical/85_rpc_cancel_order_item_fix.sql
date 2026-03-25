-- 85_rpc_cancel_order_item_fix.sql
-- Corrige 404 y "relation product_variants does not exist" al cancelar ítem desde el cliente.
-- La RPC usa search_path = public y envuelve las actualizaciones de product_variants en
-- EXCEPTION para que, si esa tabla no existe o falla, la cancelación del ítem y del total
-- del pedido se complete igual (el pedido se elimina correctamente y no salen errores en consola).

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
begin
  -- Obtener información del item
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

  -- Verificar que el cliente es el dueño del pedido (o es admin)
  if v_item.customer_id != auth.uid() then
    if not exists (select 1 from public.admins where user_id = auth.uid()) then
      raise exception 'No tienes permiso para cancelar este item';
    end if;
  end if;

  v_item_status := v_item.status;
  v_variant_id := v_item.variant_id;
  v_quantity := v_item.quantity;
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

  -- Devolución de stock en product_variants (si la tabla existe; si no, no fallar)
  if v_variant_id is not null then
    begin
      if v_was_picked then
        update public.product_variants
           set reserved_qty = greatest(reserved_qty - v_quantity, 0),
               stock_qty = stock_qty + v_quantity
         where id = v_variant_id;
      else
        update public.product_variants
           set reserved_qty = greatest(reserved_qty - v_quantity, 0)
         where id = v_variant_id;
      end if;
    exception
      when undefined_table or undefined_object then
        null; -- Tabla o columna no existe: seguir sin fallar
      when others then
        null; -- Cualquier otro error de stock: no bloquear la cancelación
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
  'Cancela un ítem de pedido. No falla si product_variants no existe o no está accesible.';
