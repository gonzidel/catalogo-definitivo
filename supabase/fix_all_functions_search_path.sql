-- fix_all_functions_search_path.sql
-- Script completo para corregir search_path mutable en TODAS las funciones
-- Ejecutar este script en el SQL Editor de Supabase
--
-- Este script agrega SET search_path = public, pg_catalog a todas las funciones
-- que no lo tienen configurado, previniendo vulnerabilidades de seguridad.

-- ============================================================================
-- CORRECCIÓN AUTOMÁTICA: Agregar SET search_path a todas las funciones
-- ============================================================================

DO $$
DECLARE
    func_record RECORD;
    func_oid OID;
    func_name TEXT;
    func_args TEXT;
    sql_stmt TEXT;
    updated_count INT := 0;
    error_count INT := 0;
BEGIN
    -- Obtener todas las funciones en el esquema public que no tienen search_path configurado
    FOR func_record IN
        SELECT 
            p.oid,
            p.proname AS function_name,
            pg_get_function_identity_arguments(p.oid) AS function_args,
            CASE 
                WHEN p.proconfig IS NULL THEN true
                WHEN NOT (array_to_string(p.proconfig, ',') LIKE '%search_path%') THEN true
                ELSE false
            END AS needs_update
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public'
        AND p.prokind = 'f' -- Solo funciones (no procedimientos)
        AND (
            p.proconfig IS NULL 
            OR NOT (array_to_string(p.proconfig, ',') LIKE '%search_path%')
        )
        ORDER BY p.proname
    LOOP
        BEGIN
            -- Construir el nombre completo de la función con argumentos
            func_name := func_record.function_name;
            func_args := func_record.function_args;
            
            -- Obtener la firma completa de la función para ALTER FUNCTION
            -- Necesitamos el nombre con esquema y argumentos
            sql_stmt := format(
                'ALTER FUNCTION public.%I(%s) SET search_path = public, pg_catalog',
                func_name,
                func_args
            );
            
            -- Ejecutar el ALTER FUNCTION
            EXECUTE sql_stmt;
            
            updated_count := updated_count + 1;
            
            RAISE NOTICE '✅ Actualizada: public.%(%)', func_name, func_args;
            
        EXCEPTION
            WHEN OTHERS THEN
                error_count := error_count + 1;
                RAISE WARNING '❌ Error al actualizar public.%(%): %', func_name, func_args, SQLERRM;
        END;
    END LOOP;
    
    RAISE NOTICE '';
    RAISE NOTICE '═══════════════════════════════════════════════════════════';
    RAISE NOTICE 'Resumen de actualización:';
    RAISE NOTICE '  ✅ Funciones actualizadas: %', updated_count;
    RAISE NOTICE '  ❌ Errores: %', error_count;
    RAISE NOTICE '═══════════════════════════════════════════════════════════';
END $$;

-- ============================================================================
-- VERIFICACIÓN: Listar funciones que aún necesitan corrección
-- ============================================================================

SELECT 
    p.proname AS function_name,
    pg_get_function_identity_arguments(p.oid) AS function_args,
    CASE 
        WHEN p.proconfig IS NULL THEN '❌ NO configurado'
        WHEN array_to_string(p.proconfig, ',') LIKE '%search_path%' THEN '✅ Configurado'
        ELSE '⚠️  Otro config'
    END AS search_path_status,
    array_to_string(p.proconfig, ', ') AS current_config
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
AND p.prokind = 'f'
ORDER BY 
    CASE 
        WHEN p.proconfig IS NULL THEN 1
        WHEN array_to_string(p.proconfig, ',') LIKE '%search_path%' THEN 2
        ELSE 3
    END,
    p.proname;

-- ============================================================================
-- NOTA SOBRE PROTECCIÓN DE CONTRASEÑAS FILTRADAS
-- ============================================================================
-- La advertencia sobre "Leaked Password Protection" se configura en:
-- Supabase Dashboard → Authentication → Settings → Password
-- 
-- Activa "Check for compromised passwords" para habilitar la protección
-- contra contraseñas que han sido filtradas (usando HaveIBeenPwned.org)
-- ============================================================================

-- Mensaje final
DO $$
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '✅ Script de corrección de search_path completado';
  RAISE NOTICE '';
  RAISE NOTICE '📝 Próximos pasos:';
  RAISE NOTICE '   1. Revisa la tabla de verificación arriba';
  RAISE NOTICE '   2. Si hay funciones con errores, actualízalas manualmente';
  RAISE NOTICE '   3. Para proteger contraseñas filtradas:';
  RAISE NOTICE '      Dashboard → Authentication → Settings → Password';
  RAISE NOTICE '      → Activar "Check for compromised passwords"';
END $$;

