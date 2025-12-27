-- Diagnóstico profundo para productos 422 y BA300
-- Ejecutar cada consulta por separado y compartir los resultados

-- CONSULTA 1: Verificar si estos productos aparecen en la vista con diferentes filtros
SELECT 
  'En vista' as fuente,
  "Articulo",
  "Categoria",
  "Color",
  "Numeracion",
  "Precio",
  "Filtro1",
  "Filtro2",
  "Filtro3"
FROM public.catalog_public_view
WHERE "Articulo" IN ('422', 'BA300')
ORDER BY "Articulo", "Color";

-- CONSULTA 2: Simular EXACTAMENTE lo que hace la vista (CTE base)
WITH base_exact AS (
  SELECT
    p.id as product_id,
    p.category as "Categoria",
    p.name as "Articulo",
    coalesce(p.description,'') as "Descripcion",
    pv.color as "Color",
    string_agg(distinct pv.size, ',' order by pv.size) as "Numeracion",
    to_char(coalesce(p.created_at::date, now()::date), 'DD/MM/YYYY') as "FechaIngreso",
    true as "Mostrar",
    'FALSE' as "Oferta",
    min(pv.price)::text as "Precio",
    max(case when vi.position = 1 then vi.url end) as "Imagen Principal",
    max(case when vi.position = 2 then vi.url end) as "Imagen 1",
    max(case when vi.position = 3 then vi.url end) as "Imagen 2",
    max(case when vi.position = 4 then vi.url end) as "Imagen 3",
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
  tag1_id,
  tag2_id,
  tag3_ids
FROM base_exact
ORDER BY "Articulo", "Color";

-- CONSULTA 3: Verificar si hay problemas con los tags que causan que el GROUP BY falle
SELECT 
  p.name,
  p.status,
  p.category,
  pt.tag1_id,
  pt.tag2_id,
  pt.tag3_ids,
  COUNT(DISTINCT pv.id) FILTER (WHERE pv.active = true) as variantes_activas
FROM public.products p
LEFT JOIN public.product_tags pt ON pt.product_id = p.id
LEFT JOIN public.product_variants pv ON pv.product_id = p.id
WHERE p.name IN ('422', 'BA300')
GROUP BY p.id, p.name, p.status, p.category, pt.tag1_id, pt.tag2_id, pt.tag3_ids;

-- CONSULTA 4: Verificar si el problema es con la categoría
SELECT 
  p.name,
  p.category,
  p.status,
  COUNT(DISTINCT pv.id) FILTER (WHERE pv.active = true) as variantes_activas,
  CASE 
    WHEN p.category IS NULL THEN '⚠️ CATEGORÍA NULL'
    WHEN p.category = '' THEN '⚠️ CATEGORÍA VACÍA'
    ELSE '✓'
  END as categoria_check
FROM public.products p
LEFT JOIN public.product_variants pv ON pv.product_id = p.id
WHERE p.name IN ('422', 'BA300')
GROUP BY p.id, p.name, p.category, p.status;

-- CONSULTA 5: Verificar si hay algún problema con el JOIN que está filtrando productos
-- Esta consulta muestra qué pasa si quitamos el filtro de active en el JOIN
SELECT 
  'Con JOIN active=true' as tipo,
  p.name,
  COUNT(DISTINCT pv.id) as variantes
FROM public.products p
JOIN public.product_variants pv ON pv.product_id = p.id AND pv.active = true
WHERE p.status = 'active'
  AND p.name IN ('422', 'BA300')
GROUP BY p.name

UNION ALL

SELECT 
  'Con LEFT JOIN (sin filtro active)' as tipo,
  p.name,
  COUNT(DISTINCT pv.id) as variantes
FROM public.products p
LEFT JOIN public.product_variants pv ON pv.product_id = p.id
WHERE p.status = 'active'
  AND p.name IN ('422', 'BA300')
GROUP BY p.name;

-- CONSULTA 6: Verificar si el problema es con los permisos RLS en la vista
-- Esta consulta intenta acceder directamente a las tablas como lo hace la vista
SELECT 
  p.name,
  p.status,
  pv.active,
  COUNT(*) as count_variants
FROM public.products p
JOIN public.product_variants pv ON pv.product_id = p.id AND pv.active = true
WHERE p.status = 'active'
  AND p.name IN ('422', 'BA300')
GROUP BY p.name, p.status, pv.active;

-- CONSULTA 7: Comparar productos que SÍ aparecen vs los que NO aparecen
WITH productos_activos AS (
  SELECT DISTINCT p.name
  FROM public.products p
  JOIN public.product_variants pv ON pv.product_id = p.id AND pv.active = true
  WHERE p.status = 'active'
),
productos_en_vista AS (
  SELECT DISTINCT "Articulo" as name
  FROM public.catalog_public_view
)
SELECT 
  pa.name,
  CASE WHEN pv.name IS NOT NULL THEN 'APARECE' ELSE 'NO APARECE' END as estado,
  (SELECT category FROM public.products WHERE name = pa.name LIMIT 1) as categoria,
  (SELECT COUNT(*) FROM public.product_variants pv 
   JOIN public.products p ON p.id = pv.product_id 
   WHERE p.name = pa.name AND pv.active = true) as variantes_activas
FROM productos_activos pa
LEFT JOIN productos_en_vista pv ON pv.name = pa.name
WHERE pa.name IN ('422', 'BA300')
ORDER BY estado, pa.name;

