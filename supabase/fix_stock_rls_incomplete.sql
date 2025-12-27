-- Fix RLS policies to allow reading incomplete products in admin stock page
-- Ejecutar en el SQL Editor de Supabase

-- Permitir que usuarios autenticados lean productos con cualquier status (excepto archived)
-- Esto es necesario para que el admin pueda ver productos incompletos en stock.html

-- Primero, eliminar la política existente si solo permite 'active'
DROP POLICY IF EXISTS "auth_select_products" ON public.products;

-- Crear nueva política que permita leer productos con status 'active' o 'incomplete'
CREATE POLICY "auth_select_products" 
ON public.products 
FOR SELECT 
TO authenticated 
USING (status IN ('active', 'incomplete'));

-- También asegurar que se puedan leer variantes de productos incompletos
-- (Las variantes ya deberían ser accesibles, pero por si acaso)
DROP POLICY IF EXISTS "auth_select_variants" ON public.product_variants;

CREATE POLICY "auth_select_variants" 
ON public.product_variants 
FOR SELECT 
TO authenticated 
USING (
  EXISTS (
    SELECT 1 FROM public.products 
    WHERE products.id = product_variants.product_id 
    AND products.status IN ('active', 'incomplete')
  )
);

-- Notificar a PostgREST para recargar el esquema
SELECT pg_notify('pgrst', 'reload schema');

