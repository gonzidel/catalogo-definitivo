-- 151_fix_security_linter_alerts.sql
-- Corrige alertas del linter de seguridad de Supabase:
--   A) 9 vistas con SECURITY DEFINER -> SECURITY INVOKER
--   B) 4 tablas publicas sin RLS -> RLS habilitado + policies
--
-- Pre-requisitos verificados:
--   - catalog_public_view: todas las tablas base ya tienen policies anon SELECT
--   - vw_stock_audit_*: todas las tablas base tienen policies authenticated SELECT,
--     EXCEPTO order_item_stock_sources (se corrige aqui antes de cambiar las vistas)
--
-- Seguridad: las funciones RPC (rpc_checkout_cart, rpc_cancel_order_item, etc.)
-- son SECURITY DEFINER y bypasean RLS, no se ven afectadas.

-- ============================================================================
-- SECCION 1: RLS + policies en tablas sin RLS
-- (ANTES de cambiar vistas a security_invoker, porque
--  vw_stock_audit_reference_signals lee order_item_stock_sources)
-- ============================================================================

-- 1a) order_item_stock_sources
--     Lectura: admin/orders.js, admin/public-sales.js (nested select PostgREST)
--     Lectura: vw_stock_audit_reference_signals (JOIN)
--     Escritura: RPCs checkout/cancel (SECURITY DEFINER, bypasean RLS)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'order_item_stock_sources'
  ) THEN
    ALTER TABLE public.order_item_stock_sources ENABLE ROW LEVEL SECURITY;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'order_item_stock_sources'
        AND policyname = 'admin_manage_order_item_stock_sources'
    ) THEN
      CREATE POLICY admin_manage_order_item_stock_sources
        ON public.order_item_stock_sources
        FOR ALL TO authenticated
        USING (EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()))
        WITH CHECK (EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()));
    END IF;

    RAISE NOTICE 'order_item_stock_sources: RLS habilitado + policy admin';
  ELSE
    RAISE NOTICE 'order_item_stock_sources: tabla no existe, omitiendo';
  END IF;
END $$;

-- 1b) order_notifications
--     Escritura: RPCs internos (SECURITY DEFINER, bypasean RLS)
--     Sin acceso JS directo
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'order_notifications'
  ) THEN
    ALTER TABLE public.order_notifications ENABLE ROW LEVEL SECURITY;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'order_notifications'
        AND policyname = 'admin_manage_order_notifications'
    ) THEN
      CREATE POLICY admin_manage_order_notifications
        ON public.order_notifications
        FOR ALL TO authenticated
        USING (EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()))
        WITH CHECK (EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()));
    END IF;

    RAISE NOTICE 'order_notifications: RLS habilitado + policy admin';
  ELSE
    RAISE NOTICE 'order_notifications: tabla no existe, omitiendo';
  END IF;
END $$;

-- 1c) variant_sizes_granularization_staging
--     Solo scripts SQL manuales (batch). Bloqueo total via RLS sin policies.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'variant_sizes_granularization_staging'
  ) THEN
    ALTER TABLE public.variant_sizes_granularization_staging ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.variant_sizes_granularization_staging FORCE ROW LEVEL SECURITY;
    REVOKE ALL ON public.variant_sizes_granularization_staging FROM anon;
    REVOKE ALL ON public.variant_sizes_granularization_staging FROM authenticated;
    RAISE NOTICE 'variant_sizes_granularization_staging: RLS forzado + permisos revocados';
  ELSE
    RAISE NOTICE 'variant_sizes_granularization_staging: tabla no existe, omitiendo';
  END IF;
END $$;

-- 1d) variant_sizes_stock_repair_backup
--     Solo scripts SQL manuales (batch). Bloqueo total via RLS sin policies.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'variant_sizes_stock_repair_backup'
  ) THEN
    ALTER TABLE public.variant_sizes_stock_repair_backup ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.variant_sizes_stock_repair_backup FORCE ROW LEVEL SECURITY;
    REVOKE ALL ON public.variant_sizes_stock_repair_backup FROM anon;
    REVOKE ALL ON public.variant_sizes_stock_repair_backup FROM authenticated;
    RAISE NOTICE 'variant_sizes_stock_repair_backup: RLS forzado + permisos revocados';
  ELSE
    RAISE NOTICE 'variant_sizes_stock_repair_backup: tabla no existe, omitiendo';
  END IF;
END $$;

-- ============================================================================
-- SECCION 2: Cambiar vistas de SECURITY DEFINER a SECURITY INVOKER
-- (Postgres 15+ / Supabase soporta ALTER VIEW ... SET)
-- ============================================================================

DO $$
DECLARE
  v_name text;
BEGIN
  FOR v_name IN
    SELECT unnest(ARRAY[
      'catalog_public_view',
      'vw_stock_audit_snapshot',
      'vw_stock_audit_variant_sizes_diff',
      'vw_stock_audit_variant_warehouse_diff',
      'vw_stock_audit_orphan_size_rows',
      'vw_stock_audit_reference_signals',
      'vw_stock_audit_health_score',
      'vw_stock_audit_release_gate',
      'vw_stock_audit_alerts_current'
    ])
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_views
      WHERE schemaname = 'public' AND viewname = v_name
    ) THEN
      EXECUTE format('ALTER VIEW public.%I SET (security_invoker = true)', v_name);
      RAISE NOTICE '% -> security_invoker = true', v_name;
    ELSE
      RAISE NOTICE '% no existe, omitiendo', v_name;
    END IF;
  END LOOP;
END $$;

-- ============================================================================
-- SECCION 3: Asegurar GRANTs en vistas
-- (security_invoker requiere que el rol tenga SELECT sobre la vista misma)
-- ============================================================================

-- catalog_public_view: lectura publica (anon + authenticated)
GRANT SELECT ON public.catalog_public_view TO anon;
GRANT SELECT ON public.catalog_public_view TO authenticated;

-- Stock audit views: solo authenticated (uso exclusivo admin)
DO $$
DECLARE
  v_name text;
BEGIN
  FOR v_name IN
    SELECT unnest(ARRAY[
      'vw_stock_audit_snapshot',
      'vw_stock_audit_variant_sizes_diff',
      'vw_stock_audit_variant_warehouse_diff',
      'vw_stock_audit_orphan_size_rows',
      'vw_stock_audit_reference_signals',
      'vw_stock_audit_health_score',
      'vw_stock_audit_release_gate',
      'vw_stock_audit_alerts_current'
    ])
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_views
      WHERE schemaname = 'public' AND viewname = v_name
    ) THEN
      EXECUTE format('GRANT SELECT ON public.%I TO authenticated', v_name);
    END IF;
  END LOOP;
END $$;

-- ============================================================================
-- SECCION 4: Verificacion
-- ============================================================================

-- 4a) Verificar security_invoker en las 9 vistas
SELECT
  c.relname AS vista,
  CASE
    WHEN c.reloptions @> ARRAY['security_invoker=true'] THEN 'INVOKER OK'
    ELSE 'REVISAR'
  END AS security_mode
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'v'
  AND c.relname IN (
    'catalog_public_view',
    'vw_stock_audit_snapshot',
    'vw_stock_audit_variant_sizes_diff',
    'vw_stock_audit_variant_warehouse_diff',
    'vw_stock_audit_orphan_size_rows',
    'vw_stock_audit_reference_signals',
    'vw_stock_audit_health_score',
    'vw_stock_audit_release_gate',
    'vw_stock_audit_alerts_current'
  )
ORDER BY c.relname;

-- 4b) Verificar RLS habilitado en las 4 tablas
SELECT
  c.relname AS tabla,
  CASE WHEN c.relrowsecurity THEN 'RLS ON' ELSE 'RLS OFF' END AS rls_status,
  CASE WHEN c.relforcerowsecurity THEN 'FORCED' ELSE '-' END AS force_status
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN (
    'variant_sizes_granularization_staging',
    'variant_sizes_stock_repair_backup',
    'order_notifications',
    'order_item_stock_sources'
  )
ORDER BY c.relname;

-- 4c) Verificar policies creadas
SELECT
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'order_item_stock_sources',
    'order_notifications'
  )
ORDER BY tablename, policyname;

-- Recargar esquema PostgREST
SELECT pg_notify('pgrst', 'reload schema');
