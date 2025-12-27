-- DIAGNÓSTICO COMPLETO: Verificar estado actual
-- Ejecuta esto y comparte los resultados

-- 1. Ver TODAS las constraints en customers (no solo FK)
SELECT 
    conname as nombre_constraint,
    contype as tipo,
    CASE contype
        WHEN 'f' THEN 'Foreign Key'
        WHEN 'p' THEN 'Primary Key'
        WHEN 'u' THEN 'Unique'
        WHEN 'c' THEN 'Check'
        ELSE contype::text
    END as tipo_descripcion,
    pg_get_constraintdef(oid) as definicion
FROM pg_constraint
WHERE conrelid = 'public.customers'::regclass
ORDER BY contype, conname;

-- 2. Verificar si la FK específica existe (debería ser 0)
SELECT 
    COUNT(*) as cantidad_fk_auth_users,
    CASE 
        WHEN COUNT(*) = 0 THEN '✅ NO hay FK hacia auth.users'
        ELSE '❌ AÚN EXISTE FK hacia auth.users'
    END as estado
FROM pg_constraint
WHERE conrelid = 'public.customers'::regclass
  AND contype = 'f'
  AND confrelid = 'auth.users'::regclass;

-- 3. Ver la definición de la tabla customers
SELECT 
    column_name,
    data_type,
    is_nullable,
    column_default
FROM information_schema.columns
WHERE table_schema = 'public' 
  AND table_name = 'customers'
ORDER BY ordinal_position;

-- 4. Verificar si existe la función RPC
SELECT 
    p.proname as nombre_funcion,
    pg_get_function_identity_arguments(p.oid) as argumentos,
    CASE 
        WHEN p.proname IS NOT NULL THEN '✅ Función existe'
        ELSE '❌ Función NO existe'
    END as estado_funcion
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname = 'rpc_create_admin_customer';

-- 5. Ver código fuente de la función (si existe)
SELECT 
    proname,
    prosrc as codigo_fuente
FROM pg_proc 
WHERE proname = 'rpc_create_admin_customer';

-- 6. Ver triggers en customers
SELECT 
    tgname as nombre_trigger,
    tgenabled as habilitado,
    pg_get_triggerdef(oid) as definicion
FROM pg_trigger
WHERE tgrelid = 'public.customers'::regclass
  AND NOT tgisinternal;

-- 7. Verificar si hay otras tablas que referencien customers.id
SELECT
    tc.table_name as tabla_referenciante,
    kcu.column_name as columna_referenciante,
    ccu.table_name AS tabla_referenciada,
    ccu.column_name AS columna_referenciada,
    tc.constraint_name as nombre_constraint
FROM information_schema.table_constraints AS tc
JOIN information_schema.key_column_usage AS kcu
  ON tc.constraint_name = kcu.constraint_name
  AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage AS ccu
  ON ccu.constraint_name = tc.constraint_name
  AND ccu.table_schema = tc.table_schema
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND ccu.table_name = 'customers'
  AND ccu.column_name = 'id';
