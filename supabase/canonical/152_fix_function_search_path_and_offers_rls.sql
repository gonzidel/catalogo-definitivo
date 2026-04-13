-- 152_fix_function_search_path_and_offers_rls.sql
-- Corrige WARNs del linter de seguridad:
--   A) function_search_path_mutable (schema public, alcance global)
--   B) rls_policy_always_true en color_price_offers / promotions / promotion_items
--
-- Objetivo: endurecer seguridad sin romper catalogo, dashboard ni admin.

-- ============================================================================
-- SECCION 1: Fijar search_path en funciones del schema public
-- ============================================================================
DO $$
DECLARE
  r record;
  total_candidates integer := 0;
  updated_count integer := 0;
  failed_count integer := 0;
BEGIN
  FOR r IN
    SELECT
      p.oid,
      n.nspname AS schema_name,
      p.proname AS function_name,
      pg_get_function_identity_arguments(p.oid) AS identity_args,
      p.proconfig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
      AND (
        p.proconfig IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM unnest(p.proconfig) AS cfg
          WHERE cfg LIKE 'search_path=%'
        )
      )
  LOOP
    total_candidates := total_candidates + 1;
    BEGIN
      EXECUTE format(
        'ALTER FUNCTION %I.%I(%s) SET search_path = %L',
        r.schema_name,
        r.function_name,
        r.identity_args,
        'pg_catalog, public'
      );

      updated_count := updated_count + 1;
      RAISE NOTICE 'search_path fijado: %.%(%)', r.schema_name, r.function_name, r.identity_args;
    EXCEPTION
      WHEN OTHERS THEN
        failed_count := failed_count + 1;
        RAISE WARNING 'No se pudo actualizar %.%(%) -> %', r.schema_name, r.function_name, r.identity_args, SQLERRM;
    END;
  END LOOP;

  RAISE NOTICE 'Search path hardening (public): candidatos=% actualizados=% fallidos=%',
    total_candidates, updated_count, failed_count;
END $$;

-- ============================================================================
-- SECCION 2: Endurecer RLS en ofertas/promos sin romper lecturas
-- ============================================================================
ALTER TABLE public.color_price_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promotion_items ENABLE ROW LEVEL SECURITY;

-- --------------------------------------------------------------------------
-- 2a) color_price_offers
-- --------------------------------------------------------------------------
DROP POLICY IF EXISTS authenticated_manage_offers ON public.color_price_offers;
DROP POLICY IF EXISTS authenticated_select_active_offers ON public.color_price_offers;
DROP POLICY IF EXISTS admin_manage_offers ON public.color_price_offers;

-- Mantener lectura activa para anon
DROP POLICY IF EXISTS anon_select_active_offers ON public.color_price_offers;
CREATE POLICY anon_select_active_offers ON public.color_price_offers
  FOR SELECT TO anon
  USING (status = 'active' AND current_date >= start_date AND current_date <= end_date);

-- Asegurar lectura activa para authenticated (dashboard logueado)
CREATE POLICY authenticated_select_active_offers ON public.color_price_offers
  FOR SELECT TO authenticated
  USING (status = 'active' AND current_date >= start_date AND current_date <= end_date);

-- Escritura solo admin
CREATE POLICY admin_manage_offers ON public.color_price_offers
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()));

-- --------------------------------------------------------------------------
-- 2b) promotions
-- --------------------------------------------------------------------------
DROP POLICY IF EXISTS authenticated_manage_promotions ON public.promotions;
DROP POLICY IF EXISTS authenticated_select_active_promotions ON public.promotions;
DROP POLICY IF EXISTS admin_manage_promotions ON public.promotions;

-- Mantener lectura activa para anon
DROP POLICY IF EXISTS anon_select_active_promotions ON public.promotions;
CREATE POLICY anon_select_active_promotions ON public.promotions
  FOR SELECT TO anon
  USING (status = 'active' AND current_date >= start_date AND current_date <= end_date);

-- Asegurar lectura activa para authenticated
CREATE POLICY authenticated_select_active_promotions ON public.promotions
  FOR SELECT TO authenticated
  USING (status = 'active' AND current_date >= start_date AND current_date <= end_date);

-- Escritura solo admin
CREATE POLICY admin_manage_promotions ON public.promotions
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()));

-- --------------------------------------------------------------------------
-- 2c) promotion_items
-- --------------------------------------------------------------------------
DROP POLICY IF EXISTS authenticated_manage_promotion_items ON public.promotion_items;
DROP POLICY IF EXISTS authenticated_select_active_promotion_items ON public.promotion_items;
DROP POLICY IF EXISTS admin_manage_promotion_items ON public.promotion_items;

-- Mantener lectura activa para anon
DROP POLICY IF EXISTS anon_select_active_promotion_items ON public.promotion_items;
CREATE POLICY anon_select_active_promotion_items ON public.promotion_items
  FOR SELECT TO anon
  USING (
    EXISTS (
      SELECT 1
      FROM public.promotions p
      WHERE p.id = promotion_id
        AND p.status = 'active'
        AND current_date >= p.start_date
        AND current_date <= p.end_date
    )
  );

-- Asegurar lectura activa para authenticated
CREATE POLICY authenticated_select_active_promotion_items ON public.promotion_items
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.promotions p
      WHERE p.id = promotion_id
        AND p.status = 'active'
        AND current_date >= p.start_date
        AND current_date <= p.end_date
    )
  );

-- Escritura solo admin
CREATE POLICY admin_manage_promotion_items ON public.promotion_items
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()));

-- ============================================================================
-- SECCION 3: Verificaciones
-- ============================================================================

-- 3a) Funciones de public que siguen sin search_path explicito
SELECT
  n.nspname AS schema_name,
  p.proname AS function_name,
  pg_get_function_identity_arguments(p.oid) AS identity_args
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prokind = 'f'
  AND (
    p.proconfig IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM unnest(p.proconfig) AS cfg
      WHERE cfg LIKE 'search_path=%'
    )
  )
ORDER BY 1, 2, 3;

-- 3b) Estado RLS en tablas objetivo
SELECT
  c.relname AS table_name,
  CASE WHEN c.relrowsecurity THEN 'RLS ON' ELSE 'RLS OFF' END AS rls_status
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('color_price_offers', 'promotions', 'promotion_items')
ORDER BY c.relname;

-- 3c) Policies finales en tablas objetivo
SELECT
  schemaname,
  tablename,
  policyname,
  cmd,
  roles,
  qual AS using_expr,
  with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('color_price_offers', 'promotions', 'promotion_items')
ORDER BY tablename, policyname;

-- 3d) Deteccion de policies permisivas (no deberia devolver filas)
SELECT
  tablename,
  policyname,
  cmd,
  qual,
  with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('color_price_offers', 'promotions', 'promotion_items')
  AND cmd IN ('ALL', 'INSERT', 'UPDATE', 'DELETE')
  AND (
    lower(coalesce(trim(qual), '')) = 'true'
    OR lower(coalesce(trim(with_check), '')) = 'true'
  )
ORDER BY tablename, policyname;

-- Recargar esquema PostgREST
SELECT pg_notify('pgrst', 'reload schema');

-- ============================================================================
-- SECCION 4: Smoke checklist post-ejecucion (manual)
-- ============================================================================
-- [ ] Admin > offers: crear, editar y eliminar una oferta
-- [ ] Admin > offers: crear, editar y eliminar una promocion
-- [ ] Admin > products: eliminar producto con limpieza de offers/promotion_items
-- [ ] Cliente autenticado (dashboard): sigue leyendo ofertas/promociones activas
-- [ ] Security Advisor: desaparecen WARNs function_search_path_mutable y rls_policy_always_true objetivo
