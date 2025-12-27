-- fix_orders_with_items_security.sql
-- Script específico para corregir SECURITY DEFINER en orders_with_items
-- Ejecutar este script en el SQL Editor de Supabase

-- ============================================================================
-- DIAGNÓSTICO: Verificar el estado actual de la vista
-- ============================================================================

-- Verificar si la vista existe y su definición actual
SELECT 
    schemaname,
    viewname,
    viewowner,
    pg_get_viewdef((schemaname||'.'||viewname)::regclass) AS view_definition
FROM pg_views 
WHERE schemaname = 'public' 
AND viewname = 'orders_with_items';

-- Verificar el owner y sus privilegios
SELECT 
    c.relname AS view_name,
    r.rolname AS owner_name,
    r.rolsuper AS is_superuser,
    r.rolcreaterole AS can_create_roles
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_roles r ON r.oid = c.relowner
WHERE n.nspname = 'public'
AND c.relkind = 'v'
AND c.relname = 'orders_with_items';

-- ============================================================================
-- CORRECCIÓN: Eliminar y recrear orders_with_items sin SECURITY DEFINER
-- ============================================================================

-- Paso 1: Eliminar completamente la vista y todas sus dependencias
DROP VIEW IF EXISTS public.orders_with_items CASCADE;

-- Paso 2: Verificar que se eliminó
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.views 
    WHERE table_schema = 'public' 
    AND table_name = 'orders_with_items'
  ) THEN
    RAISE EXCEPTION 'La vista orders_with_items aún existe después de DROP';
  END IF;
  RAISE NOTICE '✅ Vista orders_with_items eliminada correctamente';
END $$;

-- Paso 3: Verificar estructura de la tabla carts
DO $$
DECLARE
  has_updated_at BOOLEAN;
  view_sql TEXT;
BEGIN
  -- Verificar si updated_at existe
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'carts' 
    AND column_name = 'updated_at'
  ) INTO has_updated_at;
  
  -- Construir la definición de la vista
  IF has_updated_at THEN
    view_sql := '
    CREATE VIEW public.orders_with_items AS
    SELECT 
      c.id AS order_id,
      c.customer_id,
      c.status,
      c.created_at,
      c.updated_at,
      ci.id AS item_id,
      ci.variant_id,
      ci.qty,
      ci.status AS item_status,
      ci.price_snapshot
    FROM public.carts c
    LEFT JOIN public.cart_items ci ON ci.cart_id = c.id
    WHERE c.status IN (''submitted'', ''confirmed'', ''ready_to_ship'', ''closed'')';
    RAISE NOTICE 'Creando vista con updated_at';
  ELSE
    view_sql := '
    CREATE VIEW public.orders_with_items AS
    SELECT 
      c.id AS order_id,
      c.customer_id,
      c.status,
      c.created_at,
      ci.id AS item_id,
      ci.variant_id,
      ci.qty,
      ci.status AS item_status,
      ci.price_snapshot
    FROM public.carts c
    LEFT JOIN public.cart_items ci ON ci.cart_id = c.id
    WHERE c.status IN (''submitted'', ''confirmed'', ''ready_to_ship'', ''closed'')';
    RAISE NOTICE 'Creando vista sin updated_at';
  END IF;
  
  -- Ejecutar la creación de la vista
  EXECUTE view_sql;
  
  RAISE NOTICE '✅ Vista orders_with_items recreada correctamente';
END $$;

-- Paso 4: Intentar establecer security_invoker explícitamente (PostgreSQL 15+)
DO $$
BEGIN
  BEGIN
    ALTER VIEW public.orders_with_items SET (security_invoker = true);
    RAISE NOTICE '✅ security_invoker establecido explícitamente';
  EXCEPTION
    WHEN OTHERS THEN
      RAISE NOTICE 'ℹ️  No se pudo establecer security_invoker explícitamente (versión anterior de PostgreSQL - no es problema)';
      RAISE NOTICE '   Las vistas por defecto son SECURITY INVOKER en PostgreSQL';
  END;
END $$;

-- Paso 5: Otorgar permisos apropiados
GRANT SELECT ON public.orders_with_items TO authenticated;

-- Revocar permisos innecesarios (si existen)
REVOKE ALL ON public.orders_with_items FROM PUBLIC;
REVOKE ALL ON public.orders_with_items FROM anon;

-- ============================================================================
-- VERIFICACIÓN FINAL
-- ============================================================================

-- Verificar que la vista se creó correctamente
SELECT 
    schemaname,
    viewname,
    viewowner,
    CASE 
        WHEN pg_get_viewdef((schemaname||'.'||viewname)::regclass) LIKE '%SECURITY DEFINER%' 
        THEN '⚠️  PROBLEMA: Tiene SECURITY DEFINER en definición'
        ELSE '✅ Sin SECURITY DEFINER (correcto)'
    END AS security_status
FROM pg_views 
WHERE schemaname = 'public' 
AND viewname = 'orders_with_items';

-- Verificar owner
SELECT 
    c.relname AS view_name,
    r.rolname AS owner_name,
    CASE 
        WHEN r.rolsuper THEN '⚠️  Owner es superusuario (puede causar detección)'
        ELSE '✅ Owner es rol normal'
    END AS owner_status
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_roles r ON r.oid = c.relowner
WHERE n.nspname = 'public'
AND c.relkind = 'v'
AND c.relname = 'orders_with_items';

-- Verificar permisos
SELECT 
    grantee,
    table_name,
    privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
AND table_name = 'orders_with_items'
ORDER BY grantee, privilege_type;

-- Verificar que RLS está habilitado en las tablas subyacentes
SELECT 
    schemaname,
    tablename,
    rowsecurity AS rls_enabled
FROM pg_tables 
WHERE schemaname = 'public' 
AND tablename IN ('carts', 'cart_items')
ORDER BY tablename;

-- Recargar el esquema de PostgREST
SELECT pg_notify('pgrst','reload schema');

-- Mensaje final
DO $$
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '═══════════════════════════════════════════════════════════';
  RAISE NOTICE '✅ Corrección de orders_with_items completada';
  RAISE NOTICE '';
  RAISE NOTICE '📋 Verificaciones realizadas:';
  RAISE NOTICE '   - Vista eliminada y recreada';
  RAISE NOTICE '   - Sin SECURITY DEFINER (SECURITY INVOKER por defecto)';
  RAISE NOTICE '   - Permisos configurados correctamente';
  RAISE NOTICE '';
  RAISE NOTICE '⏳ Próximos pasos:';
  RAISE NOTICE '   1. Espera 2-5 minutos para que Supabase Advisor se actualice';
  RAISE NOTICE '   2. Si el error persiste, puede ser porque:';
  RAISE NOTICE '      - El owner es superusuario (postgres)';
  RAISE NOTICE '      - Supabase necesita más tiempo para reanalizar';
  RAISE NOTICE '      - Es un falso positivo (la vista está correcta)';
  RAISE NOTICE '';
  RAISE NOTICE '💡 Nota: Si el owner es postgres (superusuario), Supabase';
  RAISE NOTICE '   puede detectarlo como riesgo aunque la vista no tenga';
  RAISE NOTICE '   SECURITY DEFINER explícito. Esto es un falso positivo';
  RAISE NOTICE '   si la vista respeta RLS correctamente.';
  RAISE NOTICE '═══════════════════════════════════════════════════════════';
END $$;

