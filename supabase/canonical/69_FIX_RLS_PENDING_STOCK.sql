-- 69_FIX_RLS_PENDING_STOCK.sql
-- Actualizar políticas RLS para incluir productos con status 'pending_stock'
-- Esto permite que los productos con stock pendiente aparezcan en public-sales.html

-- Actualizar política para usuarios anónimos
drop policy if exists anon_select_products on public.products;
create policy anon_select_products on public.products
  for select to anon using (status IN ('active', 'pending_stock'));

-- Actualizar política para usuarios autenticados
drop policy if exists auth_select_products on public.products;
create policy auth_select_products on public.products
  for select to authenticated using (status IN ('active', 'pending_stock'));

-- Notificar recarga de esquema
select pg_notify('pgrst','reload schema');

