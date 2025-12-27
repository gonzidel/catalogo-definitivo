-- CORREGIR Políticas RLS para permitir creación de clientes desde admin
-- Ejecuta esto después de 24_solucion_final_completa.sql

-- 1. Ver políticas RLS actuales en customers
SELECT 
    schemaname,
    tablename,
    policyname,
    permissive,
    roles,
    cmd,
    qual,
    with_check
FROM pg_policies
WHERE schemaname = 'public' 
  AND tablename = 'customers'
ORDER BY policyname;

-- 2. Eliminar políticas restrictivas que bloquean INSERT
-- (Mantener solo las que permiten a admins insertar)
DROP POLICY IF EXISTS customers_self_insert ON public.customers;
DROP POLICY IF EXISTS customers_self_upsert ON public.customers;

-- 3. Crear política que permita a admins insertar cualquier cliente
CREATE POLICY customers_admin_insert
ON public.customers
FOR INSERT
TO authenticated
WITH CHECK (
    -- Permitir si es admin
    EXISTS (
        SELECT 1 FROM public.admins 
        WHERE user_id = auth.uid()
    )
    OR
    -- O si el id coincide con el usuario autenticado (para usuarios normales)
    id = auth.uid()
);

-- 4. Crear política que permita a admins ver todos los clientes
DROP POLICY IF EXISTS customers_admin_all ON public.customers;
CREATE POLICY customers_admin_all
ON public.customers
FOR ALL
TO authenticated
USING (
    EXISTS (
        SELECT 1 FROM public.admins 
        WHERE user_id = auth.uid()
    )
    OR
    id = auth.uid()
)
WITH CHECK (
    EXISTS (
        SELECT 1 FROM public.admins 
        WHERE user_id = auth.uid()
    )
    OR
    id = auth.uid()
);

-- 5. Mantener política de SELECT para usuarios normales (si existe, sino crearla)
DROP POLICY IF EXISTS customers_self_select ON public.customers;
CREATE POLICY customers_self_select
ON public.customers
FOR SELECT
TO authenticated
USING (id = auth.uid());

-- 6. Mantener política de UPDATE para usuarios normales
DROP POLICY IF EXISTS customers_self_update ON public.customers;
CREATE POLICY customers_self_update
ON public.customers
FOR UPDATE
TO authenticated
USING (id = auth.uid())
WITH CHECK (id = auth.uid());

-- 7. Verificar que RLS está habilitado
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

-- 8. Verificar políticas finales
SELECT 
    policyname,
    cmd as comando,
    CASE 
        WHEN with_check IS NOT NULL THEN 'WITH CHECK: ' || with_check
        ELSE 'USING: ' || qual
    END as condicion
FROM pg_policies
WHERE schemaname = 'public' 
  AND tablename = 'customers'
ORDER BY policyname;

-- 9. Recargar esquema
SELECT pg_notify('pgrst', 'reload schema');
