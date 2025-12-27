-- 18_shipping_lists_storage.sql - Almacenamiento de listas de envío generadas

-- Tabla para guardar las listas de envío generadas
create table if not exists public.shipping_lists (
  id uuid primary key default gen_random_uuid(),
  transport_id uuid references public.transports(id) on delete set null,
  transport_name text not null,
  list_date date not null,
  orders_data jsonb not null, -- Array de objetos con los datos de los pedidos
  created_at timestamptz default now(),
  created_by uuid references auth.users(id) on delete set null
);

-- Índices para búsquedas rápidas
create index if not exists idx_shipping_lists_date on public.shipping_lists(list_date);
create index if not exists idx_shipping_lists_transport on public.shipping_lists(transport_id);
create index if not exists idx_shipping_lists_created_at on public.shipping_lists(created_at desc);

-- RLS para shipping_lists
alter table public.shipping_lists enable row level security;

-- Política: solo admins pueden ver y crear listas
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'shipping_lists'
      and policyname = 'shipping_lists_admin_all'
  ) then
    create policy shipping_lists_admin_all
      on public.shipping_lists for all to authenticated
      using (exists (select 1 from public.admins a where a.user_id = auth.uid()))
      with check (exists (select 1 from public.admins a where a.user_id = auth.uid()));
  end if;
end $$;

-- Función RPC para guardar una lista de envío
drop function if exists public.rpc_save_shipping_list(uuid, text, date, jsonb);
create or replace function public.rpc_save_shipping_list(
  p_transport_id uuid,
  p_transport_name text,
  p_list_date date,
  p_orders_data jsonb
)
returns uuid language plpgsql security definer as $$
declare
  v_list_id uuid;
begin
  -- Verificar que el usuario es admin
  if not exists (
    select 1 from public.admins
    where user_id = auth.uid()
  ) then
    raise exception 'Solo administradores pueden guardar listas de envío';
  end if;

  -- Insertar la lista
  insert into public.shipping_lists (
    transport_id,
    transport_name,
    list_date,
    orders_data,
    created_by
  ) values (
    p_transport_id,
    p_transport_name,
    p_list_date,
    p_orders_data,
    auth.uid()
  )
  returning id into v_list_id;

  return v_list_id;
end;
$$;

-- Función RPC para obtener listas de envío por rango de fechas
drop function if exists public.rpc_get_shipping_lists(date, date);
create or replace function public.rpc_get_shipping_lists(
  p_start_date date default null,
  p_end_date date default null
)
returns table (
  id uuid,
  transport_id uuid,
  transport_name text,
  list_date date,
  orders_count int,
  created_at timestamptz
) language plpgsql security definer as $$
begin
  -- Verificar que el usuario es admin
  if not exists (
    select 1 from public.admins
    where user_id = auth.uid()
  ) then
    raise exception 'Solo administradores pueden ver listas de envío';
  end if;

  return query
  select 
    sl.id,
    sl.transport_id,
    sl.transport_name,
    sl.list_date,
    jsonb_array_length(sl.orders_data)::int as orders_count,
    sl.created_at
  from public.shipping_lists sl
  where 
    (p_start_date is null or sl.list_date >= p_start_date)
    and (p_end_date is null or sl.list_date <= p_end_date)
  order by sl.list_date desc, sl.created_at desc;
end;
$$;

-- Habilitar Realtime para shipping_lists
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and tablename = 'shipping_lists'
      and schemaname = 'public'
  ) then
    alter publication supabase_realtime add table public.shipping_lists;
  end if;
end $$;

select pg_notify('pgrst','reload schema');
