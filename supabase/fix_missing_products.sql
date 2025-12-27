-- Script para corregir productos que no aparecen en catalog_public_view
-- EJECUTAR CON PRECAUCIÓN - Revisa los cambios antes de aplicarlos

-- 1. Cambiar status de productos "incomplete" a "active"
-- (Descomenta y ajusta los nombres de productos según necesites)
/*
UPDATE public.products
SET status = 'active'
WHERE status = 'incomplete'
  AND name IN ('P930', 'BA300');  -- Cambiar por los nombres de tus productos
*/

-- 2. Activar variantes inactivas de productos activos
-- (Descomenta y ajusta según necesites)
/*
UPDATE public.product_variants pv
SET active = true
FROM public.products p
WHERE pv.product_id = p.id
  AND p.status = 'active'
  AND pv.active = false
  AND p.name IN ('422', 'BA300');  -- Cambiar por los nombres de tus productos
*/

-- 3. Corregir variantes sin color (asignar un color por defecto)
-- CUIDADO: Esto asigna 'Sin color' a variantes sin color. Ajusta según necesites.
/*
UPDATE public.product_variants
SET color = 'Sin color'
WHERE (color IS NULL OR color = '')
  AND active = true
  AND product_id IN (
    SELECT id FROM public.products WHERE status = 'active'
  );
*/

-- 4. Corregir variantes sin talle (asignar 'Único' por defecto)
-- CUIDADO: Esto asigna 'Único' a variantes sin talle. Ajusta según necesites.
/*
UPDATE public.product_variants
SET size = 'Único'
WHERE (size IS NULL OR size = '')
  AND active = true
  AND product_id IN (
    SELECT id FROM public.products WHERE status = 'active'
  );
*/

-- 5. Refrescar la vista después de hacer cambios
SELECT pg_notify('pgrst','reload schema');

-- 6. Verificar que los cambios funcionaron
SELECT 
  p.name,
  p.status,
  COUNT(pv.id) FILTER (WHERE pv.active = true) as variantes_activas,
  COUNT(pv.id) FILTER (WHERE pv.active = true AND (pv.color IS NULL OR pv.color = '')) as sin_color,
  COUNT(pv.id) FILTER (WHERE pv.active = true AND (pv.size IS NULL OR pv.size = '')) as sin_talle
FROM public.products p
LEFT JOIN public.product_variants pv ON pv.product_id = p.id
WHERE p.name IN ('422', 'BA300', 'P930')  -- Cambiar por los nombres de tus productos
GROUP BY p.id, p.name, p.status;

