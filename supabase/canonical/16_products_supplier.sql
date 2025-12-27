-- 16_products_supplier.sql — Agregar campo supplier_id a productos (idempotente)

-- 1) Agregar columna supplier_id si no existe
do $$
begin
  if not exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' 
    and table_name = 'products' 
    and column_name = 'supplier_id'
  ) then
    alter table public.products 
    add column supplier_id uuid references public.suppliers(id) on delete set null;
    
    raise notice 'Columna supplier_id agregada a products';
  else
    raise notice 'Columna supplier_id ya existe en products';
  end if;
end $$;

-- 2) Crear índice para búsquedas eficientes
create index if not exists ix_products_supplier_id on public.products(supplier_id);

select pg_notify('pgrst','reload schema');



























