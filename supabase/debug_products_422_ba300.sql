-- Consulta específica para diagnosticar productos 422 y BA300
-- Ejecutar en el SQL Editor de Supabase

-- 1. Ver TODAS las variantes de estos productos (activas e inactivas)
SELECT 
  p.name as producto,
  p.status as status_producto,
  pv.id as variant_id,
  pv.color,
  pv.size,
  pv.sku,
  pv.active,
  pv.price,
  CASE 
    WHEN pv.color IS NULL THEN 'NULL'
    WHEN pv.color = '' THEN 'VACÍO'
    ELSE pv.color
  END as color_status,
  CASE 
    WHEN pv.size IS NULL THEN 'NULL'
    WHEN pv.size = '' THEN 'VACÍO'
    ELSE pv.size
  END as size_status,
  CASE 
    WHEN pv.price IS NULL THEN 'NULL'
    WHEN pv.price = 0 THEN 'CERO'
    ELSE pv.price::text
  END as price_status,
  (SELECT COUNT(*) FROM public.variant_images vi WHERE vi.variant_id = pv.id) as num_imagenes
FROM public.products p
LEFT JOIN public.product_variants pv ON pv.product_id = p.id
WHERE p.name IN ('422', 'BA300')
ORDER BY p.name, pv.active DESC, pv.color, pv.size;

-- 2. Simular lo que hace la vista para estos productos
-- Esto muestra exactamente qué debería aparecer en catalog_public_view
WITH base_simulation AS (
  SELECT
    p.id as product_id,
    p.category as "Categoria",
    p.name as "Articulo",
    coalesce(p.description,'') as "Descripcion",
    pv.color as "Color",
    string_agg(distinct pv.size, ',' order by pv.size) as "Numeracion",
    to_char(coalesce(p.created_at::date, now()::date), 'DD/MM/YYYY') as "FechaIngreso",
    min(pv.price)::text as "Precio",
    max(case when vi.position = 1 then vi.url end) as "Imagen Principal",
    pt.tag1_id,
    pt.tag2_id,
    pt.tag3_ids
  FROM public.products p
  JOIN public.product_variants pv ON pv.product_id = p.id AND pv.active = true
  LEFT JOIN public.variant_images vi ON vi.variant_id = pv.id
  LEFT JOIN public.product_tags pt ON pt.product_id = p.id
  WHERE p.status = 'active'
    AND p.name IN ('422', 'BA300')
  GROUP BY p.id, p.category, p.name, p.description, pv.color, p.created_at, pt.tag1_id, pt.tag2_id, pt.tag3_ids
)
SELECT 
  "Articulo",
  "Categoria",
  "Color",
  "Numeracion",
  "Precio",
  "Imagen Principal",
  CASE 
    WHEN "Color" IS NULL THEN '⚠️ COLOR NULL'
    WHEN "Color" = '' THEN '⚠️ COLOR VACÍO'
    ELSE '✓'
  END as color_check,
  CASE 
    WHEN "Numeracion" IS NULL THEN '⚠️ SIN TALLES'
    WHEN "Numeracion" = '' THEN '⚠️ TALLES VACÍO'
    ELSE '✓'
  END as talles_check,
  CASE 
    WHEN "Precio" IS NULL THEN '⚠️ PRECIO NULL'
    WHEN "Precio" = '0' THEN '⚠️ PRECIO CERO'
    ELSE '✓'
  END as precio_check
FROM base_simulation
ORDER BY "Articulo", "Color";

-- 3. Comparar con lo que realmente está en la vista
SELECT 
  "Articulo",
  "Categoria",
  "Color",
  "Numeracion",
  "Precio",
  "Imagen Principal"
FROM public.catalog_public_view
WHERE "Articulo" IN ('422', 'BA300')
ORDER BY "Articulo", "Color";

-- 4. Verificar si el problema es con el GROUP BY
-- Si hay variantes con color NULL, el GROUP BY podría estar causando problemas
SELECT 
  p.name,
  pv.color,
  COUNT(*) as variantes_por_color,
  COUNT(CASE WHEN pv.color IS NULL THEN 1 END) as con_color_null,
  COUNT(CASE WHEN pv.color = '' THEN 1 END) as con_color_vacio,
  COUNT(CASE WHEN pv.size IS NULL THEN 1 END) as con_size_null,
  COUNT(CASE WHEN pv.size = '' THEN 1 END) as con_size_vacio
FROM public.products p
JOIN public.product_variants pv ON pv.product_id = p.id
WHERE p.name IN ('422', 'BA300')
  AND p.status = 'active'
  AND pv.active = true
GROUP BY p.name, pv.color
ORDER BY p.name, pv.color;

