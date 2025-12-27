-- Script para corregir el problema de variantes con color NULL o vacío
-- Esto puede causar que los productos no aparezcan en catalog_public_view

-- 1. PRIMERO: Ver qué productos tienen variantes con color NULL o vacío
SELECT 
  p.name as producto,
  COUNT(*) as total_variantes,
  COUNT(*) FILTER (WHERE pv.active = true) as variantes_activas,
  COUNT(*) FILTER (WHERE pv.active = true AND (pv.color IS NULL OR pv.color = '')) as sin_color,
  COUNT(*) FILTER (WHERE pv.active = true AND (pv.size IS NULL OR pv.size = '')) as sin_talle
FROM public.products p
JOIN public.product_variants pv ON pv.product_id = p.id
WHERE p.status = 'active'
  AND p.name IN ('422', 'BA300')  -- Cambiar por los productos problemáticos
GROUP BY p.id, p.name;

-- 2. Ver las variantes específicas con problemas
SELECT 
  p.name as producto,
  pv.id as variant_id,
  pv.color,
  pv.size,
  pv.sku,
  pv.active,
  CASE 
    WHEN pv.color IS NULL OR pv.color = '' THEN '⚠️ SIN COLOR'
    ELSE '✓'
  END as problema_color,
  CASE 
    WHEN pv.size IS NULL OR pv.size = '' THEN '⚠️ SIN TALLE'
    ELSE '✓'
  END as problema_talle
FROM public.products p
JOIN public.product_variants pv ON pv.product_id = p.id
WHERE p.status = 'active'
  AND pv.active = true
  AND p.name IN ('422', 'BA300')
  AND (pv.color IS NULL OR pv.color = '' OR pv.size IS NULL OR pv.size = '')
ORDER BY p.name, pv.color, pv.size;

-- 3. CORRECCIÓN: Asignar un color por defecto a variantes sin color
-- ⚠️ IMPORTANTE: Revisa los resultados antes de ejecutar esto
-- Descomenta las líneas que necesites y ajusta el color por defecto

-- Opción A: Asignar "Sin color" a variantes sin color
/*
UPDATE public.product_variants
SET color = 'Sin color'
WHERE (color IS NULL OR color = '')
  AND active = true
  AND product_id IN (
    SELECT id FROM public.products 
    WHERE status = 'active' 
    AND name IN ('422', 'BA300')
  );
*/

-- Opción B: Asignar el color de otra variante del mismo producto
-- (Solo si hay otras variantes con color definido)
/*
UPDATE public.product_variants pv1
SET color = (
  SELECT pv2.color 
  FROM public.product_variants pv2
  WHERE pv2.product_id = pv1.product_id
    AND pv2.active = true
    AND pv2.color IS NOT NULL
    AND pv2.color != ''
  LIMIT 1
)
WHERE (pv1.color IS NULL OR pv1.color = '')
  AND pv1.active = true
  AND pv1.product_id IN (
    SELECT id FROM public.products 
    WHERE status = 'active' 
    AND name IN ('422', 'BA300')
  )
  AND EXISTS (
    SELECT 1 FROM public.product_variants pv2
    WHERE pv2.product_id = pv1.product_id
      AND pv2.active = true
      AND pv2.color IS NOT NULL
      AND pv2.color != ''
  );
*/

-- 4. CORRECCIÓN: Asignar un talle por defecto a variantes sin talle
-- ⚠️ IMPORTANTE: Revisa los resultados antes de ejecutar esto
/*
UPDATE public.product_variants
SET size = 'Único'
WHERE (size IS NULL OR size = '')
  AND active = true
  AND product_id IN (
    SELECT id FROM public.products 
    WHERE status = 'active' 
    AND name IN ('422', 'BA300')
  );
*/

-- 5. Después de corregir, refrescar la vista
SELECT pg_notify('pgrst','reload schema');

-- 6. Verificar que ahora aparecen en la vista
SELECT 
  "Articulo",
  "Categoria",
  "Color",
  "Numeracion",
  "Precio"
FROM public.catalog_public_view
WHERE "Articulo" IN ('422', 'BA300')
ORDER BY "Articulo", "Color";

