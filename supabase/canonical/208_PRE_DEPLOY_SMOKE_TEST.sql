-- 208_PRE_DEPLOY_SMOKE_TEST.sql
--
-- Smoke test PRE-DEPLOY para migración 208.
-- READ-ONLY: ningún bloque modifica datos ni esquema.
--
-- Objetivo:
--   1) Confirmar el estado actual exacto de ambas tablas (RLS, grants, policies).
--   2) Confirmar ownership y atributos de las funciones SECURITY DEFINER que
--      dependen de ellas (deben ser owner postgres con BYPASSRLS).
--   3) Demostrar empíricamente que hoy anon y authenticated pueden ver/escribir
--      lo que no deberían — base de comparación para el smoke test POST-deploy.
--
-- Cómo usar:
--   - Pegar bloque por bloque en el SQL Editor de Supabase (entorno de control).
--   - Anotar cada salida en el checklist al final.
--   - NO modifica nada; los pocos bloques que prueban escritura usan ROLLBACK.
--
-- IMPORTANTE: Los bloques de simulación de roles usan SET LOCAL ROLE dentro de
-- una transacción que termina con ROLLBACK. No persiste cambios.

-- =============================================================================
-- A) ESTADO DE LAS TABLAS
-- =============================================================================
-- A.1) RLS habilitado/forzado y owner
SELECT
  c.relname                                AS tabla,
  CASE WHEN c.relrowsecurity   THEN 'ON'  ELSE 'OFF' END AS rls,
  CASE WHEN c.relforcerowsecurity THEN 'YES' ELSE 'NO' END AS forced,
  r.rolname                                AS owner,
  r.rolbypassrls                           AS owner_bypasses_rls
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_roles     r ON r.oid = c.relowner
WHERE n.nspname = 'public'
  AND c.relname IN ('order_reserved_qty_released', 'replenishment_learning')
ORDER BY c.relname;

-- ESPERADO PRE-DEPLOY:
--   order_reserved_qty_released : rls OFF (es lo que vamos a arreglar)
--   replenishment_learning      : rls OFF (es lo que vamos a arreglar)

-- A.2) Policies existentes (deberían estar vacías)
SELECT schemaname, tablename, policyname, roles, cmd
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('order_reserved_qty_released', 'replenishment_learning')
ORDER BY tablename, policyname;

-- ESPERADO PRE-DEPLOY: 0 filas.

-- A.3) Grants actuales por rol
SELECT
  grantee,
  table_name,
  privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name IN ('order_reserved_qty_released', 'replenishment_learning')
ORDER BY table_name, grantee, privilege_type;

-- ESPERADO PRE-DEPLOY (mínimo):
--   order_reserved_qty_released:
--     - service_role  : SELECT       (de 188)
--     - authenticated : SELECT       (de 189)
--   replenishment_learning:
--     - PUBLIC/anon/authenticated quizá tengan TODO (defaults).
--     - Esto es el riesgo crítico.

-- =============================================================================
-- B) FUNCIONES Y TRIGGERS DEPENDIENTES
-- =============================================================================
-- B.1) Funciones críticas: owner, SECURITY DEFINER, bypass RLS
SELECT
  p.proname,
  pg_get_function_identity_arguments(p.oid) AS args,
  r.rolname                                  AS owner,
  r.rolbypassrls                             AS owner_bypasses_rls,
  p.prosecdef                                AS security_definer
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_roles     r ON r.oid = p.proowner
WHERE n.nspname = 'public'
  AND p.proname IN (
    'release_reserved_qty_for_order',
    'trgfn_orders_release_reserved_qty_on_final_status',
    'metrics_replenishment',
    'metrics_replenishment_effectiveness',
    'metrics_weekly_purchase_plan',
    'is_admin'
  )
ORDER BY p.proname;

-- ESPERADO:
--   Todas con prosecdef = true.
--   Todas owner = postgres con rolbypassrls = true.
--   Si alguna NO es postgres, marcar como BLOQUEANTE: tras 208, RLS se aplicaría
--   con el rol de la función y rompería el trigger / la RPC.

-- B.2) Trigger sobre orders
SELECT
  t.tgname,
  c.relname AS on_table,
  CASE t.tgenabled
    WHEN 'O' THEN 'enabled'
    WHEN 'D' THEN 'disabled'
    WHEN 'R' THEN 'replica'
    WHEN 'A' THEN 'always'
    ELSE t.tgenabled::text
  END AS enabled_label,
  pg_get_triggerdef(t.oid, true) AS trigger_def
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = 'orders'
  AND NOT t.tgisinternal
  AND t.tgname = 'trg_orders_release_reserved_qty_on_final_status';

-- ESPERADO: 1 fila, enabled_label = 'enabled'.

-- B.3) Grants EXECUTE de las RPCs (deben estar abiertos a authenticated)
SELECT
  p.oid::regprocedure                                         AS function_signature,
  has_function_privilege('anon',          p.oid, 'EXECUTE')   AS anon_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE')   AS auth_execute,
  has_function_privilege('service_role',  p.oid, 'EXECUTE')   AS service_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'metrics_replenishment',
    'metrics_replenishment_effectiveness',
    'metrics_weekly_purchase_plan'
  )
ORDER BY p.proname;

-- ESPERADO:
--   auth_execute = true para las tres (las llama admin/metrics_v2.js).
--   anon_execute = false ideal (no llamadas desde anon).

-- =============================================================================
-- C) PRUEBAS EMPÍRICAS DE EXPOSICIÓN (LOOK BUT DON'T TOUCH)
-- =============================================================================
-- Demuestran qué puede hacer hoy cada rol. Todo se hace dentro de BEGIN/ROLLBACK
-- para no dejar rastro. Los inserts de prueba se borran solos.

-- C.1) Como anon: ¿lee el ledger? ¿lee aprendizaje?
BEGIN;
SET LOCAL ROLE anon;

-- 1) ledger 188
SELECT
  'anon SELECT order_reserved_qty_released' AS escenario,
  count(*)::text                            AS resultado
FROM public.order_reserved_qty_released;

-- 2) tabla aprendizaje
SELECT
  'anon SELECT replenishment_learning'      AS escenario,
  count(*)::text                            AS resultado
FROM public.replenishment_learning;
ROLLBACK;

-- ESPERADO PRE-DEPLOY:
--   replenishment_learning devolverá un count (lectura abierta = riesgo CRÍTICO).
--   order_reserved_qty_released probablemente falle por REVOKE ALL FROM PUBLIC.

-- C.2) Como anon: ¿puede INSERTAR en replenishment_learning?
BEGIN;
SET LOCAL ROLE anon;

-- Probar insert (envenenamiento del modelo). Si pasa, es riesgo crítico.
DO $$
DECLARE
  v_inserted boolean := false;
  v_err text;
BEGIN
  BEGIN
    INSERT INTO public.replenishment_learning (
      product_id, factor_ajuste, tipo_ajuste, motivo, activo
    )
    SELECT id, 1.0, 'neutro', '[SMOKE TEST anon] no aplicar', false
    FROM public.products LIMIT 1;
    v_inserted := true;
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;

  RAISE NOTICE 'anon INSERT replenishment_learning -> inserted=% error=%',
    v_inserted, COALESCE(v_err, 'none');
END $$;
ROLLBACK;

-- ESPERADO PRE-DEPLOY: inserted=true (NO debería poder; demuestra el riesgo).
-- ESPERADO POST-DEPLOY: inserted=false con error de permiso o RLS.

-- C.3) Como authenticated (sin JWT, sin auth.uid()): lectura ledger y aprendizaje
BEGIN;
SET LOCAL ROLE authenticated;

SELECT 'auth SELECT ledger' AS escenario, count(*)::text
FROM public.order_reserved_qty_released;

SELECT 'auth SELECT learning' AS escenario, count(*)::text
FROM public.replenishment_learning;
ROLLBACK;

-- ESPERADO PRE-DEPLOY:
--   ledger: count (GRANT SELECT a authenticated de 189).
--   learning: count (sin RLS, abierto).

-- C.4) Simular CUSTOMER (authenticated NO admin) tras 208 — útil como base
-- Aquí solo se constata que cualquier usuario auth puede hoy leer la tabla.
-- Para una simulación real del CUSTOMER específico hay que correr el bloque
-- equivalente en POST_DEPLOY con su auth.uid().

-- =============================================================================
-- D) RPCs DE MÉTRICAS — Sanity check de admin antes de deploy
-- =============================================================================
-- IMPORTANTE — por qué fallaba D.3 antes:
--   En el SQL Editor la sesión es el rol postgres (o similar). Ahí
--   auth.uid() suele ser NULL, así que public.is_admin() devuelve false y
--   metrics_replenishment() lanza en la línea ~9:
--     RAISE EXCEPTION 'Solo administradores pueden acceder a métricas' (P0001)
--   Eso NO es un fallo de la migración 208 ni de la base: es el guard esperado.
--   Para probar la RPC hay que simular JWT de admin (bloque D.3 opcional).

-- D.1) Conteo actual de filas en el ledger
SELECT count(*)::bigint AS ledger_rows,
       max(released_at) AS last_release_at
FROM public.order_reserved_qty_released;

-- D.2) Conteo actual de filas activas en aprendizaje
--     active_rows=0 y avg_factor=NULL es NORMAL: no hay filas activas aún
--     (tabla vacía o solo inactivas). avg() sin filas devuelve NULL en Postgres.
SELECT
  count(*) FILTER (WHERE activo = true)::int AS active_rows,
  CASE
    WHEN count(*) FILTER (WHERE activo = true) = 0 THEN NULL
    ELSE avg(factor_ajuste) FILTER (WHERE activo = true)::numeric(6, 3)
  END AS avg_factor_active_only,
  count(*)::int AS total_rows_in_table
FROM public.replenishment_learning;

-- D.3) Smoke de metrics_replenishment sin JWT (sesión típica SQL Editor)
--     Debe informar SKIP o PASS según contexto; nunca abortar el script entero.
DO $$
DECLARE
  v_type text;
BEGIN
  BEGIN
    SELECT json_typeof(public.metrics_replenishment(
      (current_date - INTERVAL '14 days')::date,
      current_date
    )) INTO v_type;
    RAISE NOTICE 'D.3 PASS: metrics_replenishment respondió, payload_type=%', v_type;
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN
      IF strpos(lower(SQLERRM), 'administradores') > 0 THEN
        RAISE NOTICE 'D.3 SKIP (esperado): sin JWT, is_admin() es false → %. Ejecutá D.3 opcional con <ADMIN_UID>.', SQLERRM;
      ELSE
        RAISE;
      END IF;
    WHEN OTHERS THEN
      RAISE NOTICE 'D.3 FAIL inesperado (SQLSTATE %): %', SQLSTATE, SQLERRM;
      RAISE;
  END;
END $$;

-- D.3 opcional — descomentar, reemplazar <ADMIN_UUID_REAL> y ejecutar solo este bloque.
--   Obtener UUID: SELECT user_id FROM public.admins LIMIT 1;
/*
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '<ADMIN_UUID_REAL>';

SELECT json_typeof(public.metrics_replenishment(
  (current_date - INTERVAL '14 days')::date,
  current_date
)) AS replenishment_payload_type;

ROLLBACK;
*/

-- =============================================================================
-- E) CHECKLIST PRE-DEPLOY (marcar antes de aplicar 208)
-- =============================================================================
-- [ ] A.1 RLS OFF en ambas tablas (confirmado).
-- [ ] A.2 Cero policies en ambas tablas.
-- [ ] A.3 Grants documentados; replenishment_learning expone más de lo necesario.
-- [ ] B.1 Las 4 funciones SECURITY DEFINER son owner postgres + BYPASSRLS=true.
--         Si ALGUNA es de otro owner, abrir un sub-issue antes de seguir.
-- [ ] B.2 Trigger 188 enabled.
-- [ ] B.3 metrics_replenishment* tienen EXECUTE a authenticated.
-- [ ] C.1 Estado de exposición empírico anotado (baseline).
-- [ ] C.2 anon insert dio inserted=true → confirma riesgo crítico.
-- [ ] D.1/D.2 Snapshot de filas guardado (comparar con POST).
-- [ ] D.3 metrics_replenishment: en SQL Editor ver NOTICE "D.3 SKIP" (normal) O
--         ejecutar D.3 opcional con <ADMIN_UID> y obtener payload_type = object.
