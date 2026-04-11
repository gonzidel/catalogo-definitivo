-- 81_get_total_stock_include_size_warehouse.sql
-- Stock total de una variante.
-- Con triggers 84+145, variant_warehouse_stock ya es la suma derivada de
-- variant_size_warehouse_stock. Usar solo variant_warehouse_stock para evitar
-- doble conteo (antes se sumaban ambas tablas, lo que duplicaba el valor).
-- Para variantes sin talles, variant_warehouse_stock es la fuente directa.
-- Para variantes con talles, trigger 145 mantiene variant_warehouse_stock = SUM(vsws).

create or replace function public.get_total_stock(p_variant_id uuid)
returns int
language plpgsql
stable
as $$
declare
  v_total int;
begin
  select coalesce(sum(stock_qty), 0) into v_total
  from public.variant_warehouse_stock
  where variant_id = p_variant_id;

  return v_total;
end $$;

select pg_notify('pgrst', 'reload schema');
