-- 27_fix_admin_order_creation.sql
-- Solución integral para permisos de ADMINISTRADOR y creación de pedidos

-- 1. Políticas RLS para ORDERS (Permitir TODO a administradores)
drop policy if exists orders_admin_manage on public.orders;
create policy orders_admin_manage
  on public.orders
  for all -- SELECT, INSERT, UPDATE, DELETE
  to authenticated
  using (
    exists (select 1 from public.admins a where a.user_id = auth.uid())
  )
  with check (
    exists (select 1 from public.admins a where a.user_id = auth.uid())
  );

-- 2. Políticas RLS para ORDER_ITEMS (Permitir TODO a administradores)
drop policy if exists order_items_admin_manage on public.order_items;
create policy order_items_admin_manage
  on public.order_items
  for all
  to authenticated
  using (
    exists (select 1 from public.admins a where a.user_id = auth.uid())
  )
  with check (
    exists (select 1 from public.admins a where a.user_id = auth.uid())
  );

-- 3. Políticas RLS para CUSTOMERS (Permitir TODO a administradores)
-- Esto permite crear clientes, buscarlos y actualizarlos
drop policy if exists customers_admin_manage on public.customers;
create policy customers_admin_manage
  on public.customers
  for all
  to authenticated
  using (
    exists (select 1 from public.admins a where a.user_id = auth.uid())
  )
  with check (
    exists (select 1 from public.admins a where a.user_id = auth.uid())
  );

-- 4. Políticas RLS para PRODUCT_VARIANTS (Permitir UPDATE a administradores para stock)
drop policy if exists variants_admin_manage on public.product_variants;
create policy variants_admin_manage
  on public.product_variants
  for all
  to authenticated
  using (
    exists (select 1 from public.admins a where a.user_id = auth.uid())
  )
  with check (
    exists (select 1 from public.admins a where a.user_id = auth.uid())
  );
  
-- También para VARIANT_WAREHOUSE_STOCK si se usa sistema multi-depósito
create table if not exists public.variant_warehouse_stock (
    id uuid primary key default gen_random_uuid(),
    variant_id uuid references public.product_variants(id),
    warehouse_id uuid references public.warehouses(id),
    stock_qty int default 0,
    unique(variant_id, warehouse_id)
);
alter table public.variant_warehouse_stock enable row level security;

drop policy if exists warehouse_stock_admin_manage on public.variant_warehouse_stock;
create policy warehouse_stock_admin_manage
  on public.variant_warehouse_stock
  for all
  to authenticated
  using (
    exists (select 1 from public.admins a where a.user_id = auth.uid())
  )
  with check (
    exists (select 1 from public.admins a where a.user_id = auth.uid())
  );

-- 5. Crear función RPC para crear clientes desde Admin
-- Esta función asegura que el admin pueda crear un cliente sin restricciones de auth.users
create or replace function public.rpc_create_admin_customer(
  p_full_name text,
  p_email text default null,
  p_phone text default null,
  p_dni text default null,
  p_address text default null,
  p_city text default null,
  p_province text default null
)
returns json
language plpgsql
security definer -- Se ejecuta con permisos de superusuario DB para saltar cualquier restricción extra
set search_path = public
as $$
declare
  v_customer_id uuid;
  v_admin_check boolean;
begin
  -- Verificar si es admin
  select exists(select 1 from public.admins where user_id = auth.uid()) into v_admin_check;
  if not v_admin_check then
    return json_build_object('success', false, 'message', 'No autorizado');
  end if;

  -- Generar ID nuevo
  v_customer_id := gen_random_uuid();

  insert into public.customers (
    id, 
    full_name, 
    email, 
    phone, 
    dni, 
    address, 
    city, 
    province,
    created_at,
    updated_at
  ) values (
    v_customer_id,
    p_full_name,
    p_email,
    p_phone,
    p_dni,
    p_address,
    p_city,
    p_province,
    now(),
    now()
  );

  return json_build_object(
    'success', true, 
    'customer_id', v_customer_id,
    'message', 'Cliente creado con éxito'
  );

exception when others then
  return json_build_object('success', false, 'message', SQLERRM);
end;
$$;

-- 6. Recargar esquema
select pg_notify('pgrst','reload schema');
