-- 17_pending_customers.sql — Clientes pendientes de vinculación (idempotente)
-- Permite crear clientes manualmente antes de que se registren con Google
-- Y crear pedidos para estos clientes pendientes usando customers temporales

-- 1) Tabla de clientes pendientes -------------------------------------------
create table if not exists public.pending_customers (
  id uuid primary key default gen_random_uuid(),
  email text, -- Opcional, para vincular después
  full_name text not null,
  address text,
  city text,
  province text,
  phone text,
  dni text,
  customer_number text unique, -- Número único de cliente
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Índices para búsquedas
create index if not exists idx_pending_customers_email 
  on public.pending_customers(email) 
  where email is not null;

create index if not exists idx_pending_customers_dni 
  on public.pending_customers(dni) 
  where dni is not null;

-- Trigger para updated_at
do $$ 
begin
  if not exists (select 1 from pg_trigger where tgname = 'pending_customers_set_updated_at') then
    create trigger pending_customers_set_updated_at
      before update on public.pending_customers
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- RLS para pending_customers (solo admins pueden ver/crear)
alter table public.pending_customers enable row level security;

drop policy if exists pending_customers_admin_all on public.pending_customers;
create policy pending_customers_admin_all on public.pending_customers
  for all to authenticated
  using (exists (select 1 from public.admins a where a.user_id = auth.uid()));

-- 2) Modificar FK de customers.id para permitir customers temporales --------
-- Primero, necesitamos hacer la FK DEFERRABLE para poder insertar UUIDs temporales
-- que no existen en auth.users

do $$
declare
  constraint_name text;
begin
  -- Buscar el nombre de la constraint FK
  select conname into constraint_name
  from pg_constraint
  where conrelid = 'public.customers'::regclass
    and contype = 'f'
    and confrelid = 'auth.users'::regclass;
  
  -- Si existe, eliminarla y recrearla como DEFERRABLE
  if constraint_name is not null then
    execute format('alter table public.customers drop constraint %I', constraint_name);
    
    -- Crear nueva constraint DEFERRABLE INITIALLY DEFERRED
    alter table public.customers
      add constraint customers_id_fkey 
      foreign key (id) references auth.users(id) on delete cascade
      deferrable initially deferred;
    
    raise notice 'Constraint FK modificada a DEFERRABLE: %', constraint_name;
  else
    -- Si no existe la constraint, crearla como DEFERRABLE
    alter table public.customers
      add constraint customers_id_fkey 
      foreign key (id) references auth.users(id) on delete cascade
      deferrable initially deferred;
    
    raise notice 'Constraint FK creada como DEFERRABLE';
  end if;
exception when others then
  raise notice 'Error modificando constraint FK: %', sqlerrm;
end $$;

-- 3) Agregar columnas a customers para marcar temporales --------------------
alter table public.customers
  add column if not exists is_temporary boolean default false;

alter table public.customers
  add column if not exists pending_customer_email text;

-- Índice para buscar por email pendiente
create index if not exists idx_customers_pending_email 
  on public.customers(pending_customer_email) 
  where pending_customer_email is not null;

-- 4) Función para crear cliente pendiente -----------------------------------
create or replace function public.rpc_create_pending_customer(
  p_email text,
  p_full_name text,
  p_dni text,
  p_phone text,
  p_address text,
  p_city text,
  p_province text
)
returns jsonb
language plpgsql
security definer
as $$
declare
  new_pending_id uuid;
  new_customer_number text;
  next_number integer;
  max_pending_number integer;
  max_customer_number integer;
begin
  -- Generar número de cliente pendiente considerando ambas tablas
  -- Buscar el máximo número en pending_customers
  select coalesce(max(cast(customer_number as integer)), 0)
  into max_pending_number
  from public.pending_customers
  where customer_number ~ '^\d+$';
  
  -- Buscar el máximo número en customers
  select coalesce(max(cast(customer_number as integer)), 0)
  into max_customer_number
  from public.customers
  where customer_number ~ '^\d+$';
  
  -- Usar el máximo entre ambas tablas + 1
  next_number := greatest(max_pending_number, max_customer_number) + 1;
  
  new_customer_number := lpad(next_number::text, 4, '0');
  
  -- Crear cliente pendiente
  insert into public.pending_customers (
    email,
    full_name,
    dni,
    phone,
    address,
    city,
    province,
    customer_number
  ) values (
    nullif(trim(p_email), ''),
    p_full_name,
    nullif(trim(p_dni), ''),
    nullif(trim(p_phone), ''),
    nullif(trim(p_address), ''),
    nullif(trim(p_city), ''),
    nullif(trim(p_province), ''),
    new_customer_number
  )
  returning id into new_pending_id;
  
  -- Obtener el cliente creado
  return (
    select jsonb_build_object(
      'success', true,
      'id', id,
      'email', email,
      'full_name', full_name,
      'dni', dni,
      'phone', phone,
      'address', address,
      'city', city,
      'province', province,
      'customer_number', customer_number
    )
    from public.pending_customers
    where id = new_pending_id
  );
exception when others then
  return jsonb_build_object('success', false, 'error', sqlerrm);
end;
$$;

-- 5) Función para crear customer temporal y obtener su ID -------------------
-- Esta función crea un customer temporal en customers usando un UUID temporal
-- La FK DEFERRABLE permite insertar el UUID aunque no exista en auth.users
create or replace function public.rpc_create_temporary_customer(
  p_pending_customer_id uuid,
  p_email text,
  p_full_name text,
  p_dni text,
  p_phone text,
  p_address text,
  p_city text,
  p_province text,
  p_customer_number text
)
returns uuid
language plpgsql
security definer
as $$
declare
  temp_customer_id uuid;
begin
  -- Generar UUID temporal único
  temp_customer_id := gen_random_uuid();
  
  -- Insertar customer temporal
  -- La FK es DEFERRABLE, así que PostgreSQL permitirá esta inserción
  -- La validación se difiere hasta el final de la transacción
  insert into public.customers (
    id,
    email,
    full_name,
    dni,
    phone,
    address,
    city,
    province,
    customer_number,
    is_temporary,
    pending_customer_email
  ) values (
    temp_customer_id,
    p_email,
    p_full_name,
    p_dni,
    p_phone,
    p_address,
    p_city,
    p_province,
    p_customer_number,
    true,
    p_email
  );
  
  return temp_customer_id;
exception when others then
  raise exception 'Error creando customer temporal: %', sqlerrm;
end;
$$;

-- 6) Función para vincular pending customer a usuario real ------------------
create or replace function public.link_pending_customer_to_user(
  p_email text,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
as $$
declare
  pending_record record;
  temp_customer_record record;
  new_customer record;
begin
  -- Buscar cliente pendiente por email
  select * into pending_record
  from public.pending_customers
  where email = lower(trim(p_email))
  limit 1;
  
  if not found then
    return jsonb_build_object('success', false, 'linked', false, 'message', 'No se encontró cliente pendiente');
  end if;
  
  -- Buscar customer temporal por email pendiente
  select * into temp_customer_record
  from public.customers
  where pending_customer_email = lower(trim(p_email))
    and is_temporary = true
  limit 1;
  
  -- Si existe customer temporal, actualizar sus pedidos y luego eliminarlo
  if found then
    -- Actualizar todos los orders que referencian al customer temporal
    update public.orders
    set customer_id = p_user_id
    where customer_id = temp_customer_record.id;
    
    -- También actualizar carts si existen
    update public.carts
    set customer_id = p_user_id
    where customer_id = temp_customer_record.id;
    
    -- Eliminar el customer temporal
    delete from public.customers
    where id = temp_customer_record.id;
  end if;
  
  -- Crear registro en customers con los datos del pending
  insert into public.customers (
    id,
    email,
    full_name,
    address,
    city,
    province,
    phone,
    dni,
    customer_number,
    is_temporary,
    pending_customer_email
  ) values (
    p_user_id,
    pending_record.email,
    pending_record.full_name,
    pending_record.address,
    pending_record.city,
    pending_record.province,
    pending_record.phone,
    pending_record.dni,
    pending_record.customer_number,
    false,
    null
  )
  on conflict (id) do update set
    email = excluded.email,
    full_name = coalesce(excluded.full_name, customers.full_name),
    address = coalesce(excluded.address, customers.address),
    city = coalesce(excluded.city, customers.city),
    province = coalesce(excluded.province, customers.province),
    phone = coalesce(excluded.phone, customers.phone),
    dni = coalesce(excluded.dni, customers.dni),
    customer_number = coalesce(excluded.customer_number, customers.customer_number),
    is_temporary = false,
    pending_customer_email = null
  returning * into new_customer;
  
  -- Eliminar de pending_customers
  delete from public.pending_customers
  where id = pending_record.id;
  
  return jsonb_build_object(
    'success', true,
    'linked', true,
    'customer', row_to_json(new_customer),
    'message', 'Cliente vinculado correctamente'
  );
end;
$$;

select pg_notify('pgrst','reload schema');

