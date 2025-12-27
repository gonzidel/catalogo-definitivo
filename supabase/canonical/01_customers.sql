-- 01_customers.sql — Clientes (perfiles) + RLS (idempotente)

create table if not exists public.customers (
  id uuid primary key references auth.users(id) on delete cascade,
  customer_number text unique, -- Número único de cliente (0001, 0002, etc.)
  full_name text,
  address text,
  city text,
  province text,
  phone text,
  dni text,
  email text, -- Email del usuario (sincronizado desde auth.users)
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Agregar columnas si no existen (para tablas existentes)
do $$ 
begin
  -- Agregar columna email si no existe
  if not exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' 
    and table_name = 'customers' 
    and column_name = 'email'
  ) then
    alter table public.customers add column email text;
  end if;
  
  -- Agregar columna customer_number si no existe
  if not exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' 
    and table_name = 'customers' 
    and column_name = 'customer_number'
  ) then
    alter table public.customers add column customer_number text;
    -- Crear índice único para customer_number
    create unique index if not exists customers_customer_number_unique 
    on public.customers(customer_number) 
    where customer_number is not null;
  end if;
end $$;

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'customers_set_updated_at') then
    create trigger customers_set_updated_at
      before update on public.customers
      for each row execute function public.set_updated_at();
  end if;
end $$;

alter table public.customers enable row level security;

-- Self policies (authenticated user = owner)
do $$ begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='customers' and policyname='customers_self_select'
  ) then
    create policy customers_self_select on public.customers
      for select to authenticated using (id = auth.uid());
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='customers' and policyname='customers_self_insert'
  ) then
    create policy customers_self_insert on public.customers
      for insert to authenticated with check (id = auth.uid());
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='customers' and policyname='customers_self_update'
  ) then
    create policy customers_self_update on public.customers
      for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
  end if;
end $$;

-- Política para admins: pueden ver todos los customers
do $$ begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='customers' and policyname='customers_admin_select'
  ) then
    create policy customers_admin_select on public.customers
      for select to authenticated
      using (exists (select 1 from public.admins a where a.user_id = auth.uid()));
  end if;
end $$;

-- Función para generar el siguiente número de cliente
create or replace function public.generate_customer_number()
returns text
language plpgsql
as $$
declare
  next_number integer;
  formatted_number text;
begin
  -- Obtener el siguiente número secuencial
  select coalesce(max(cast(customer_number as integer)), 0) + 1
  into next_number
  from public.customers
  where customer_number ~ '^\d+$'; -- Solo números
  
  -- Formatear como 0001, 0002, etc. (4 dígitos)
  formatted_number := lpad(next_number::text, 4, '0');
  
  return formatted_number;
end;
$$;

-- Función para asignar número de cliente automáticamente
create or replace function public.assign_customer_number()
returns trigger
language plpgsql
as $$
begin
  -- Solo asignar número si no existe
  if new.customer_number is null or new.customer_number = '' then
    new.customer_number := public.generate_customer_number();
  end if;
  
  return new;
end;
$$;

-- Trigger para asignar número de cliente antes de insertar o actualizar
do $$ 
begin
  if not exists (
    select 1 from pg_trigger 
    where tgname = 'assign_customer_number_trigger'
  ) then
    create trigger assign_customer_number_trigger
    before insert or update on public.customers
    for each row
    execute function public.assign_customer_number();
  else
    -- Si el trigger existe pero solo está en INSERT, agregarlo también a UPDATE
    drop trigger if exists assign_customer_number_trigger on public.customers;
    create trigger assign_customer_number_trigger
    before insert or update on public.customers
    for each row
    execute function public.assign_customer_number();
  end if;
end $$;

-- Función para poblar emails existentes desde auth.users
-- Esta función actualiza la columna email en customers con los emails de auth.users
create or replace function public.populate_existing_customer_emails()
returns void
language plpgsql
security definer
as $$
begin
  -- Actualizar emails de customers existentes desde auth.users
  update public.customers c
  set email = au.email
  from auth.users au
  where c.id = au.id
  and (c.email is null or c.email != au.email);
  
  -- También crear registros en customers para usuarios que no tienen perfil
  insert into public.customers (id, email)
  select au.id, au.email
  from auth.users au
  where not exists (
    select 1 from public.customers c where c.id = au.id
  )
  on conflict (id) do update
  set email = excluded.email;
end;
$$;

-- Función para asignar números de cliente a clientes existentes que no tienen número
create or replace function public.assign_customer_numbers_to_existing()
returns void
language plpgsql
as $$
declare
  customer_record record;
  next_number integer;
  formatted_number text;
begin
  -- Asignar números a clientes existentes que no tienen número
  for customer_record in 
    select id from public.customers 
    where customer_number is null or customer_number = ''
    order by created_at
  loop
    -- Obtener el siguiente número disponible
    select coalesce(max(cast(customer_number as integer)), 0) + 1
    into next_number
    from public.customers
    where customer_number ~ '^\d+$';
    
    -- Formatear como 0001, 0002, etc.
    formatted_number := lpad(next_number::text, 4, '0');
    
    -- Asignar el número
    update public.customers
    set customer_number = formatted_number
    where id = customer_record.id;
  end loop;
end;
$$;

-- Ejecutar una vez para poblar emails existentes
-- Esto sincroniza todos los emails de usuarios existentes
do $$
begin
  perform public.populate_existing_customer_emails();
  raise notice 'Emails sincronizados desde auth.users a customers';
exception when others then
  raise warning 'Error al sincronizar emails: %', sqlerrm;
end $$;

-- Ejecutar una vez para asignar números a clientes existentes
-- Esto asigna números secuenciales a clientes que no tienen número
do $$
begin
  perform public.assign_customer_numbers_to_existing();
  raise notice 'Números de cliente asignados a clientes existentes';
exception when others then
  raise warning 'Error al asignar números de cliente: %', sqlerrm;
end $$;

select pg_notify('pgrst','reload schema');

