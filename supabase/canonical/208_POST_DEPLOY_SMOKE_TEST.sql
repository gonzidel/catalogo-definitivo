-- 208_POST_DEPLOY_SMOKE_TEST.sql
--
-- Smoke test POST-DEPLOY para migración 208.
-- Demuestra empíricamente que:
--   - admin sigue funcionando (RPC + select directo)
--   - customer (authenticated NO admin) pierde lectura/escritura
--   - anon pierde lectura/escritura
--   - el trigger 188 sigue escribiendo el ledger (insert vía función SECURITY DEFINER)
--   - las métricas siguen calculándose (RPCs SECURITY DEFINER)
--   - stock-audit.js sigue leyendo el ledger como admin
--
-- READ-ONLY salvo dos bloques marcados como [WRITE TEMPORAL]:
--   * SECCIÓN F.2: probar trigger contra un pedido controlado en STAGING
--     o sobre un pedido recién creado con ROLLBACK.
--   * Todo lo demás se hace en BEGIN…ROLLBACK.
--
-- Cómo usar:
--   1) Aplicar antes la migración 208.
--   2) Podés ejecutar secciones sueltas (A, B, C…) en cualquier orden: ya NO hay
--      tabla temporal; cada bloque calcula admin/customer solo.
--   3) Si no hay customer (customers.id) que no sea admin, la sección C hace SKIP.
--   4) Revisar pestaña Messages / Notices para C, D y B.
--   5) La sección E.1 está comentada: solo descomentar en staging con un order_id real.
--   - Anotar PASS/FAIL al final (checklist H).

-- =============================================================================
-- CONFIG — solo informativo (qué UUID usarían C y D si existen)
-- =============================================================================
SELECT
  (SELECT a.user_id FROM public.admins a ORDER BY 1 LIMIT 1) AS admin_uid,
  (
    SELECT c.id
    FROM public.customers c
    WHERE NOT EXISTS (SELECT 1 FROM public.admins x WHERE x.user_id = c.id)
    ORDER BY 1
    LIMIT 1
  ) AS customer_uid,
  (SELECT a.user_id FROM public.admins a ORDER BY 1 LIMIT 1) IS NULL AS problema_sin_admin,
  (
    SELECT c.id
    FROM public.customers c
    WHERE NOT EXISTS (SELECT 1 FROM public.admins x WHERE x.user_id = c.id)
    ORDER BY 1
    LIMIT 1
  ) IS NULL AS aviso_sin_customer_para_seccion_c;

-- =============================================================================
-- A) VERIFICACIONES DE ESTADO (deben coincidir con lo declarado en 208.sql)
-- =============================================================================
-- A.1) RLS ON en ambas tablas
SELECT
  c.relname AS tabla,
  CASE WHEN c.relrowsecurity THEN 'ON' ELSE 'OFF' END AS rls,
  CASE WHEN c.relforcerowsecurity THEN 'YES' ELSE 'NO' END AS forced
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('order_reserved_qty_released', 'replenishment_learning');
-- PASS: rls=ON en ambas.

-- A.2) Policies admin SELECT presentes
SELECT schemaname, tablename, policyname, roles, cmd
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('order_reserved_qty_released', 'replenishment_learning')
ORDER BY tablename, policyname;
-- PASS: 1 policy SELECT por tabla, role authenticated.

-- A.3) Sin grants a anon
SELECT grantee, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name IN ('order_reserved_qty_released', 'replenishment_learning')
  AND grantee = 'anon';
-- PASS: 0 filas.

-- A.4) Funciones siguen siendo owner postgres con BYPASSRLS
SELECT
  p.proname,
  r.rolname AS owner,
  r.rolbypassrls AS owner_bypasses_rls,
  p.prosecdef AS security_definer
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_roles     r ON r.oid = p.proowner
WHERE n.nspname = 'public'
  AND p.proname IN (
    'release_reserved_qty_for_order',
    'trgfn_orders_release_reserved_qty_on_final_status',
    'metrics_replenishment',
    'metrics_replenishment_effectiveness',
    'metrics_weekly_purchase_plan'
  );
-- PASS: owner=postgres, bypasses_rls=true, security_definer=true en todas.

-- =============================================================================
-- B) ANON debe perder TODO acceso
-- =============================================================================
BEGIN;
SET LOCAL ROLE anon;

-- B.1) Lectura ledger
DO $$
DECLARE v_err text; v_rows int;
BEGIN
  BEGIN
    SELECT count(*) INTO v_rows FROM public.order_reserved_qty_released;
    RAISE NOTICE 'anon SELECT ledger -> rows=% (FAIL: debería fallar)', v_rows;
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    RAISE NOTICE 'anon SELECT ledger -> ERROR (PASS): %', v_err;
  END;
END $$;

-- B.2) Lectura aprendizaje
DO $$
DECLARE v_err text; v_rows int;
BEGIN
  BEGIN
    SELECT count(*) INTO v_rows FROM public.replenishment_learning;
    RAISE NOTICE 'anon SELECT learning -> rows=% (FAIL: debería fallar)', v_rows;
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    RAISE NOTICE 'anon SELECT learning -> ERROR (PASS): %', v_err;
  END;
END $$;

-- B.3) Insert en aprendizaje (intento de envenenamiento)
DO $$
DECLARE v_err text; v_done boolean := false;
BEGIN
  BEGIN
    INSERT INTO public.replenishment_learning (product_id, factor_ajuste, tipo_ajuste, motivo, activo)
    SELECT id, 1.0, 'neutro', '[SMOKE anon]', false FROM public.products LIMIT 1;
    v_done := true;
    RAISE NOTICE 'anon INSERT learning -> inserted (FAIL: no debería)';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    RAISE NOTICE 'anon INSERT learning -> ERROR (PASS): %', v_err;
  END;
END $$;
ROLLBACK;

-- =============================================================================
-- C) CUSTOMER (authenticated NO admin) debe perder acceso
-- =============================================================================
-- Simula JWT de un customer real (customers.id = auth uid) que no esté en admins.
DO $$
DECLARE
  v_customer uuid;
  v_rows int;
BEGIN
  SELECT c.id INTO v_customer
  FROM public.customers c
  WHERE NOT EXISTS (SELECT 1 FROM public.admins x WHERE x.user_id = c.id)
  ORDER BY 1
  LIMIT 1;

  IF v_customer IS NULL THEN
    RAISE NOTICE 'POST sección C: SKIP — no hay fila en customers cuyo id no sea admin (normal si todos los logins son staff).';
    RETURN;
  END IF;

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', v_customer::text, true);

  RAISE NOTICE 'POST C.0 is_admin_check=% (debe ser false)', EXISTS(
    SELECT 1 FROM public.admins WHERE user_id = v_customer
  );

  -- C.1) Lectura ledger
  BEGIN
    SELECT count(*) INTO v_rows FROM public.order_reserved_qty_released;
    RAISE NOTICE 'POST C.1 customer SELECT ledger -> rows=% (PASS si 0)', v_rows;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'POST C.1 customer SELECT ledger -> ERROR (también PASS): %', SQLERRM;
  END;

  -- C.2) Lectura aprendizaje
  BEGIN
    SELECT count(*) INTO v_rows FROM public.replenishment_learning;
    RAISE NOTICE 'POST C.2 customer SELECT learning -> rows=% (PASS si 0)', v_rows;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'POST C.2 customer SELECT learning -> ERROR (también PASS): %', SQLERRM;
  END;

  -- C.3) Insert aprendizaje
  BEGIN
    INSERT INTO public.replenishment_learning (product_id, factor_ajuste, tipo_ajuste, motivo, activo)
    SELECT id, 1.0, 'neutro', '[SMOKE customer]', false FROM public.products LIMIT 1;
    RAISE NOTICE 'POST C.3 customer INSERT learning -> inserted (FAIL)';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'POST C.3 customer INSERT learning -> ERROR (PASS): %', SQLERRM;
  END;

  -- C.4) RPC metrics (debe fallar por is_admin)
  BEGIN
    PERFORM public.metrics_replenishment(
      (current_date - INTERVAL '7 days')::date,
      current_date
    );
    RAISE NOTICE 'POST C.4 customer RPC metrics_replenishment -> OK (FAIL)';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'POST C.4 customer RPC metrics_replenishment -> ERROR (PASS): %', SQLERRM;
  END;
END $$;

-- =============================================================================
-- D) ADMIN debe conservar acceso completo
-- =============================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admins) THEN
    RAISE EXCEPTION 'POST sección D: no hay ningún usuario en public.admins — revisar la base antes de dar por bueno el deploy.';
  END IF;
END $$;

BEGIN;
SET LOCAL ROLE authenticated;
-- Postgres no acepta SET LOCAL ... = (SELECT ...); usar set_config (equivalente a SET LOCAL).
SELECT set_config(
  'request.jwt.claim.sub',
  (SELECT user_id::text FROM public.admins ORDER BY 1 LIMIT 1),
  true
);

-- D.0) Confirmar que el UID está en admins
SELECT EXISTS(
  SELECT 1 FROM public.admins WHERE user_id = (SELECT user_id FROM public.admins ORDER BY 1 LIMIT 1)
) AS is_admin_check;
-- PASS: true.

-- D.1) Lectura del ledger (lo que hace admin/stock-audit.js)
SELECT count(*)::int AS ledger_rows
FROM public.order_reserved_qty_released;
-- PASS: número >= 0 sin error.

SELECT released_at
FROM public.order_reserved_qty_released
ORDER BY released_at DESC NULLS LAST
LIMIT 1;
-- PASS: devuelve null o un timestamp; sin error.

-- D.2) Lectura directa de aprendizaje (admin puede inspeccionar)
SELECT count(*)::int AS rows_total,
       count(*) FILTER (WHERE activo)::int AS rows_active
FROM public.replenishment_learning;
-- PASS: devuelve número sin error.

-- D.3) RPC metrics_replenishment
SELECT json_typeof(public.metrics_replenishment(
  (current_date - INTERVAL '14 days')::date,
  current_date
)) AS payload_type;
-- PASS: 'object'.

-- D.4) RPC metrics_weekly_purchase_plan (depende transitivamente de la tabla)
SELECT json_typeof(public.metrics_weekly_purchase_plan(
  (current_date - INTERVAL '14 days')::date,
  current_date
)) AS payload_type;
-- PASS: 'object'.

-- D.5) RPC metrics_replenishment_effectiveness (LEE + ESCRIBE replenishment_learning)
-- ⚠️ ESTE BLOQUE PERSISTE escrituras dentro de la transacción; ROLLBACK las descarta.
SELECT json_typeof(public.metrics_replenishment_effectiveness(
  (current_date - INTERVAL '7 days')::date,
  current_date
)) AS payload_type;
-- PASS: 'object' y sin error de RLS al insertar/actualizar.
-- (Demuestra que el SECURITY DEFINER bypassa RLS para la escritura.)
ROLLBACK;

-- =============================================================================
-- E) TRIGGER 188 — el ledger sigue creciendo automáticamente
-- =============================================================================
-- Demuestra que release_reserved_qty_for_order (SECURITY DEFINER) sigue
-- escribiendo en order_reserved_qty_released aunque la tabla tenga RLS ON.
--
-- ⚠️ ELEGIR ESTRATEGIA SEGÚN ENTORNO:
--   E.1) STAGING / dev: cambiar el status real de un pedido controlado.
--   E.2) PROD: NO ejecutar este bloque; usar el chequeo pasivo F.

-- E.1) STAGING — descomentar solo con un ORDER_UUID real (no usar en prod tal cual).
/*
BEGIN;
SELECT id, status FROM public.orders WHERE id = '<ORDER_UUID_NO_FINAL>'::uuid;
SELECT count(*) AS ledger_rows_before
FROM public.order_reserved_qty_released
WHERE order_id = '<ORDER_UUID_NO_FINAL>'::uuid;
UPDATE public.orders
SET status = 'sent', updated_at = now()
WHERE id = '<ORDER_UUID_NO_FINAL>'::uuid;
SELECT count(*) AS ledger_rows_after
FROM public.order_reserved_qty_released
WHERE order_id = '<ORDER_UUID_NO_FINAL>'::uuid;
ROLLBACK;
*/

-- =============================================================================
-- F) Validación pasiva en PRODUCCIÓN (sin tocar pedidos)
-- =============================================================================
-- F.1) ¿Hay pedidos pasando a final que ya quedaron en el ledger últimas 24h?
SELECT
  count(*) AS inserts_last_24h,
  max(released_at) AS last_release_at
FROM public.order_reserved_qty_released
WHERE released_at > now() - INTERVAL '24 hours';
-- PASS: si el negocio cerró pedidos en las últimas 24h, debe haber >= 1.
-- Si es 0 y normalmente cierran pedidos, investigar antes de seguir.

-- F.2) ¿Hay pedidos sent recientes SIN fila correspondiente en el ledger?
-- Si aparecen filas aquí, el trigger no se disparó: investigar (ownership o RLS).
SELECT o.id, o.status, o.updated_at
FROM public.orders o
LEFT JOIN public.order_reserved_qty_released l ON l.order_id = o.id
WHERE o.status IN ('sent', 'expired', 'devolución')
  AND o.updated_at > now() - INTERVAL '24 hours'
  AND l.order_id IS NULL
ORDER BY o.updated_at DESC
LIMIT 20;
-- PASS: 0 filas (en condiciones normales). Si aparece algo, comparar contra
-- la baseline PRE-deploy: si el comportamiento es nuevo, hay regresión.

-- =============================================================================
-- G) FRONTEND — checklist manual fuera de SQL
-- =============================================================================
-- G.1) admin/stock-audit.js
--   - Loguear como super_admin o stock_manager.
--   - Cargar el módulo y verificar que la card "Ledger 188" muestra
--     ledger_rows + ledger_last_at sin errores en consola.
--   - PASS: card poblada. FAIL: aparece "ledger_error" o 401/403.

-- G.2) admin/metrics_v2.html (Estadísticas)
--   - Loguear como admin con permisos.
--   - Abrir el dashboard, elegir un rango con ventas reales.
--   - PASS: render de "Reposición urgente", "Reposición media", "Sistema de
--     aprendizaje" sin errores.
--   - FAIL: "Solo administradores pueden acceder a métricas" o RLS error.

-- G.3) client/dashboard.html (CUSTOMER)
--   - Loguear como customer no-admin.
--   - Navegar catálogo, agregar al carrito, ver pedidos. No debería haber
--     llamadas nuevas a las dos tablas; verificar Network tab.
--   - PASS: sin 401/403 nuevos relacionados a stock-audit o metrics.

-- G.4) catalogo.html (ANON)
--   - Abrir en incógnito; navegar catálogo y PDP.
--   - PASS: catálogo público sigue rindiendo; cero peticiones a las dos tablas.

-- =============================================================================
-- H) CHECKLIST FINAL
-- =============================================================================
-- [ ] A.1  RLS=ON en ambas tablas.
-- [ ] A.2  1 policy SELECT/admin por tabla.
-- [ ] A.3  0 grants a anon.
-- [ ] A.4  Owner postgres + BYPASSRLS en las funciones.
-- [ ] B.1  anon SELECT ledger -> error.
-- [ ] B.2  anon SELECT learning -> error.
-- [ ] B.3  anon INSERT learning -> error.
-- [ ] C.1  customer SELECT ledger -> 0 filas o error.
-- [ ] C.2  customer SELECT learning -> 0 filas o error.
-- [ ] C.3  customer INSERT learning -> error.
-- [ ] C.4  customer RPC metrics_replenishment -> error (is_admin()).
-- [ ] D.1  admin SELECT ledger -> número sin error.
-- [ ] D.2  admin SELECT learning -> número sin error.
-- [ ] D.3  admin RPC metrics_replenishment -> 'object'.
-- [ ] D.4  admin RPC metrics_weekly_purchase_plan -> 'object'.
-- [ ] D.5  admin RPC metrics_replenishment_effectiveness -> 'object'.
-- [ ] E.1  Trigger 188 inserta nueva fila al cambiar status (STAGING).
-- [ ] F.1  Ledger sigue creciendo (PROD).
-- [ ] F.2  0 pedidos finales recientes sin fila en ledger (PROD).
-- [ ] G.1  stock-audit card "Ledger 188" muestra datos.
-- [ ] G.2  metrics_v2 renderiza reposición sin errores.
-- [ ] G.3  client dashboard sin 401/403 nuevos.
-- [ ] G.4  catálogo público intacto.
