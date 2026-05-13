-- 208_rls_hardening_reserved_release_and_replenishment_learning.sql
--
-- Objetivo:
--   Cerrar dos tablas expuestas sin Row Level Security en producción:
--     1) public.order_reserved_qty_released   (ledger creado por 188)
--     2) public.replenishment_learning        (aprendizaje creado por 205)
--
-- Diagnóstico FYL (estático, basado en código del repo):
--
--   order_reserved_qty_released
--     - Escritura: SOLO por public.release_reserved_qty_for_order(uuid,text,text),
--       que es SECURITY DEFINER y es invocada únicamente desde el trigger
--       trg_orders_release_reserved_qty_on_final_status sobre public.orders.
--     - Lectura: SOLO admin/stock-audit.js (count + last released_at).
--       Migración 189 dio GRANT SELECT a authenticated para esta lectura.
--     - No se accede desde frontend público (anon).
--     - 188 ya hizo: REVOKE ALL ... FROM PUBLIC + GRANT SELECT a service_role.
--     - Falta: RLS habilitado + policy que limite SELECT a admins reales.
--
--   replenishment_learning
--     - Escritura: SOLO public.metrics_replenishment_effectiveness(date,date)
--       (SECURITY DEFINER, valida is_admin() al entrar).
--     - Lectura: SOLO public.metrics_replenishment(date,date)
--       (SECURITY DEFINER, valida is_admin()).
--     - 205 NO revocó nada ni habilitó RLS: queda accesible con anon key.
--     - No se accede directamente desde admin/*, client/* ni scripts/* (verificado).
--     - Falta: RLS + revocar anon + policy de admin para eventual lectura directa.
--
-- Compatibilidad con flujos internos:
--   - Las funciones SECURITY DEFINER del proyecto son del rol postgres
--     (que tiene BYPASSRLS), por lo que NO se ven afectadas por RLS.
--     Verificación incluida al final.
--   - service_role tiene BYPASSRLS por diseño en Supabase: tampoco se afecta.
--   - Triggers de 188 son del rol postgres: siguen escribiendo en el ledger.
--   - RPCs de métricas 203/204 son del rol postgres: siguen leyendo/escribiendo
--     en replenishment_learning sin restricción.
--
-- Modelo de policies aplicado (consistente con 151):
--   - SELECT permitido SOLO a authenticated que esté en public.admins.
--   - INSERT/UPDATE/DELETE: SIN policy desde authenticated (cubierto por funciones
--     SECURITY DEFINER del owner postgres, que bypassa RLS).
--   - anon: REVOKE ALL explícito (defensa en profundidad además de RLS).
--   - service_role: sin policy (bypass nativo).
--
-- Idempotente: cada bloque verifica existencia de tabla/policy antes de actuar.
-- Seguro de pegar varias veces en SQL Editor.

-- =============================================================================
-- 1) order_reserved_qty_released
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'order_reserved_qty_released'
  ) THEN
    -- 1.a) Activar RLS (la tabla aún la maneja PostgREST: NO usamos FORCE para
    --      no romper el trigger SECURITY DEFINER en caso de que su owner pierda
    --      BYPASSRLS en algún entorno; las policies igualmente cubren el caso).
    ALTER TABLE public.order_reserved_qty_released ENABLE ROW LEVEL SECURITY;

    -- 1.b) Revocar accesos amplios. SELECT a authenticated se da abajo de forma
    --      controlada (la migración 189 ya lo concedió; lo dejamos explícito).
    REVOKE ALL ON TABLE public.order_reserved_qty_released FROM PUBLIC;
    REVOKE ALL ON TABLE public.order_reserved_qty_released FROM anon;

    -- Reafirmar grants mínimos (idempotente).
    GRANT SELECT ON TABLE public.order_reserved_qty_released TO authenticated;
    GRANT ALL    ON TABLE public.order_reserved_qty_released TO service_role;

    -- 1.c) Policy: solo admins reales pueden leer el ledger.
    --      Sin policies de INSERT/UPDATE/DELETE: queda cerrado a authenticated.
    --      El trigger SECURITY DEFINER (owner postgres) sigue escribiendo.
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'order_reserved_qty_released'
        AND policyname = 'order_reserved_qty_released_admin_select'
    ) THEN
      CREATE POLICY order_reserved_qty_released_admin_select
        ON public.order_reserved_qty_released
        FOR SELECT
        TO authenticated
        USING (
          EXISTS (
            SELECT 1 FROM public.admins
            WHERE user_id = auth.uid()
          )
        );
    END IF;

    RAISE NOTICE 'order_reserved_qty_released: RLS ON + policy admin SELECT';
  ELSE
    RAISE NOTICE 'order_reserved_qty_released: tabla no existe, omitiendo';
  END IF;
END $$;

-- =============================================================================
-- 2) replenishment_learning
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'replenishment_learning'
  ) THEN
    -- 2.a) Activar RLS.
    ALTER TABLE public.replenishment_learning ENABLE ROW LEVEL SECURITY;

    -- 2.b) Revocar accesos amplios. La tabla no debe ser leída ni escrita
    --      por anon bajo ninguna circunstancia.
    REVOKE ALL ON TABLE public.replenishment_learning FROM PUBLIC;
    REVOKE ALL ON TABLE public.replenishment_learning FROM anon;

    -- authenticated mantiene SELECT por si un admin alguna vez quiere inspección
    -- directa desde el panel. La policy de abajo lo restringe a admins.
    GRANT SELECT ON TABLE public.replenishment_learning TO authenticated;
    GRANT ALL    ON TABLE public.replenishment_learning TO service_role;

    -- 2.c) Policy: solo admins reales pueden leer.
    --      Escritura sigue exclusiva de la RPC metrics_replenishment_effectiveness
    --      (SECURITY DEFINER, owner postgres -> bypassa RLS).
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'replenishment_learning'
        AND policyname = 'replenishment_learning_admin_select'
    ) THEN
      CREATE POLICY replenishment_learning_admin_select
        ON public.replenishment_learning
        FOR SELECT
        TO authenticated
        USING (
          EXISTS (
            SELECT 1 FROM public.admins
            WHERE user_id = auth.uid()
          )
        );
    END IF;

    RAISE NOTICE 'replenishment_learning: RLS ON + policy admin SELECT';
  ELSE
    RAISE NOTICE 'replenishment_learning: tabla no existe, omitiendo';
  END IF;
END $$;

-- =============================================================================
-- 3) Verificación post-deploy
-- =============================================================================

-- 3.a) RLS habilitado
SELECT
  c.relname                                AS tabla,
  CASE WHEN c.relrowsecurity   THEN 'ON'  ELSE 'OFF' END AS rls,
  CASE WHEN c.relforcerowsecurity THEN 'YES' ELSE 'NO' END AS forced
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('order_reserved_qty_released', 'replenishment_learning')
ORDER BY c.relname;

-- 3.b) Policies creadas
SELECT
  schemaname,
  tablename,
  policyname,
  roles,
  cmd
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('order_reserved_qty_released', 'replenishment_learning')
ORDER BY tablename, policyname;

-- 3.c) Owners de funciones críticas — deben ser postgres (BYPASSRLS).
--      Si alguna no lo fuera, RLS las afectaría: avisar antes de ALTER OWNER.
SELECT
  p.proname,
  r.rolname            AS owner,
  r.rolbypassrls       AS owner_bypasses_rls,
  p.prosecdef          AS security_definer
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_roles     r ON r.oid = p.proowner
WHERE n.nspname = 'public'
  AND p.proname IN (
    'release_reserved_qty_for_order',
    'trgfn_orders_release_reserved_qty_on_final_status',
    'metrics_replenishment',
    'metrics_replenishment_effectiveness'
  )
ORDER BY p.proname;

-- 3.d) Grants finales sobre las tablas
SELECT
  grantee,
  table_name,
  privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name IN ('order_reserved_qty_released', 'replenishment_learning')
ORDER BY table_name, grantee, privilege_type;

SELECT pg_notify('pgrst', 'reload schema');

-- =============================================================================
-- ROLLBACK (manual, si hiciera falta)
-- =============================================================================
--
-- DROP POLICY IF EXISTS order_reserved_qty_released_admin_select
--   ON public.order_reserved_qty_released;
-- DROP POLICY IF EXISTS replenishment_learning_admin_select
--   ON public.replenishment_learning;
--
-- ALTER TABLE public.order_reserved_qty_released DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.replenishment_learning      DISABLE ROW LEVEL SECURITY;
--
-- GRANT SELECT ON TABLE public.order_reserved_qty_released TO authenticated;
-- (NO restaurar grants a anon: nunca debió tenerlos.)
