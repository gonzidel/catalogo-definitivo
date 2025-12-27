-- Script de diagnóstico para productos que no aparecen en catalog_public_view
-- Ejecutar en el SQL Editor de Supabase

-- 1. Verificar productos activos con variantes activas que NO aparecen en la vista
WITH products_with_active_variants AS (
  SELECT DISTINCT
    p.id as product_id,
    p.name as product_name,
    p.status,
    COUNT(pv.id) FILTER (WHERE pv.active = true) as active_variants_count,
    COUNT(pv.id) FILTER (WHERE pv.active = true AND (pv.color IS NULL OR pv.color = '')) as variants_without_color,
    COUNT(pv.id) FILTER (WHERE pv.active = true AND (pv.size IS NULL OR pv.size = '')) as variants_without_size,
    COUNT(pv.id) FILTER (WHERE pv.active = true AND (pv.price IS NULL OR pv.price = 0)) as variants_without_price
  FROM public.products p
  LEFT JOIN public.product_variants pv ON pv.product_id = p.id
  WHERE p.status = 'active'
  GROUP BY p.id, p.name, p.status
  HAVING COUNT(pv.id) FILTER (WHERE pv.active = true) > 0
),
products_in_view AS (
  SELECT DISTINCT "Articulo" as product_name
  FROM public.catalog_public_view
)
SELECT 
  p.product_name,
  p.status,
  p.active_variants_count,
  p.variants_without_color,
  p.variants_without_size,
  p.variants_without_price,
  CASE 
    WHEN v.product_name IS NULL THEN 'NO APARECE EN VISTA'
    ELSE 'APARECE EN VISTA'
  END as status_in_view
FROM products_with_active_variants p
LEFT JOIN products_in_view v ON v.product_name = p.product_name
WHERE v.product_name IS NULL  -- Solo los que NO aparecen
ORDER BY p.product_name;

-- 2. Ver detalles de variantes de productos problemáticos
-- (Reemplaza '422' y 'BA300' con los nombres de tus productos problemáticos)
SELECT 
  p.name as product_name,
  p.status as product_status,
  pv.color,
  pv.size,
  pv.sku,
  pv.active,
  pv.price,
  CASE 
    WHEN pv.color IS NULL OR pv.color = '' THEN 'SIN COLOR'
    WHEN pv.size IS NULL OR pv.size = '' THEN 'SIN TALLE'
    WHEN pv.price IS NULL OR pv.price = 0 THEN 'SIN PRECIO'
    WHEN pv.active = false THEN 'INACTIVA'
    ELSE 'OK'
  END as problema,
  -- Verificar si tiene imágenes
  (SELECT COUNT(*) FROM public.variant_images vi WHERE vi.variant_id = pv.id) as num_imagenes
FROM public.products p
JOIN public.product_variants pv ON pv.product_id = p.id
WHERE p.name IN ('422', 'BA300')  -- Cambiar por los nombres de tus productos
  AND p.status = 'active'
ORDER BY p.name, pv.color, pv.size;

-- 2b. Verificar si estos productos aparecen en la vista agrupados por color
SELECT 
  "Articulo",
  "Categoria",
  "Color",
  "Numeracion",
  "Precio",
  "Imagen Principal",
  "Filtro1",
  "Filtro2",
  "Filtro3"
FROM public.catalog_public_view
WHERE "Articulo" IN ('422', 'BA300')
ORDER BY "Articulo", "Color";

-- 3. Verificar si hay problemas con permisos RLS
-- Esto debería devolver resultados si los permisos están bien
SELECT 
  COUNT(*) as total_products_active,
  COUNT(DISTINCT pv.id) FILTER (WHERE pv.active = true) as total_variants_active
FROM public.products p
LEFT JOIN public.product_variants pv ON pv.product_id = p.id
WHERE p.status = 'active';

-- 4. Refrescar la vista (ejecutar si hiciste cambios)
SELECT pg_notify('pgrst','reload schema');

-- 5. Verificar directamente la vista
SELECT COUNT(*) as total_en_vista, COUNT(DISTINCT "Articulo") as productos_unicos
FROM public.catalog_public_view;

-- 6. Comparar productos en la vista vs productos activos con variantes activas
WITH productos_que_deberian_aparecer AS (
  SELECT DISTINCT
    p.name,
    p.status,
    COUNT(DISTINCT pv.id) FILTER (WHERE pv.active = true) as variantes_activas,
    COUNT(DISTINCT pv.id) FILTER (WHERE pv.active = true AND (pv.color IS NULL OR pv.color = '')) as sin_color,
    COUNT(DISTINCT pv.id) FILTER (WHERE pv.active = true AND (pv.size IS NULL OR pv.size = '')) as sin_talle,
    COUNT(DISTINCT pv.id) FILTER (WHERE pv.active = true AND (pv.price IS NULL OR pv.price = 0)) as sin_precio
  FROM public.products p
  LEFT JOIN public.product_variants pv ON pv.product_id = p.id
  WHERE p.status = 'active'
  GROUP BY p.id, p.name, p.status
  HAVING COUNT(DISTINCT pv.id) FILTER (WHERE pv.active = true) > 0
),
productos_en_vista AS (
  SELECT DISTINCT "Articulo" as name
  FROM public.catalog_public_view
)
SELECT 
  deberia.name,
  deberia.status,
  deberia.variantes_activas,
  deberia.sin_color,
  deberia.sin_talle,
  deberia.sin_precio,
  CASE 
    WHEN vista.name IS NULL THEN 'NO APARECE'
    ELSE 'APARECE'
  END as en_vista
FROM productos_que_deberian_aparecer deberia
LEFT JOIN productos_en_vista vista ON vista.name = deberia.name
ORDER BY 
  CASE WHEN vista.name IS NULL THEN 0 ELSE 1 END,
  deberia.name;

