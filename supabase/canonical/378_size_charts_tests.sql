-- 378_size_charts_tests.sql
--
-- A) Funcional. Termina SIEMPRE con RAISE EXCEPTION: nada persiste.
--    Ensayo previo (con autorización): BEGIN; <cuerpo de 378 sin BEGIN/COMMIT>; <bloque A>; ROLLBACK;
--    Esperado: mensaje que empieza con '378 TEST OK'.
--    Usa dos productos existentes solo dentro de la transacción abortada.
-- B) Estructura y seguridad (después de aplicar). Todas las columnas deben dar true.

-- ---------------------------------------------------------------------------
-- A) Funcional
-- ---------------------------------------------------------------------------
DO $test$
DECLARE
  v_super  uuid := (SELECT user_id FROM public.admins WHERE role = 'super_admin' ORDER BY user_id LIMIT 1);
  v_prod1  uuid := (SELECT id FROM public.products WHERE status <> 'archived' ORDER BY id LIMIT 1);
  v_prod2  uuid := (SELECT id FROM public.products WHERE status <> 'archived' ORDER BY id OFFSET 1 LIMIT 1);
  v_res    jsonb;
  v_a      uuid;
  v_b      uuid;
  v_copy   uuid;
  v_ver    integer;
  v_count  integer;
  v_text   text;
  v_errs   text := '';
  v_n      integer := 0;
  v_bad    jsonb;
BEGIN
  IF v_super IS NULL OR v_prod1 IS NULL OR v_prod2 IS NULL THEN
    RAISE EXCEPTION '378 TEST SETUP: falta super_admin o productos';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_super::text, true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_super, 'role', 'authenticated')::text, true);

  -- T1: crear tabla vacía (borrador)
  v_n := v_n + 1;
  v_res := public.rpc_admin_save_size_chart(NULL, NULL, 'TEST378 Horma normal', 'largo_plantilla', NULL, '[]'::jsonb);
  v_a := (v_res->>'id')::uuid;
  IF (v_res->>'version')::int <> 1 OR (v_res->>'is_complete')::boolean THEN
    v_errs := v_errs || 'T1 versión/completitud inesperadas ' || v_res::text || '; ';
  END IF;

  -- T2: filas con normalización y una medida vacía (sigue borrador)
  v_n := v_n + 1;
  v_res := public.rpc_admin_save_size_chart(v_a, 1, '  TEST378   Horma normal ', 'largo_plantilla', ' nota ',
    '[{"size_label":" 35 ","measure_cm":22.5},{"size_label":"35 / 36","measure_cm":null},{"size_label":"37","measure_cm":24.25}]'::jsonb);
  SELECT string_agg(size_label || '=' || coalesce(measure_cm::text, 'null'), ',' ORDER BY position)
    INTO v_text FROM public.size_chart_rows WHERE size_chart_id = v_a;
  IF (v_res->>'version')::int <> 2 OR (v_res->>'is_complete')::boolean
     OR v_text <> '35=22.50,35/36=null,37=24.25'
     OR (SELECT name FROM public.size_charts WHERE id = v_a) <> 'TEST378 Horma normal' THEN
    v_errs := v_errs || 'T2 normalización: ' || coalesce(v_text, 'null') || '; ';
  END IF;

  -- T3: talles duplicados escritos distinto
  v_n := v_n + 1;
  FOREACH v_bad IN ARRAY ARRAY[
    '[{"size_label":"35,5","measure_cm":23},{"size_label":"35.5","measure_cm":23.5}]'::jsonb,
    '[{"size_label":"35/36","measure_cm":23},{"size_label":"35 / 36","measure_cm":23.5}]'::jsonb,
    '[{"size_label":"u","measure_cm":23},{"size_label":"U","measure_cm":23.5}]'::jsonb]
  LOOP
    BEGIN
      PERFORM public.rpc_admin_save_size_chart(v_a, 2, 'TEST378 Horma normal', 'largo_plantilla', NULL, v_bad);
      v_errs := v_errs || 'T3 aceptó duplicado ' || v_bad::text || '; ';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE 'SIZE_CHART_DUPLICATE_SIZE%' THEN v_errs := v_errs || 'T3: ' || SQLERRM || '; '; END IF;
    END;
  END LOOP;

  -- T4: medidas inválidas (3 decimales, fuera de rango, texto con coma)
  v_n := v_n + 1;
  FOREACH v_bad IN ARRAY ARRAY[
    '[{"size_label":"35","measure_cm":22.125}]'::jsonb,
    '[{"size_label":"35","measure_cm":4.99}]'::jsonb,
    '[{"size_label":"35","measure_cm":40.01}]'::jsonb,
    '[{"size_label":"35","measure_cm":"22,5"}]'::jsonb]
  LOOP
    BEGIN
      PERFORM public.rpc_admin_save_size_chart(v_a, 2, 'TEST378 Horma normal', 'largo_plantilla', NULL, v_bad);
      v_errs := v_errs || 'T4 aceptó medida ' || v_bad::text || '; ';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE 'SIZE_CHART_INVALID_MEASURE%' THEN v_errs := v_errs || 'T4: ' || SQLERRM || '; '; END IF;
    END;
  END LOOP;

  -- T5: nombre duplicado (mayúsculas/espacios)
  v_n := v_n + 1;
  BEGIN
    PERFORM public.rpc_admin_save_size_chart(NULL, NULL, 'test378  HORMA normal', 'largo_pie', NULL, '[]'::jsonb);
    v_errs := v_errs || 'T5 aceptó nombre duplicado; ';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'SIZE_CHART_NAME_TAKEN%' THEN v_errs := v_errs || 'T5: ' || SQLERRM || '; '; END IF;
  END;

  -- T6: conflicto de versión
  v_n := v_n + 1;
  BEGIN
    PERFORM public.rpc_admin_save_size_chart(v_a, 1, 'TEST378 Horma normal', 'largo_plantilla', NULL, '[]'::jsonb);
    v_errs := v_errs || 'T6 aceptó versión vieja; ';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'SIZE_CHART_VERSION_CONFLICT%' THEN v_errs := v_errs || 'T6: ' || SQLERRM || '; '; END IF;
  END;

  -- T7: no se puede asignar un borrador
  v_n := v_n + 1;
  BEGIN
    UPDATE public.products SET size_chart_id = v_a WHERE id = v_prod1;
    v_errs := v_errs || 'T7 asignó borrador; ';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'SIZE_CHART_NOT_ASSIGNABLE%' THEN v_errs := v_errs || 'T7: ' || SQLERRM || '; '; END IF;
  END;

  -- T8: completar y asignar
  v_n := v_n + 1;
  v_res := public.rpc_admin_save_size_chart(v_a, 2, 'TEST378 Horma normal', 'largo_plantilla', NULL,
    '[{"size_label":"35","measure_cm":22.5},{"size_label":"36","measure_cm":23},{"size_label":"37","measure_cm":24}]'::jsonb);
  IF NOT (v_res->>'is_complete')::boolean OR (v_res->>'version')::int <> 3 THEN
    v_errs := v_errs || 'T8 no quedó completa v3; ';
  END IF;
  UPDATE public.products SET size_chart_id = v_a WHERE id = v_prod1;

  -- T9: tabla en uso no puede quedar incompleta ni vacía
  v_n := v_n + 1;
  FOREACH v_bad IN ARRAY ARRAY[
    '[{"size_label":"35","measure_cm":null}]'::jsonb,
    '[]'::jsonb]
  LOOP
    BEGIN
      PERFORM public.rpc_admin_save_size_chart(v_a, 3, 'TEST378 Horma normal', 'largo_plantilla', NULL, v_bad);
      v_errs := v_errs || 'T9 dejó incompleta una tabla en uso; ';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE 'SIZE_CHART_IN_USE_INCOMPLETE%' THEN v_errs := v_errs || 'T9: ' || SQLERRM || '; '; END IF;
    END;
  END LOOP;

  -- T10: editar una tabla en uso (completa) está permitido y la ven todos sus productos
  v_n := v_n + 1;
  v_res := public.rpc_admin_save_size_chart(v_a, 3, 'TEST378 Horma normal', 'largo_pie', NULL,
    '[{"size_label":"35","measure_cm":23},{"size_label":"36","measure_cm":23.5},{"size_label":"37","measure_cm":24.5}]'::jsonb);
  IF (v_res->>'products_count')::int <> 1 OR (v_res->>'version')::int <> 4 THEN
    v_errs := v_errs || 'T10 edición en uso ' || v_res::text || '; ';
  END IF;

  -- T11: archivar conserva la asignación; guardar el producto con el mismo valor no falla
  v_n := v_n + 1;
  v_res := public.rpc_admin_set_size_chart_archived(v_a, 4, true);
  BEGIN
    UPDATE public.products SET size_chart_id = size_chart_id, updated_at = updated_at WHERE id = v_prod1;
  EXCEPTION WHEN OTHERS THEN
    v_errs := v_errs || 'T11 guardar producto con tabla archivada falló: ' || SQLERRM || '; ';
  END;
  IF (SELECT size_chart_id FROM public.products WHERE id = v_prod1) IS DISTINCT FROM v_a THEN
    v_errs := v_errs || 'T11 se perdió la asignación; ';
  END IF;

  -- T12: no se puede asignar ni insertar con una tabla archivada
  v_n := v_n + 1;
  BEGIN
    UPDATE public.products SET size_chart_id = v_a WHERE id = v_prod2;
    v_errs := v_errs || 'T12 asignó tabla archivada; ';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'SIZE_CHART_NOT_ASSIGNABLE%' THEN v_errs := v_errs || 'T12a: ' || SQLERRM || '; '; END IF;
  END;
  BEGIN
    INSERT INTO public.products (handle, name, size_chart_id) VALUES ('test378-clon-archivada', 'TEST378 CLON', v_a);
    v_errs := v_errs || 'T12 insertó con tabla archivada; ';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'SIZE_CHART_NOT_ASSIGNABLE%' THEN v_errs := v_errs || 'T12b: ' || SQLERRM || '; '; END IF;
  END;

  -- T13: no se puede eliminar en uso
  v_n := v_n + 1;
  BEGIN
    PERFORM public.rpc_admin_delete_size_chart(v_a, 5);
    v_errs := v_errs || 'T13 eliminó tabla en uso; ';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'SIZE_CHART_IN_USE_DELETE%' THEN v_errs := v_errs || 'T13: ' || SQLERRM || '; '; END IF;
  END;

  -- T14: reactivar, desasignar y eliminar sin uso
  v_n := v_n + 1;
  v_res := public.rpc_admin_set_size_chart_archived(v_a, 5, false);
  UPDATE public.products SET size_chart_id = NULL WHERE id = v_prod1;
  PERFORM public.rpc_admin_delete_size_chart(v_a, 6);
  IF EXISTS (SELECT 1 FROM public.size_charts WHERE id = v_a)
     OR EXISTS (SELECT 1 FROM public.size_chart_rows WHERE size_chart_id = v_a) THEN
    v_errs := v_errs || 'T14 no eliminó tabla y filas; ';
  END IF;
  BEGIN
    PERFORM public.rpc_admin_get_size_chart(v_a);
    v_errs := v_errs || 'T14 get de tabla eliminada no falló; ';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'SIZE_CHART_NOT_FOUND%' THEN v_errs := v_errs || 'T14: ' || SQLERRM || '; '; END IF;
  END;

  -- T15: overview y get informan uso
  v_n := v_n + 1;
  v_res := public.rpc_admin_save_size_chart(NULL, NULL, 'TEST378 Horma chica', 'largo_pie', NULL,
    '[{"size_label":"35/36","measure_cm":22},{"size_label":"37/38","measure_cm":23.5}]'::jsonb);
  v_b := (v_res->>'id')::uuid;
  UPDATE public.products SET size_chart_id = v_b WHERE id = v_prod2;
  SELECT o.products_count INTO v_count FROM public.rpc_admin_size_charts_overview() o WHERE o.id = v_b;
  v_res := public.rpc_admin_get_size_chart(v_b);
  IF v_count <> 1 OR (v_res->>'products_count')::int <> 1 OR NOT (v_res->>'is_complete')::boolean
     OR jsonb_array_length(v_res->'rows') <> 2 THEN
    v_errs := v_errs || 'T15 overview/get ' || coalesce(v_count, -1) || ' ' || v_res::text || '; ';
  END IF;

  -- T16: duplicar (crear con las filas leídas) no afecta la original
  v_n := v_n + 1;
  v_res := public.rpc_admin_save_size_chart(NULL, NULL, 'TEST378 Horma chica (copia)', 'largo_pie', NULL,
    (SELECT jsonb_agg(jsonb_build_object('size_label', e->>'size_label', 'measure_cm', 30))
       FROM jsonb_array_elements(public.rpc_admin_get_size_chart(v_b)->'rows') e));
  v_copy := (v_res->>'id')::uuid;
  IF v_copy = v_b
     OR (SELECT sum(measure_cm) FROM public.size_chart_rows WHERE size_chart_id = v_b) <> 45.5
     OR (SELECT version FROM public.size_charts WHERE id = v_b) <> 1 THEN
    v_errs := v_errs || 'T16 la copia alteró la original; ';
  END IF;

  -- T17: sin permiso (usuario que no es admin) y sin sesión -> 42501
  v_n := v_n + 1;
  FOREACH v_text IN ARRAY ARRAY[gen_random_uuid()::text, ''] LOOP
    PERFORM set_config('request.jwt.claim.sub', v_text, true);
    PERFORM set_config('request.jwt.claims',
      CASE WHEN v_text = '' THEN '' ELSE json_build_object('sub', v_text, 'role', 'authenticated')::text END, true);
    BEGIN
      PERFORM public.rpc_admin_size_charts_overview();
      v_errs := v_errs || 'T17 overview sin permiso; ';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      PERFORM public.rpc_admin_get_size_chart(v_b);
      v_errs := v_errs || 'T17 get sin permiso; ';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      PERFORM public.rpc_admin_save_size_chart(NULL, NULL, 'TEST378 intruso', 'largo_pie', NULL, '[]'::jsonb);
      v_errs := v_errs || 'T17 save sin permiso; ';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      PERFORM public.rpc_admin_set_size_chart_archived(v_b, 1, true);
      v_errs := v_errs || 'T17 archive sin permiso; ';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      PERFORM public.rpc_admin_delete_size_chart(v_copy, 1);
      v_errs := v_errs || 'T17 delete sin permiso; ';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
  END LOOP;

  PERFORM set_config('request.jwt.claim.sub', v_super::text, true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_super, 'role', 'authenticated')::text, true);

  -- T18: privilegios por rol (anon sin EXECUTE; authenticated sin acceso directo a tablas)
  v_n := v_n + 1;
  BEGIN
    EXECUTE 'SET LOCAL ROLE anon';
    PERFORM public.rpc_admin_size_charts_overview();
    v_errs := v_errs || 'T18 anon pudo ejecutar overview; ';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM NOT LIKE 'permission denied for function%' THEN v_errs := v_errs || 'T18a: ' || SQLERRM || '; '; END IF;
  END;
  EXECUTE 'RESET ROLE';

  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM 1 FROM public.size_charts LIMIT 1;
    v_errs := v_errs || 'T18 authenticated leyó size_charts directo; ';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  EXECUTE 'RESET ROLE';

  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM 1 FROM public.size_chart_rows LIMIT 1;
    v_errs := v_errs || 'T18 authenticated leyó size_chart_rows directo; ';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  EXECUTE 'RESET ROLE';

  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    SELECT count(*) INTO v_count FROM public.rpc_admin_size_charts_overview();
    EXECUTE 'RESET ROLE';
    IF v_count < 2 THEN v_errs := v_errs || 'T18 authenticated+admin no vio tablas; '; END IF;
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    v_errs := v_errs || 'T18 authenticated+admin no pudo ejecutar: ' || SQLERRM || '; ';
  END;

  IF v_errs <> '' THEN
    RAISE EXCEPTION '378 TEST FAIL: %', v_errs;
  END IF;
  RAISE EXCEPTION '378 TEST OK (% bloques)', v_n;
END;
$test$;

-- ---------------------------------------------------------------------------
-- B) Estructura y seguridad (después de aplicar). Todo true.
-- ---------------------------------------------------------------------------
SELECT
  -- tablas sin acceso para roles públicos
  NOT has_table_privilege('anon', 'public.size_charts', 'SELECT,INSERT,UPDATE,DELETE')          AS anon_no_size_charts,
  NOT has_table_privilege('anon', 'public.size_chart_rows', 'SELECT,INSERT,UPDATE,DELETE')      AS anon_no_size_chart_rows,
  NOT has_table_privilege('authenticated', 'public.size_charts', 'SELECT,INSERT,UPDATE,DELETE') AS auth_no_size_charts,
  NOT has_table_privilege('authenticated', 'public.size_chart_rows', 'SELECT,INSERT,UPDATE,DELETE') AS auth_no_size_chart_rows,
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.size_charts'::regclass)
    AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.size_chart_rows'::regclass)   AS rls_enabled,
  -- RPC: anon sin EXECUTE, authenticated con EXECUTE
  NOT has_function_privilege('anon', 'public.rpc_admin_size_charts_overview()', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.rpc_admin_get_size_chart(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.rpc_admin_save_size_chart(uuid,integer,text,text,text,jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.rpc_admin_set_size_chart_archived(uuid,integer,boolean)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.rpc_admin_delete_size_chart(uuid,integer)', 'EXECUTE') AS anon_no_rpc,
  has_function_privilege('authenticated', 'public.rpc_admin_size_charts_overview()', 'EXECUTE')
    AND has_function_privilege('authenticated', 'public.rpc_admin_save_size_chart(uuid,integer,text,text,text,jsonb)', 'EXECUTE') AS auth_rpc,
  NOT has_function_privilege('authenticated', 'public.fn_size_chart_assert_permission(text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.fn_size_chart_assert_permission(text)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.fn_products_size_chart_guard()', 'EXECUTE') AS helpers_private,
  -- definer con search_path vacío y owner postgres
  (SELECT bool_and(p.prosecdef AND p.proconfig @> ARRAY['search_path=""'] AND pg_get_userbyid(p.proowner) = 'postgres')
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('rpc_admin_size_charts_overview', 'rpc_admin_get_size_chart', 'rpc_admin_save_size_chart',
                        'rpc_admin_set_size_chart_archived', 'rpc_admin_delete_size_chart',
                        'fn_products_size_chart_guard'))                                       AS definer_search_path_ok,
  -- relación y guard
  EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_size_chart_id_fkey' AND confdeltype = 'r') AS fk_restrict,
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_products_size_chart_guard'
            AND tgrelid = 'public.products'::regclass AND NOT tgisinternal)                    AS guard_trigger,
  -- sin efectos en catálogo y productos existentes
  public.fyl_catalog_snapshot_insert_select_star_ok()                                         AS snapshot_ok,
  NOT EXISTS (SELECT 1 FROM public.products WHERE size_chart_id IS NOT NULL)                   AS no_assignments_yet,
  (SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname = 'trg_catalog_snap_dirty_products')
    NOT LIKE '%size_chart_id%'                                                                 AS snapshot_trigger_untouched;
