-- 16_closed_orders_transport.sql - Transportes y rótulos para pedidos cerrados

-- Tabla de transportes agendados
create table if not exists public.transports (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  details text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Agregar columna transport_id a customers si no existe
do $$ 
begin
  if not exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' 
    and table_name = 'customers' 
    and column_name = 'transport_id'
  ) then
    alter table public.customers add column transport_id uuid references public.transports(id) on delete set null;
  end if;
end $$;

-- Agregar columnas a orders para rótulos si no existen
do $$ 
begin
  -- Columna labels_printed
  if not exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' 
    and table_name = 'orders' 
    and column_name = 'labels_printed'
  ) then
    alter table public.orders add column labels_printed boolean default false;
  end if;
  
  -- Columna labels_count
  if not exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' 
    and table_name = 'orders' 
    and column_name = 'labels_count'
  ) then
    alter table public.orders add column labels_count integer default 1;
  end if;
  
  -- Columna transport_id en orders (opcional, para referencia específica del pedido)
  if not exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' 
    and table_name = 'orders' 
    and column_name = 'transport_id'
  ) then
    alter table public.orders add column transport_id uuid references public.transports(id) on delete set null;
  end if;
end $$;

-- Trigger updated_at para transports
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'transports_set_updated_at') then
    create trigger transports_set_updated_at
      before update on public.transports
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- RLS para transports
alter table public.transports enable row level security;

-- Política: solo admins pueden gestionar transportes
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'transports'
      and policyname = 'transports_admin_all'
  ) then
    create policy transports_admin_all
      on public.transports for all to authenticated
      using (exists (select 1 from public.admins a where a.user_id = auth.uid()))
      with check (exists (select 1 from public.admins a where a.user_id = auth.uid()));
  end if;
end $$;

-- Política para admins: pueden actualizar customers (incluyendo transport_id)
do $$ 
begin
  if not exists (
    select 1 from pg_policies 
    where schemaname = 'public' 
      and tablename = 'customers' 
      and policyname = 'customers_admin_update'
  ) then
    create policy customers_admin_update on public.customers
      for update to authenticated
      using (exists (select 1 from public.admins a where a.user_id = auth.uid()))
      with check (exists (select 1 from public.admins a where a.user_id = auth.uid()));
  end if;
end $$;

-- Función RPC para actualizar transporte de un cliente (para evitar problemas de RLS)
drop function if exists public.rpc_update_customer_transport(uuid, uuid);
create or replace function public.rpc_update_customer_transport(
  p_customer_id uuid,
  p_transport_id uuid
)
returns json language plpgsql security definer as $$
declare
  v_updated_customer record;
begin
  -- Verificar que el usuario es admin
  if not exists (
    select 1 from public.admins
    where user_id = auth.uid()
  ) then
    raise exception 'Solo administradores pueden actualizar el transporte de clientes';
  end if;

  -- Actualizar el transport_id del cliente
  update public.customers
     set transport_id = p_transport_id,
         updated_at = now()
   where id = p_customer_id;

  if not found then
    raise exception 'Cliente no encontrado';
  end if;

  -- Retornar los datos actualizados
  select id, transport_id, full_name into v_updated_customer
  from public.customers
  where id = p_customer_id;

  return json_build_object(
    'id', v_updated_customer.id,
    'transport_id', v_updated_customer.transport_id,
    'full_name', v_updated_customer.full_name
  );
end;
$$;

-- Función para revertir pedido de "closed" a "picked"
drop function if exists public.rpc_revert_order_to_picked(uuid);
create or replace function public.rpc_revert_order_to_picked(p_order_id uuid)
returns void language plpgsql security definer as $$
begin
  -- Verificar que el usuario es admin
  if not exists (
    select 1 from public.admins
    where user_id = auth.uid()
  ) then
    raise exception 'Solo administradores pueden revertir pedidos';
  end if;

  -- Verificar que el pedido existe y está cerrado
  if not exists (
    select 1 from public.orders
    where id = p_order_id
      and status = 'closed'
  ) then
    raise exception 'El pedido no existe o no está cerrado';
  end if;

  -- Revertir el estado del pedido a "picked"
  update public.orders
     set status = 'picked',
         updated_at = now()
   where id = p_order_id;

  if not found then
    raise exception 'No se pudo revertir el pedido.';
  end if;
end;
$$;

-- Función para actualizar cantidad de rótulos
drop function if exists public.rpc_update_order_labels_count(uuid, integer);
create or replace function public.rpc_update_order_labels_count(
  p_order_id uuid,
  p_labels_count integer
)
returns void language plpgsql security definer as $$
begin
  -- Verificar que el usuario es admin
  if not exists (
    select 1 from public.admins
    where user_id = auth.uid()
  ) then
    raise exception 'Solo administradores pueden actualizar la cantidad de rótulos';
  end if;

  -- Validar que la cantidad sea positiva
  if p_labels_count < 1 then
    raise exception 'La cantidad de rótulos debe ser al menos 1';
  end if;

  -- Actualizar la cantidad de rótulos
  update public.orders
     set labels_count = p_labels_count,
         updated_at = now()
   where id = p_order_id;

  if not found then
    raise exception 'Pedido no encontrado';
  end if;
end;
$$;

-- Función para marcar rótulos como impresos
drop function if exists public.rpc_mark_labels_printed(uuid);
create or replace function public.rpc_mark_labels_printed(p_order_id uuid)
returns void language plpgsql security definer as $$
begin
  -- Verificar que el usuario es admin
  if not exists (
    select 1 from public.admins
    where user_id = auth.uid()
  ) then
    raise exception 'Solo administradores pueden marcar rótulos como impresos';
  end if;

  -- Marcar los rótulos como impresos
  update public.orders
     set labels_printed = true,
         updated_at = now()
   where id = p_order_id;

  if not found then
    raise exception 'Pedido no encontrado';
  end if;
end;
$$;

-- Habilitar Realtime para transports
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and tablename = 'transports'
      and schemaname = 'public'
  ) then
    alter publication supabase_realtime add table public.transports;
  end if;
end $$;

select pg_notify('pgrst','reload schema');
