-- 37_diagnose_customers_module.sql — Diagnóstico del módulo de clientes
-- Este script verifica el estado actual de las políticas RLS y la estructura de la tabla

-- 1. Verificar estructura de la tabla customers
SELECT 
    column_name,
    data_type,
    is_nullable,
    column_default
FROM information_schema.columns
WHERE table_schema = 'public' 
  AND table_name = 'customers'
ORDER BY ordinal_position;

-- 2. Verificar restricciones de clave foránea
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
  AND tc.table_name = 'customers';

-- 3. Verificar políticas RLS
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

-- 4. Verificar si RLS está habilitado
SELECT 
    tablename,
    rowsecurity as "RLS Habilitado"
FROM pg_tables
WHERE schemaname = 'public' 
  AND tablename = 'customers';

-- 5. Verificar si existe la columna created_by_admin
SELECT 
    CASE 
        WHEN EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_schema = 'public' 
            AND table_name = 'customers' 
            AND column_name = 'created_by_admin'
        ) THEN '✅ Existe'
        ELSE '❌ No existe'
    END as "Columna created_by_admin";

-- 6. Verificar si existe la función rpc_create_admin_customer
SELECT 
    CASE 
        WHEN EXISTS (
            SELECT 1 FROM pg_proc 
            WHERE proname = 'rpc_create_admin_customer'
            AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
        ) THEN '✅ Existe'
        ELSE '❌ No existe'
    END as "Función rpc_create_admin_customer";

-- 7. Verificar si existe el trigger assign_customer_number_trigger
SELECT 
    CASE 
        WHEN EXISTS (
            SELECT 1 FROM pg_trigger 
            WHERE tgname = 'assign_customer_number_trigger'
        ) THEN '✅ Existe'
        ELSE '❌ No existe'
    END as "Trigger assign_customer_number_trigger";

-- 8. Verificar si existe la función generate_customer_number
SELECT 
    CASE 
        WHEN EXISTS (
            SELECT 1 FROM pg_proc 
            WHERE proname = 'generate_customer_number'
            AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
        ) THEN '✅ Existe'
        ELSE '❌ No existe'
    END as "Función generate_customer_number";

-- 9. Contar clientes existentes
SELECT 
    COUNT(*) as "Total de clientes",
    COUNT(CASE WHEN created_by_admin = true THEN 1 END) as "Creados por admin",
    COUNT(CASE WHEN customer_number IS NOT NULL THEN 1 END) as "Con número de cliente"
FROM public.customers;

-- 10. Verificar usuario actual y si es admin
SELECT 
    auth.uid() as "User ID",
    CASE 
        WHEN EXISTS (
            SELECT 1 FROM public.admins 
            WHERE user_id = auth.uid()
        ) THEN '✅ Es admin'
        ELSE '❌ No es admin'
    END as "Estado de Admin";

-- 11. Verificar permisos de ejecución de la función RPC
SELECT 
    p.proname as "Función",
    r.rolname as "Rol",
    CASE 
        WHEN has_function_privilege(r.oid, p.oid, 'EXECUTE') THEN '✅ Tiene permiso'
        ELSE '❌ Sin permiso'
    END as "Permiso"
FROM pg_proc p
CROSS JOIN pg_roles r
WHERE p.proname = 'rpc_create_admin_customer'
  AND p.pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
  AND r.rolname IN ('authenticated', 'anon', 'service_role')
ORDER BY r.rolname;

