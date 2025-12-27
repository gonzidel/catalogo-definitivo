-- 20_mark_order_as_devolucion.sql - Función RPC para marcar pedidos como devolución
-- Esta función maneja la devolución de manera atómica: devuelve stock y cambia el estado

-- Función RPC para marcar un pedido como devolución
drop function if exists public.rpc_mark_order_as_devolucion(uuid);
create or replace function public.rpc_mark_order_as_devolucion(p_order_id uuid)
returns void language plpgsql security definer as $$
declare
  v_warehouse_id uuid;
  v_item record;
  v_current_stock numeric;
  v_new_stock numeric;
begin
  -- Verificar que el usuario es admin
  if not exists (
    select 1 from public.admins
    where user_id = auth.uid()
  ) then
    raise exception 'Solo administradores pueden marcar pedidos como devolución';
  end if;

  -- Verificar que el pedido existe y está en un estado válido para devolución
  if not exists (
    select 1 from public.orders
    where id = p_order_id
      and status in ('sent', 'closed')
  ) then
    raise exception 'El pedido no existe o no está en un estado válido para devolución (debe estar en estado sent o closed)';
  end if;

  -- Verificar que el pedido NO esté ya en devolución
  if exists (
    select 1 from public.orders
    where id = p_order_id
      and status = 'devolución'
  ) then
    raise exception 'El pedido ya está marcado como devolución';
  end if;

  -- Obtener el ID del almacén 'general'
  select id into v_warehouse_id
  from public.warehouses
  where code = 'general'
  limit 1;

  if v_warehouse_id is null then
    raise exception 'No se encontró el almacén general';
  end if;

  -- Devolver stock de todos los items del pedido que tengan variant_id
  for v_item in
    select oi.id, oi.variant_id, oi.quantity
    from public.order_items oi
    where oi.order_id = p_order_id
      and oi.variant_id is not null
      and oi.quantity > 0
  loop
    -- Obtener el stock actual del almacén general para esta variante
    select stock_qty into v_current_stock
    from public.variant_warehouse_stock
    where variant_id = v_item.variant_id
      and warehouse_id = v_warehouse_id;

    -- Si no existe registro, el stock actual es 0
    v_current_stock := coalesce(v_current_stock, 0);
    v_new_stock := v_current_stock + v_item.quantity;

    -- Actualizar o insertar el stock en variant_warehouse_stock
    insert into public.variant_warehouse_stock (
      variant_id,
      warehouse_id,
      stock_qty
    ) values (
      v_item.variant_id,
      v_warehouse_id,
      v_new_stock
    )
    on conflict (variant_id, warehouse_id)
    do update set
      stock_qty = v_new_stock,
      updated_at = now();
  end loop;

  -- Actualizar el estado del pedido a 'devolución'
  -- IMPORTANTE: Bloquear la fila primero con SELECT FOR UPDATE para prevenir condiciones de carrera
  -- Esto asegura que ningún otro proceso pueda cambiar el estado mientras se procesa
  perform 1
  from public.orders
  where id = p_order_id
    and status in ('sent', 'closed')
  for update; -- Bloquea la fila durante la transacción para prevenir cambios concurrentes

  -- Si no se encontró la fila para bloquear, el pedido no está en un estado válido
  if not found then
    raise exception 'No se pudo marcar el pedido como devolución. El pedido podría haber cambiado de estado o no estar en un estado válido (sent/closed).';
  end if;

  -- Ahora actualizar el estado (la fila ya está bloqueada)
  update public.orders
     set status = 'devolución',
         updated_at = now()
   where id = p_order_id
     and status in ('sent', 'closed'); -- Solo actualizar desde estos estados

  if not found then
    raise exception 'No se pudo marcar el pedido como devolución. El pedido podría haber cambiado de estado durante el procesamiento.';
  end if;

  -- Verificación final: asegurar que el estado se estableció correctamente
  if not exists (
    select 1 from public.orders
    where id = p_order_id
      and status = 'devolución'
  ) then
    raise exception 'Error crítico: El estado del pedido no se estableció correctamente como devolución';
  end if;
end;
$$;

-- Comentario sobre la función
comment on function public.rpc_mark_order_as_devolucion(uuid) is 
'Marca un pedido como devolución, devuelve el stock de todos sus productos al almacén general y establece el estado a devolución. Solo funciona para pedidos en estado sent o closed.';

-- Eliminar el trigger PRIMERO (antes de eliminar la función)
-- Esto evita el error de dependencias
drop trigger if exists prevent_devolucion_status_change on public.orders;

-- Crear la función del trigger
-- Esta función previene CUALQUIER cambio de estado cuando el pedido está en devolución
drop function if exists public.prevent_devolucion_status_change() cascade;
create or replace function public.prevent_devolucion_status_change()
returns trigger language plpgsql as $$
begin
  -- Si el pedido está en devolución, NO permitir cambiar a ningún otro estado
  -- El estado "devolución" es permanente e irreversible
  if old.status = 'devolución' and new.status != 'devolución' then
    raise exception 'No se puede cambiar el estado de un pedido en devolución. El estado "devolución" es permanente.';
  end if;
  
  -- Prevenir que un pedido que debería estar en devolución cambie a picked
  -- Esta es una protección adicional contra cambios inesperados
  if new.status = 'picked' and old.status = 'devolución' then
    raise exception 'Un pedido en devolución no puede cambiar a estado apartado. El estado "devolución" es permanente.';
  end if;
  
  return new;
end;
$$;

-- Crear trigger para prevenir cambios de estado después de marcar como devolución
-- Este trigger previene que un pedido en estado 'devolución' cambie a otro estado
create trigger prevent_devolucion_status_change
  before update on public.orders
  for each row
  when (old.status = 'devolución' and new.status != 'devolución')
execute function public.prevent_devolucion_status_change();

-- Notificar recarga del esquema
select pg_notify('pgrst','reload schema');
