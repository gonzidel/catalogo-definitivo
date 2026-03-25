-- 19_reschedule_sent_order.sql - Función para reprogramar pedidos enviados
-- Permite actualizar la fecha sent_at de pedidos ya enviados para reimprimir rótulos
-- y que aparezcan en la lista de envíos de closed-orders.html

-- Función para reprogramar un pedido enviado (actualizar sent_at)
drop function if exists public.rpc_reschedule_sent_order(uuid, timestamptz);
create or replace function public.rpc_reschedule_sent_order(
  p_order_id uuid,
  p_new_sent_at timestamptz
)
returns void language plpgsql security definer as $$
begin
  -- Verificar que el usuario es admin
  if not exists (
    select 1 from public.admins
    where user_id = auth.uid()
  ) then
    raise exception 'Solo administradores pueden reprogramar pedidos enviados';
  end if;

  -- Verificar que el pedido existe y está enviado
  if not exists (
    select 1 from public.orders
    where id = p_order_id
      and status = 'sent'
  ) then
    raise exception 'El pedido no existe o no está en estado enviado';
  end if;

  -- Actualizar la fecha de envío
  update public.orders
     set sent_at = p_new_sent_at,
         updated_at = now()
   where id = p_order_id
     and status = 'sent';

  if not found then
    raise exception 'No se pudo actualizar la fecha de envío';
  end if;
end;
$$;

-- Otorgar permisos de ejecución a usuarios autenticados
grant execute on function public.rpc_reschedule_sent_order to authenticated;

-- Notificar recarga de esquema
select pg_notify('pgrst','reload schema');
