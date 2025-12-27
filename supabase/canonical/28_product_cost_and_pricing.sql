-- 28_product_cost_and_pricing.sql — Agregar campos de costo y cálculo de precio (idempotente)

-- 1) Agregar columna cost si no existe
do $$
begin
  if not exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' 
    and table_name = 'products' 
    and column_name = 'cost'
  ) then
    alter table public.products 
    add column cost numeric;
    
    raise notice 'Columna cost agregada a products';
  else
    raise notice 'Columna cost ya existe en products';
  end if;
end $$;

-- 2) Agregar columna price_percentage si no existe
do $$
begin
  if not exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' 
    and table_name = 'products' 
    and column_name = 'price_percentage'
  ) then
    alter table public.products 
    add column price_percentage numeric default 30;
    
    raise notice 'Columna price_percentage agregada a products';
  else
    raise notice 'Columna price_percentage ya existe en products';
  end if;
end $$;

-- 3) Agregar columna logistic_amount si no existe
do $$
begin
  if not exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' 
    and table_name = 'products' 
    and column_name = 'logistic_amount'
  ) then
    alter table public.products 
    add column logistic_amount numeric default 500;
    
    raise notice 'Columna logistic_amount agregada a products';
  else
    raise notice 'Columna logistic_amount ya existe en products';
  end if;
end $$;

-- Recarga del esquema REST
select pg_notify('pgrst','reload schema');
