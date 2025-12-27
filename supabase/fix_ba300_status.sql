-- Corregir el status de BA300 de 'incomplete' a 'active'
-- Ejecutar en el SQL Editor de Supabase

UPDATE public.products
SET status = 'active'
WHERE name = 'BA300'
  AND status = 'incomplete';

-- Verificar el cambio
SELECT name, status, category
FROM public.products
WHERE name IN ('BA300', 'P930')
ORDER BY name;

-- Refrescar la vista
SELECT pg_notify('pgrst','reload schema');

