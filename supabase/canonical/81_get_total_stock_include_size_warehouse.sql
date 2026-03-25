-- 81_get_total_stock_include_size_warehouse.sql
-- Incluir en get_total_stock el stock por talle (variant_size_warehouse_stock)
-- para que catálogo y checkout vean el total real (general + venta público por variante y por talle).

create or replace function public.get_total_stock(p_variant_id uuid)
returns int
language plpgsql
stable
as $$
declare
  total_warehouse int;
  total_size_warehouse int;
begin
  -- Stock por variante (sin talle) en variant_warehouse_stock
  select coalesce(sum(stock_qty), 0) into total_warehouse
  from public.variant_warehouse_stock
  where variant_id = p_variant_id;

  -- Stock por talle en variant_size_warehouse_stock
  select coalesce(sum(stock_qty), 0) into total_size_warehouse
  from public.variant_size_warehouse_stock
  where variant_id = p_variant_id;

  return coalesce(total_warehouse, 0) + coalesce(total_size_warehouse, 0);
end $$;

select pg_notify('pgrst', 'reload schema');
