-- Verificación solo lectura: paridad vista disponible vs tabla snapshot público.
-- Ejecutar en SQL Editor (rol con SELECT en ambas) o desde herramientas internas.
-- No modifica datos.

select
  (select count(*) from public.catalog_public_available_view)::bigint as view_rows,
  (select count(*) from public.catalog_public_snapshot)::bigint as snapshot_rows;

-- ¿Un artículo concreto está ya en la copia que consume la web?
-- select count(*) from public.catalog_public_snapshot where "Articulo" = 'CAPI';
