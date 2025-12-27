-- 31_fix_customers_upsert_rls.sql — Corregir políticas RLS para permitir upsert en customers
-- Este script corrige el error 403 al hacer upsert en la tabla customers
-- IMPORTANTE: Ejecuta este script completo en Supabase SQL Editor

-- 1. Eliminar TODAS las políticas existentes que pueden estar causando conflicto
DROP POLICY IF EXISTS customers_self_insert ON public.customers;
DROP POLICY IF EXISTS customers_self_update ON public.customers;
DROP POLICY IF EXISTS customers_self_upsert ON public.customers;
DROP POLICY IF EXISTS customers_self_select ON public.customers;
DROP POLICY IF EXISTS customers_admin_select ON public.customers;
DROP POLICY IF EXISTS customers_admin_insert ON public.customers;
DROP POLICY IF EXISTS customers_admin_all ON public.customers;
DROP POLICY IF EXISTS customers_admin_manage ON public.customers;
DROP POLICY IF EXISTS customers_admin_update ON public.customers;

-- 2. Crear política de SELECT para usuarios autenticados (solo su propio registro)
CREATE POLICY customers_self_select
ON public.customers
FOR SELECT
TO authenticated
USING (id = auth.uid());

-- 3. Crear política de INSERT para usuarios autenticados (solo su propio registro)
CREATE POLICY customers_self_insert
ON public.customers
FOR INSERT
TO authenticated
WITH CHECK (id = auth.uid());

-- 4. Crear política de UPDATE para usuarios autenticados (solo su propio registro)
CREATE POLICY customers_self_update
ON public.customers
FOR UPDATE
TO authenticated
USING (id = auth.uid())
WITH CHECK (id = auth.uid());

-- 5. Crear política de SELECT para admins (pueden ver todos los clientes)
CREATE POLICY customers_admin_select
ON public.customers
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.admins 
    WHERE user_id = auth.uid()
  )
);

-- 6. Crear política de INSERT para admins (pueden crear cualquier cliente)
CREATE POLICY customers_admin_insert
ON public.customers
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.admins 
    WHERE user_id = auth.uid()
  )
);

-- 7. Crear política de UPDATE para admins (pueden actualizar cualquier cliente)
CREATE POLICY customers_admin_update
ON public.customers
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.admins 
    WHERE user_id = auth.uid()
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.admins 
    WHERE user_id = auth.uid()
  )
);

-- 8. Verificar que RLS está habilitado
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

-- 9. Recargar esquema de PostgREST
SELECT pg_notify('pgrst', 'reload schema');

-- 10. Verificar políticas finales (esto mostrará todas las políticas creadas)
SELECT 
    policyname as "Nombre de Política",
    cmd as "Comando",
    CASE 
        WHEN with_check IS NOT NULL THEN 'WITH CHECK: ' || with_check
        WHEN qual IS NOT NULL THEN 'USING: ' || qual
        ELSE 'Sin condición'
    END as "Condición"
FROM pg_policies
WHERE schemaname = 'public' 
  AND tablename = 'customers'
ORDER BY policyname;
