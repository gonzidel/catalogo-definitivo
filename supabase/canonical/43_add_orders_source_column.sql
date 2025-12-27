-- 43_add_orders_source_column.sql — Agregar campos source y created_by_user_id a orders (idempotente)

-- 1) Agregar columna source si no existe
do $$ 
begin
  if not exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' 
    and table_name = 'orders' 
    and column_name = 'source'
  ) then
    alter table public.orders add column source text default 'customer';
    comment on column public.orders.source is 'Origen del pedido: customer (creado por cliente desde web) o admin (creado por administrador)';
    raise notice 'Columna source agregada a orders';
  else
    raise notice 'Columna source ya existe en orders';
  end if;
end $$;

-- 2) Agregar columna created_by_user_id si no existe
do $$ 
begin
  if not exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' 
    and table_name = 'orders' 
    and column_name = 'created_by_user_id'
  ) then
    alter table public.orders add column created_by_user_id uuid;
    comment on column public.orders.created_by_user_id is 'ID del usuario que creó el pedido (customer_id si es cliente, user_id del admin si es admin)';
    raise notice 'Columna created_by_user_id agregada a orders';
  else
    raise notice 'Columna created_by_user_id ya existe en orders';
  end if;
end $$;

-- 3) Backfill: actualizar pedidos existentes
-- source='customer' y created_by_user_id=customer_id para todos los pedidos existentes
do $$
begin
  update public.orders
  set source = 'customer',
      created_by_user_id = customer_id
  where source IS NULL 
     OR created_by_user_id IS NULL;
  
  raise notice 'Backfill completado: pedidos existentes actualizados con source=customer y created_by_user_id=customer_id';
end $$;

-- 4) Crear índice para mejorar consultas por source
create index if not exists idx_orders_source on public.orders(source);
create index if not exists idx_orders_created_by_user_id on public.orders(created_by_user_id);

-- Recargar esquema
select pg_notify('pgrst','reload schema');

