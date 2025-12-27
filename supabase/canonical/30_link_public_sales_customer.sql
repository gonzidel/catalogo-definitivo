-- 30_link_public_sales_customer.sql — Vincular clientes de public-sales con usuarios autenticados (idempotente)

-- 1) Agregar columnas necesarias en customers si no existen
do $$ 
begin
  -- Agregar columna qr_code si no existe
  if not exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' 
    and table_name = 'customers' 
    and column_name = 'qr_code'
  ) then
    alter table public.customers add column qr_code uuid;
    create index if not exists idx_customers_qr_code 
      on public.customers(qr_code) 
      where qr_code is not null;
  end if;
  
  -- Agregar columna public_sales_customer_id si no existe
  if not exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' 
    and table_name = 'customers' 
    and column_name = 'public_sales_customer_id'
  ) then
    alter table public.customers add column public_sales_customer_id uuid 
      references public.public_sales_customers(id) on delete set null;
    create index if not exists idx_customers_public_sales_customer_id 
      on public.customers(public_sales_customer_id) 
      where public_sales_customer_id is not null;
  end if;
end $$;

-- 2) Función RPC: Buscar y vincular cliente de public_sales_customers y customers (admin)
create or replace function public.rpc_link_public_sales_customer(
  p_user_id uuid,
  p_email text,
  p_dni text,
  p_phone text,
  p_province text DEFAULT NULL,
  p_city text DEFAULT NULL
)
returns json
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_public_customer RECORD;
  v_admin_customer RECORD;
begin
  -- PRIORIDAD 1: Buscar por teléfono (si está disponible)
  if p_phone is not null and trim(p_phone) != '' then
    -- Buscar en public_sales_customers
    select id, customer_number, qr_code, first_name, last_name, phone, email, document_number
    into v_public_customer
    from public.public_sales_customers
    where trim(phone) = trim(p_phone)
      and id not in (
        select public_sales_customer_id 
        from public.customers 
        where public_sales_customer_id is not null
      )
    limit 1;
    
    -- Si encontró en public_sales_customers, retornar
    if v_public_customer is not null then
      return json_build_object(
        'found', true,
        'source', 'public_sales',
        'customer_number', v_public_customer.customer_number,
        'qr_code', v_public_customer.qr_code,
        'public_sales_customer_id', v_public_customer.id,
        'first_name', v_public_customer.first_name,
        'last_name', v_public_customer.last_name
      );
    end if;
    
    -- Buscar en customers con created_by_admin = true
    -- Primero intentar con validación de provincia/localidad si están disponibles
    select id, customer_number, full_name, phone, dni, email, address, city, province
    into v_admin_customer
    from public.customers
    where created_by_admin = true
      and trim(phone) = trim(p_phone)
      and id not in (
        select customer_id 
        from public.customer_auth_links 
        where customer_id is not null
      )
      -- Validar provincia/localidad si están disponibles
      and (
        (p_province is null or p_province = '' or lower(trim(coalesce(province, ''))) = lower(trim(p_province)))
        and (p_city is null or p_city = '' or lower(trim(coalesce(city, ''))) = lower(trim(p_city)))
      )
    limit 1;
    
    -- Si no encontró con validación de provincia/localidad, buscar sin validación
    if v_admin_customer is null then
      select id, customer_number, full_name, phone, dni, email, address, city, province
      into v_admin_customer
      from public.customers
      where created_by_admin = true
        and trim(phone) = trim(p_phone)
        and id not in (
          select customer_id 
          from public.customer_auth_links 
          where customer_id is not null
        )
      limit 1;
    end if;
    
    -- Si encontró en customers, retornar
    if v_admin_customer is not null then
      return json_build_object(
        'found', true,
        'source', 'admin_orders',
        'customer_number', v_admin_customer.customer_number,
        'admin_customer_id', v_admin_customer.id,
        'address', v_admin_customer.address,
        'city', v_admin_customer.city,
        'province', v_admin_customer.province,
        'full_name', v_admin_customer.full_name
      );
    end if;
  end if;
  
  -- PRIORIDAD 2: Buscar por email (solo si teléfono no encontró y email está disponible)
  if p_email is not null and trim(p_email) != '' then
    -- Buscar en public_sales_customers
    select id, customer_number, qr_code, first_name, last_name, phone, email, document_number
    into v_public_customer
    from public.public_sales_customers
    where lower(trim(email)) = lower(trim(p_email))
      and id not in (
        select public_sales_customer_id 
        from public.customers 
        where public_sales_customer_id is not null
      )
    limit 1;
    
    if v_public_customer is not null then
      return json_build_object(
        'found', true,
        'source', 'public_sales',
        'customer_number', v_public_customer.customer_number,
        'qr_code', v_public_customer.qr_code,
        'public_sales_customer_id', v_public_customer.id,
        'first_name', v_public_customer.first_name,
        'last_name', v_public_customer.last_name
      );
    end if;
    
    -- Buscar en customers con created_by_admin = true
    select id, customer_number, full_name, phone, dni, email, address, city, province
    into v_admin_customer
    from public.customers
    where created_by_admin = true
      and lower(trim(email)) = lower(trim(p_email))
      and id not in (
        select customer_id 
        from public.customer_auth_links 
        where customer_id is not null
      )
    limit 1;
    
    if v_admin_customer is not null then
      return json_build_object(
        'found', true,
        'source', 'admin_orders',
        'customer_number', v_admin_customer.customer_number,
        'admin_customer_id', v_admin_customer.id,
        'address', v_admin_customer.address,
        'city', v_admin_customer.city,
        'province', v_admin_customer.province,
        'full_name', v_admin_customer.full_name
      );
    end if;
  end if;
  
  -- PRIORIDAD 3: Buscar por DNI (solo si teléfono y email no encontraron y DNI está disponible)
  if p_dni is not null and trim(p_dni) != '' then
    -- Buscar en public_sales_customers
    select id, customer_number, qr_code, first_name, last_name, phone, email, document_number
    into v_public_customer
    from public.public_sales_customers
    where trim(document_number) = trim(p_dni)
      and id not in (
        select public_sales_customer_id 
        from public.customers 
        where public_sales_customer_id is not null
      )
    limit 1;
    
    if v_public_customer is not null then
      return json_build_object(
        'found', true,
        'source', 'public_sales',
        'customer_number', v_public_customer.customer_number,
        'qr_code', v_public_customer.qr_code,
        'public_sales_customer_id', v_public_customer.id,
        'first_name', v_public_customer.first_name,
        'last_name', v_public_customer.last_name
      );
    end if;
    
    -- Buscar en customers con created_by_admin = true
    select id, customer_number, full_name, phone, dni, email, address, city, province
    into v_admin_customer
    from public.customers
    where created_by_admin = true
      and trim(dni) = trim(p_dni)
      and id not in (
        select customer_id 
        from public.customer_auth_links 
        where customer_id is not null
      )
    limit 1;
    
    if v_admin_customer is not null then
      return json_build_object(
        'found', true,
        'source', 'admin_orders',
        'customer_number', v_admin_customer.customer_number,
        'admin_customer_id', v_admin_customer.id,
        'address', v_admin_customer.address,
        'city', v_admin_customer.city,
        'province', v_admin_customer.province,
        'full_name', v_admin_customer.full_name
      );
    end if;
  end if;
  
  -- No encontró coincidencia
  return json_build_object('found', false);
end;
$$;

-- 3) Permisos
grant execute on function public.rpc_link_public_sales_customer(uuid, text, text, text, text, text) to authenticated, anon;

-- 4) Recargar esquema
select pg_notify('pgrst', 'reload schema');

