-- 32_diagnose_customers_rls.sql — Diagnóstico de políticas RLS en customers
-- Ejecuta este script para ver qué políticas están activas y si hay problemas

-- 1. Ver todas las políticas actuales en customers
SELECT 
    policyname as "Nombre de Política",
    cmd as "Comando (SELECT/INSERT/UPDATE/DELETE)",
    roles::text as "Roles",
    CASE 
        WHEN qual IS NOT NULL THEN 'USING: ' || qual
        ELSE 'Sin USING'
    END as "Condición USING",
    CASE 
        WHEN with_check IS NOT NULL THEN 'WITH CHECK: ' || with_check
        ELSE 'Sin WITH CHECK'
    END as "Condición WITH CHECK"
FROM pg_policies
WHERE schemaname = 'public' 
  AND tablename = 'customers'
ORDER BY policyname, cmd;

-- 2. Verificar si RLS está habilitado
SELECT 
    tablename,
    rowsecurity as "RLS Habilitado"
FROM pg_tables
WHERE schemaname = 'public' 
  AND tablename = 'customers';

-- 3. Verificar estructura de la tabla (foreign key a auth.users)
SELECT
    tc.constraint_name,
    tc.table_name,
    kcu.column_name,
    ccu.table_name AS foreign_table_name,
    ccu.column_name AS foreign_column_name
FROM information_schema.table_constraints AS tc
JOIN information_schema.key_column_usage AS kcu
  ON tc.constraint_name = kcu.constraint_name
  AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage AS ccu
  ON ccu.constraint_name = tc.constraint_name
  AND ccu.table_schema = tc.table_schema
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_name = 'customers'
  AND tc.table_schema = 'public';

-- 4. Verificar si hay usuarios autenticados en la sesión actual
-- (Esto solo funcionará si estás ejecutando como usuario autenticado)
SELECT 
    auth.uid() as "User ID Actual",
    auth.role() as "Rol Actual",
    CASE 
        WHEN auth.uid() IS NOT NULL THEN 'Usuario autenticado'
        ELSE 'No autenticado'
    END as "Estado de Autenticación";

