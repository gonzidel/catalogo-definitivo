-- 17_add_sent_at_column.sql - Agregar columna sent_at para rastrear fecha de envío

-- Agregar columna sent_at a orders si no existe
do $$ 
begin
  if not exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' 
    and table_name = 'orders' 
    and column_name = 'sent_at'
  ) then
    alter table public.orders add column sent_at timestamptz;
    comment on column public.orders.sent_at is 'Fecha y hora en que el pedido pasó a estado sent (enviado)';
  end if;
end $$;

-- Actualizar función rpc_finalize_order para que actualice sent_at
drop function if exists public.rpc_finalize_order(uuid);
create or replace function public.rpc_finalize_order(p_order_id uuid)
returns void language plpgsql security definer as $$
begin
  -- Verificar que el usuario es admin
  if not exists (
    select 1 from public.admins
    where user_id = auth.uid()
  ) then
    raise exception 'Solo administradores pueden finalizar pedidos';
  end if;

  -- Verificar que el pedido existe y está cerrado
  if not exists (
    select 1 from public.orders
    where id = p_order_id
      and status = 'closed'
  ) then
    raise exception 'El pedido no existe o no está cerrado';
  end if;

  -- Actualizar el estado del pedido a 'sent' (terminado/enviado) y establecer sent_at
  update public.orders
     set status = 'sent',
         sent_at = now(),
         updated_at = now()
   where id = p_order_id;

  if not found then
    raise exception 'No se pudo marcar el pedido como terminado.';
  end if;
end;
$$;

-- Actualizar función rpc_mark_order_as_sent para que también actualice sent_at
drop function if exists public.rpc_mark_order_as_sent(uuid);
create or replace function public.rpc_mark_order_as_sent(p_order_id uuid)
returns void language plpgsql security definer as $$
begin
  -- Verificar que el usuario es admin
  if not exists (
    select 1 from public.admins
    where user_id = auth.uid()
  ) then
    raise exception 'Solo administradores pueden marcar pedidos como terminados';
  end if;

  -- Verificar que el pedido existe y está cerrado
  if not exists (
    select 1 from public.orders
    where id = p_order_id
      and status = 'closed'
  ) then
    raise exception 'El pedido no existe o no está cerrado';
  end if;

  -- Actualizar el estado del pedido a 'sent' (terminado/enviado) y establecer sent_at
  update public.orders
     set status = 'sent',
         sent_at = now(),
         updated_at = now()
   where id = p_order_id;

  if not found then
    raise exception 'No se pudo marcar el pedido como terminado.';
  end if;
end;
$$;

select pg_notify('pgrst','reload schema');
