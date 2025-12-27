-- Solución rápida: Refrescar la vista y verificar
-- Ejecutar en el SQL Editor de Supabase

-- 1. Primero, verificar si los productos están en la base de datos correctamente
SELECT 
  p.name,
  p.status,
  p.category,
  COUNT(pv.id) FILTER (WHERE pv.active = true) as variantes_activas
FROM public.products p
LEFT JOIN public.product_variants pv ON pv.product_id = p.id
WHERE p.name IN ('422', 'BA300')
GROUP BY p.id, p.name, p.status, p.category;

-- 2. Forzar la recreación de la vista (esto puede ayudar si hay un problema de caché)
DROP VIEW IF EXISTS public.catalog_public_view CASCADE;

-- 3. Recrear la vista (copiar y pegar el contenido completo de 04_catalog_public_view.sql)
-- O ejecutar directamente:
\i supabase/canonical/04_catalog_public_view.sql

-- 4. Refrescar el esquema de PostgREST
SELECT pg_notify('pgrst','reload schema');

-- 5. Verificar que ahora aparecen
SELECT 
  "Articulo",
  "Categoria",
  "Color",
  "Numeracion",
  "Precio"
FROM public.catalog_public_view
WHERE "Articulo" IN ('422', 'BA300')
ORDER BY "Articulo", "Color";

