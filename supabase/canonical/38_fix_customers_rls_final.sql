-- 38_fix_customers_rls_final.sql — Corrección final de políticas RLS para customers
-- Este script elimina todas las políticas problemáticas y las recrea correctamente

-- 1. ELIMINAR TODAS LAS POLÍTICAS EXISTENTES DE CUSTOMERS
-- Esto asegura que no haya conflictos o políticas mal configuradas

DROP POLICY IF EXISTS customers_admin_select ON public.customers;
DROP POLICY IF EXISTS customers_admin_insert ON public.customers;
DROP POLICY IF EXISTS customers_admin_update ON public.customers;
DROP POLICY IF EXISTS customers_self_select ON public.customers;
DROP POLICY IF EXISTS customers_self_insert ON public.customers;
DROP POLICY IF EXISTS customers_self_update ON public.customers;
DROP POLICY IF EXISTS customers_auth_select ON public.customers;
DROP POLICY IF EXISTS customers_auth_update ON public.customers;
DROP POLICY IF EXISTS customers_auth_insert ON public.customers;

-- 2. CREAR POLÍTICAS PARA USUARIOS NORMALES (self)
-- Los usuarios autenticados pueden ver/editar solo su propio perfil

CREATE POLICY customers_self_select
ON public.customers
FOR SELECT
TO authenticated
USING (id = auth.uid());

CREATE POLICY customers_self_insert
ON public.customers
FOR INSERT
TO authenticated
WITH CHECK (id = auth.uid());

CREATE POLICY customers_self_update
ON public.customers
FOR UPDATE
TO authenticated
USING (id = auth.uid())
WITH CHECK (id = auth.uid());

-- 3. CREAR POLÍTICAS PARA ADMINS (SIN RESTRICCIONES ADICIONALES)
-- Los admins pueden ver TODOS los clientes sin restricciones

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

-- Los admins pueden crear CUALQUIER cliente (sin restricción de id = auth.uid())

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

-- Los admins pueden actualizar CUALQUIER cliente (SIN restricción USING adicional)
-- IMPORTANTE: Solo verificar que sea admin, no restringir por customer_id

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

-- 4. Asegurar que RLS está habilitado
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

-- 5. Verificar políticas creadas
SELECT 
    policyname as "Nombre de Política",
    cmd as "Comando",
    CASE 
        WHEN with_check IS NOT NULL THEN 'WITH CHECK: ' || with_check
        ELSE ''
    END as "WITH CHECK",
    CASE 
        WHEN qual IS NOT NULL THEN 'USING: ' || qual
        ELSE ''
    END as "USING"
FROM pg_policies
WHERE schemaname = 'public' 
  AND tablename = 'customers'
ORDER BY 
    CASE 
        WHEN policyname LIKE 'customers_admin%' THEN 1
        WHEN policyname LIKE 'customers_self%' THEN 2
        ELSE 3
    END,
    policyname;

-- 6. Recargar esquema de PostgREST
SELECT pg_notify('pgrst', 'reload schema');

-- 7. Mensaje de confirmación
DO $$
BEGIN
    RAISE NOTICE '✅ Políticas RLS recreadas correctamente';
    RAISE NOTICE '✅ Los admins ahora pueden ver, crear y actualizar TODOS los clientes';
END $$;

