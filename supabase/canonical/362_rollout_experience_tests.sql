-- 362_rollout_experience_tests.sql
-- Tests funcionales de 362. Corren dentro de una transacción que se revierte:
-- no dejan filas, cambios de config ni contadores.
-- Requiere 362 aplicada. Ejecutar como postgres (el bloque hace SET LOCAL ROLE).
-- La concurrencia (muchas sesiones en paralelo) no se prueba acá: ver la nota
-- docs/FYL-Obsidian/72-NJ-ROLLOUT-FULL-CATALOG-FASE0-2026-09-29.md.

BEGIN;

-- ---------------------------------------------------------------------------
-- A) Privilegios: anon/authenticated sin acceso
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  ASSERT NOT has_function_privilege('anon', 'public.rpc_rollout_resolve(uuid,uuid,text)', 'EXECUTE'),
    'anon no debe ejecutar rpc_rollout_resolve';
  ASSERT NOT has_function_privilege('authenticated', 'public.rpc_rollout_resolve(uuid,uuid,text)', 'EXECUTE'),
    'authenticated no debe ejecutar rpc_rollout_resolve';
  ASSERT NOT has_function_privilege('anon', 'public.rpc_rollout_link_user(uuid,uuid)', 'EXECUTE'),
    'anon no debe ejecutar rpc_rollout_link_user';
  ASSERT NOT has_function_privilege('authenticated', 'public.rpc_rollout_link_user(uuid,uuid)', 'EXECUTE'),
    'authenticated no debe ejecutar rpc_rollout_link_user';
  ASSERT has_function_privilege('service_role', 'public.rpc_rollout_resolve(uuid,uuid,text)', 'EXECUTE'),
    'service_role debe ejecutar rpc_rollout_resolve';

  ASSERT NOT has_table_privilege('anon', 'public.rollout_grants', 'SELECT'), 'anon no lee grants';
  ASSERT NOT has_table_privilege('authenticated', 'public.rollout_grants', 'SELECT'), 'authenticated no lee grants';
  ASSERT NOT has_table_privilege('anon', 'public.rollout_config', 'UPDATE'), 'anon no cambia config';
  ASSERT NOT has_table_privilege('authenticated', 'public.rollout_daily_counter', 'UPDATE'), 'authenticated no toca contador';

  ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.rollout_grants'::regclass), 'RLS grants';
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.rollout_config'::regclass), 'RLS config';
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.rollout_daily_counter'::regclass), 'RLS counter';
END $$;

-- ---------------------------------------------------------------------------
-- B) Seed: todas las cuentas tienen full y ninguna consumió cupo
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM auth.users u
          WHERE NOT EXISTS (SELECT 1 FROM public.rollout_grants g
                            WHERE g.auth_user_id = u.id AND g.revoked_at IS NULL)) = 0,
    'toda cuenta existente debe tener grant';
  ASSERT (SELECT count(*) FROM public.rollout_grants g
          JOIN public.admins a ON a.user_id = g.auth_user_id
          WHERE g.note = 'seed:362' AND g.source = 'tester') = 0,
    'ningún admin/staff clasificado como tester';
  ASSERT (SELECT count(*) FROM public.rollout_grants g
          WHERE g.note = 'seed:362' AND g.source IN ('admin', 'staff')
            AND NOT EXISTS (SELECT 1 FROM public.admins a WHERE a.user_id = g.auth_user_id)) = 0,
    'ninguna clienta clasificada como staff';
  ASSERT (SELECT coalesce(sum(granted), 0) FROM public.rollout_daily_counter) = 0,
    'el seed no consume cupo';
END $$;

-- ---------------------------------------------------------------------------
-- C) Flujo completo como service_role
-- ---------------------------------------------------------------------------
SET LOCAL ROLE service_role;

DO $$
DECLARE
  v1 uuid := '00000000-0000-4000-8000-000000000001';
  v2 uuid := '00000000-0000-4000-8000-000000000002';
  v3 uuid := '00000000-0000-4000-8000-000000000003';
  v4 uuid := '00000000-0000-4000-8000-000000000004';
  v5 uuid := '00000000-0000-4000-8000-000000000005';
  v6 uuid := '00000000-0000-4000-8000-000000000006';
  v7 uuid := '00000000-0000-4000-8000-000000000007';
  v_tester uuid;
  v_admin uuid;
  r jsonb;
  n int;
BEGIN
  SELECT auth_user_id INTO v_tester FROM public.rollout_grants
  WHERE source = 'tester' AND revoked_at IS NULL LIMIT 1;
  SELECT auth_user_id INTO v_admin FROM public.rollout_grants
  WHERE source IN ('admin', 'staff') AND revoked_at IS NULL LIMIT 1;

  -- paused: visitante nuevo → catalog, sin fila
  UPDATE public.rollout_config SET mode = 'paused', daily_quota = 2 WHERE id = 1;
  r := public.rpc_rollout_resolve(v1);
  ASSERT r->>'experience' = 'catalog' AND r->>'reason' = 'paused', 'paused → catalog: ' || r;
  ASSERT (SELECT count(*) FROM public.rollout_grants WHERE visitor_id = v1) = 0, 'catalog no se persiste';

  -- quota=2: dos entran, el tercero no
  UPDATE public.rollout_config SET mode = 'quota' WHERE id = 1;
  r := public.rpc_rollout_resolve(v1);
  ASSERT r->>'experience' = 'full' AND r->>'source' = 'quota', 'v1 quota: ' || r;
  r := public.rpc_rollout_resolve(v2);
  ASSERT r->>'experience' = 'full' AND r->>'source' = 'quota', 'v2 quota: ' || r;
  r := public.rpc_rollout_resolve(v3);
  ASSERT r->>'experience' = 'catalog' AND r->>'reason' = 'quota_full', 'v3 sin cupo: ' || r;

  -- repetir v1 no consume
  r := public.rpc_rollout_resolve(v1);
  ASSERT r->>'reason' = 'existing_grant', 'v1 repetido: ' || r;
  SELECT granted INTO n FROM public.rollout_daily_counter WHERE day = public.fn_rollout_today();
  ASSERT n = 2, 'contador = 2, es ' || n;

  -- tester_link con cupo agotado → full, sin consumir
  r := public.rpc_rollout_resolve(v3, NULL, 'tester_link');
  ASSERT r->>'experience' = 'full' AND r->>'source' = 'tester_link', 'v3 tester_link: ' || r;
  SELECT granted INTO n FROM public.rollout_daily_counter WHERE day = public.fn_rollout_today();
  ASSERT n = 2, 'tester_link no consume, contador ' || n;

  -- login sin grant NO concede full
  UPDATE public.rollout_grants SET revoked_at = now() WHERE auth_user_id = v_tester;
  r := public.rpc_rollout_link_user(v4, v_tester);
  ASSERT r->>'experience' = 'catalog' AND r->>'reason' = 'no_grant', 'login sin grant: ' || r;
  ASSERT (SELECT count(*) FROM public.rollout_grants WHERE visitor_id = v4 OR (auth_user_id = v_tester AND revoked_at IS NULL)) = 0,
    'login sin grant no crea filas';

  -- visitante seleccionado se registra después → la cuenta hereda el grant
  r := public.rpc_rollout_link_user(v2, v_tester);
  ASSERT r->>'experience' = 'full' AND r->>'source' = 'quota', 'link hereda: ' || r;
  ASSERT (SELECT auth_user_id FROM public.rollout_grants WHERE visitor_id = v2 AND revoked_at IS NULL) = v_tester,
    'grant de v2 vinculado a la cuenta';

  -- otro dispositivo de la misma cuenta → full por cuenta, sin consumir
  r := public.rpc_rollout_resolve(v5, v_tester);
  ASSERT r->>'experience' = 'full' AND r->>'reason' = 'existing_grant', 'otro dispositivo: ' || r;
  r := public.rpc_rollout_link_user(v5, v_tester);
  ASSERT r->>'experience' = 'full', 'link desde otro dispositivo: ' || r;
  SELECT granted INTO n FROM public.rollout_daily_counter WHERE day = public.fn_rollout_today();
  ASSERT n = 2, 'otro dispositivo no consume, contador ' || n;

  -- kill: todos catalog, sin borrar nada
  SELECT count(*) INTO n FROM public.rollout_grants WHERE revoked_at IS NULL;
  UPDATE public.rollout_config SET mode = 'kill' WHERE id = 1;
  r := public.rpc_rollout_resolve(v1);
  ASSERT r->>'experience' = 'catalog' AND r->>'reason' = 'kill' AND (r->>'has_grant')::boolean,
    'kill conserva grant: ' || r;
  r := public.rpc_rollout_resolve(v6, NULL, 'tester_link');
  ASSERT r->>'experience' = 'catalog', 'kill no concede tester_link: ' || r;
  ASSERT (SELECT count(*) FROM public.rollout_grants WHERE revoked_at IS NULL) = n, 'kill no borra grants';

  -- salir de kill recupera asignaciones
  UPDATE public.rollout_config SET mode = 'quota' WHERE id = 1;
  r := public.rpc_rollout_resolve(v1);
  ASSERT r->>'experience' = 'full', 'post-kill recupera: ' || r;

  -- open_all: nuevo visitante → full open_all, sin consumir
  UPDATE public.rollout_config SET mode = 'open_all' WHERE id = 1;
  r := public.rpc_rollout_resolve(v6);
  ASSERT r->>'experience' = 'full' AND r->>'source' = 'open_all', 'open_all: ' || r;
  SELECT granted INTO n FROM public.rollout_daily_counter WHERE day = public.fn_rollout_today();
  ASSERT n = 2, 'open_all no consume, contador ' || n;

  -- staff verificado sin grant (p.ej. alta nueva en admins) → full staff/admin
  UPDATE public.rollout_config SET mode = 'paused' WHERE id = 1;
  UPDATE public.rollout_grants SET revoked_at = now() WHERE auth_user_id = v_admin;
  r := public.rpc_rollout_link_user(v7, v_admin);
  ASSERT r->>'experience' = 'full' AND r->>'source' IN ('admin', 'staff'), 'staff login: ' || r;

  -- contador == grants quota del día
  ASSERT (SELECT granted FROM public.rollout_daily_counter WHERE day = public.fn_rollout_today())
       = (SELECT count(*) FROM public.rollout_grants WHERE source = 'quota' AND grant_day = public.fn_rollout_today()),
    'contador consistente con grants quota';

  -- parámetros inválidos
  BEGIN
    PERFORM public.rpc_rollout_resolve(NULL);
    ASSERT false, 'visitor NULL debe fallar';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.rpc_rollout_resolve(v1, NULL, 'quota');
    ASSERT false, 'hint distinto de tester_link debe fallar';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;

  RAISE NOTICE '362 tests OK';
END $$;

ROLLBACK;
