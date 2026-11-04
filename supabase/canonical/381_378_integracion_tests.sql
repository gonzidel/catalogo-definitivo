-- 381_378_integracion_tests.sql
--
-- Integración de 378 (tablas de talles) + 380/381 (costos por RPC) tal como las
-- usa el admin integrado. Ejecutar en la MISMA transacción, después de los
-- cuerpos de 378, 380 y 381. Siempre termina en RAISE EXCEPTION
-- ('INTEG TEST OK (n bloques)' o 'INTEG TEST FAIL: ...'): nada persiste.
-- No toca pedidos: sobre orders/order_items solo hay lecturas.

DO $integ$
DECLARE
  v_fail text[] := '{}';
  v_blocks int := 0;
  v_step text;
  v_super uuid;
  v_collab uuid;
  v_customer uuid;
  v_p1 uuid;
  v_p2 uuid;
  v_new uuid;
  v_new_super uuid;
  v_variants uuid[];
  v_res jsonb;
  v_chart_a uuid;
  v_ver_a int;
  v_chart_b uuid;
  v_copy uuid;
  v_ver_copy int;
  v_n bigint;
  v_txt text;
  v_err text;
  v_rows_a jsonb := '[{"size_label":"35","measure_cm":22.5},{"size_label":"36","measure_cm":23}]';
BEGIN
  SELECT a.user_id INTO v_super FROM public.admins a WHERE a.role = 'super_admin' ORDER BY a.user_id LIMIT 1;
  SELECT a.user_id INTO v_collab FROM public.admins a
   WHERE a.role <> 'super_admin' AND public.has_permission(a.user_id, 'products', 'edit')
   ORDER BY a.user_id LIMIT 1;
  SELECT u.id INTO v_customer FROM auth.users u
   WHERE NOT EXISTS (SELECT 1 FROM public.admins a WHERE a.user_id = u.id)
   ORDER BY u.id LIMIT 1;
  SELECT p.id INTO v_p1 FROM public.products p WHERE p.status = 'active' AND p.category = 'Calzado' ORDER BY p.id LIMIT 1;
  SELECT p.id INTO v_p2 FROM public.products p WHERE p.status = 'active' AND p.category = 'Calzado' AND p.id <> v_p1 ORDER BY p.id LIMIT 1;
  SELECT array_agg(id) INTO v_variants FROM (SELECT pv.id FROM public.product_variants pv ORDER BY pv.id LIMIT 5) s;

  IF v_super IS NULL OR v_collab IS NULL OR v_customer IS NULL OR v_p1 IS NULL OR v_p2 IS NULL THEN
    RAISE EXCEPTION 'INTEG TEST FAIL: faltan fixtures (super=%, collab=%, customer=%, p1=%, p2=%)',
      v_super, v_collab, v_customer, v_p1, v_p2;
  END IF;

  -- I1 colaborador: columnas del admin (PRODUCT_ADMIN_COLUMNS) incluyendo size_chart_id
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_collab, 'role', 'authenticated')::text, true);
    SELECT count(*) INTO v_n FROM (
      SELECT id, handle, name, description, status, category, supplier_id, created_at, updated_at,
             last_published_at, publication_status, pack_size, nuevos_ingresos_highlight_at, season,
             target_audience, width_cm, height_cm, length_cm, weight_kg, size_chart_id
        FROM public.products WHERE id IN (v_p1, v_p2)) s;
    IF v_n <> 2 THEN v_fail := v_fail || format('I1 colaborador leyó %s/2 productos', v_n); END IF;
  EXCEPTION WHEN OTHERS THEN
    v_fail := v_fail || ('I1 colaborador select columnas admin: ' || SQLERRM);
  END;
  RESET ROLE;
  v_blocks := v_blocks + 1;

  -- I2 colaborador: crear tabla completa, borrador y duplicado (copia de A)
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_collab, 'role', 'authenticated')::text, true);
  BEGIN
    v_res := public.rpc_admin_save_size_chart(NULL, NULL, 'ZZ ENSAYO INTEG A', 'largo_plantilla', NULL, v_rows_a);
    v_chart_a := (v_res->>'id')::uuid; v_ver_a := (v_res->>'version')::int;
    IF (v_res->>'is_complete')::boolean IS NOT TRUE THEN v_fail := v_fail || 'I2 A no quedó completa'::text; END IF;
    v_res := public.rpc_admin_save_size_chart(NULL, NULL, 'ZZ ENSAYO INTEG B', 'largo_pie', NULL,
      '[{"size_label":"34","measure_cm":null}]'::jsonb);
    v_chart_b := (v_res->>'id')::uuid;
    IF (v_res->>'is_complete')::boolean IS NOT FALSE THEN v_fail := v_fail || 'I2 B no quedó como borrador'::text; END IF;
    v_res := public.rpc_admin_get_size_chart(v_chart_a);
    v_res := public.rpc_admin_save_size_chart(NULL, NULL, 'ZZ ENSAYO INTEG A (copia)', v_res->>'measure_type', v_res->>'notes',
      (SELECT jsonb_agg(jsonb_build_object('size_label', r->>'size_label', 'measure_cm', (r->>'measure_cm')::numeric))
         FROM jsonb_array_elements(v_res->'rows') r));
    v_copy := (v_res->>'id')::uuid; v_ver_copy := (v_res->>'version')::int;
    IF (v_res->>'is_complete')::boolean IS NOT TRUE THEN v_fail := v_fail || 'I2 copia no quedó completa'::text; END IF;
  EXCEPTION WHEN OTHERS THEN
    v_fail := v_fail || ('I2 crear/duplicar tablas: ' || SQLERRM);
  END;
  RESET ROLE;
  v_blocks := v_blocks + 1;

  -- I3 colaborador: asignar A a un producto existente y crear producto con A (payload del admin, sin costos)
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_collab, 'role', 'authenticated')::text, true);
  BEGIN
    UPDATE public.products SET size_chart_id = v_chart_a, updated_at = now() WHERE id = v_p1;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN v_fail := v_fail || format('I3 update size_chart_id filas=%s', v_n); END IF;
    INSERT INTO public.products (category, handle, name, description, status, supplier_id, size_chart_id, created_at)
    VALUES ('Calzado', 'zz-ensayo-integ', 'ZZ ENSAYO INTEG', '', 'draft', NULL, v_chart_a, now())
    RETURNING id INTO v_new;
    SELECT count(*) INTO v_n FROM public.products WHERE id IN (v_p1, v_new) AND size_chart_id = v_chart_a;
    IF v_n <> 2 THEN v_fail := v_fail || format('I3 productos con A = %s/2', v_n); END IF;
  EXCEPTION WHEN OTHERS THEN
    v_fail := v_fail || ('I3 asignar/crear con tabla: ' || SQLERRM);
  END;
  RESET ROLE;
  v_blocks := v_blocks + 1;

  -- I4 colaborador: no puede asignar un borrador
  v_err := NULL;
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_collab, 'role', 'authenticated')::text, true);
    UPDATE public.products SET size_chart_id = v_chart_b WHERE id = v_p2;
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;
  RESET ROLE;
  IF v_err IS NULL OR v_err NOT LIKE 'SIZE_CHART_NOT_ASSIGNABLE%' THEN
    v_fail := v_fail || ('I4 asignar borrador: ' || coalesce(v_err, 'no falló'));
  END IF;
  v_blocks := v_blocks + 1;

  -- I5 colaborador: A en uso no puede quedar incompleta; edición completa sí
  v_err := NULL;
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_collab, 'role', 'authenticated')::text, true);
    PERFORM public.rpc_admin_save_size_chart(v_chart_a, v_ver_a, 'ZZ ENSAYO INTEG A', 'largo_plantilla', NULL,
      '[{"size_label":"35","measure_cm":null}]'::jsonb);
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;
  RESET ROLE;
  IF v_err IS NULL OR v_err NOT LIKE 'SIZE_CHART_%' THEN
    v_fail := v_fail || ('I5 A en uso quedó incompleta: ' || coalesce(v_err, 'no falló'));
  END IF;
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_collab, 'role', 'authenticated')::text, true);
  BEGIN
    v_res := public.rpc_admin_save_size_chart(v_chart_a, v_ver_a, 'ZZ ENSAYO INTEG A', 'largo_plantilla', 'editada',
      '[{"size_label":"35","measure_cm":22.7},{"size_label":"36","measure_cm":23.2}]'::jsonb);
    IF (v_res->>'version')::int <> v_ver_a + 1 THEN v_fail := v_fail || 'I5 versión no avanzó'::text; END IF;
    v_ver_a := (v_res->>'version')::int;
  EXCEPTION WHEN OTHERS THEN
    v_fail := v_fail || ('I5 editar A en uso: ' || SQLERRM);
  END;
  RESET ROLE;
  v_blocks := v_blocks + 1;

  -- I6 colaborador: archivar A conserva asignaciones y bloquea nuevas
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_collab, 'role', 'authenticated')::text, true);
  BEGIN
    v_res := public.rpc_admin_set_size_chart_archived(v_chart_a, v_ver_a, true);
    v_ver_a := (v_res->>'version')::int;
    UPDATE public.products SET name = name, updated_at = now() WHERE id = v_p1;
    SELECT count(*) INTO v_n FROM public.products WHERE id = v_p1 AND size_chart_id = v_chart_a;
    IF v_n <> 1 THEN v_fail := v_fail || 'I6 p1 perdió la tabla archivada'::text; END IF;
  EXCEPTION WHEN OTHERS THEN
    v_fail := v_fail || ('I6 archivar: ' || SQLERRM);
  END;
  RESET ROLE;
  v_err := NULL;
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_collab, 'role', 'authenticated')::text, true);
    UPDATE public.products SET size_chart_id = v_chart_a WHERE id = v_p2;
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;
  RESET ROLE;
  IF v_err IS NULL OR v_err NOT LIKE 'SIZE_CHART_NOT_ASSIGNABLE%' THEN
    v_fail := v_fail || ('I6 asignar archivada: ' || coalesce(v_err, 'no falló'));
  END IF;
  v_blocks := v_blocks + 1;

  -- I7 listado y borrado
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_collab, 'role', 'authenticated')::text, true);
  BEGIN
    SELECT o.products_count INTO v_n FROM public.rpc_admin_size_charts_overview() o WHERE o.id = v_chart_a;
    IF v_n IS DISTINCT FROM 2 THEN v_fail := v_fail || format('I7 overview products_count A = %s', v_n); END IF;
  EXCEPTION WHEN OTHERS THEN
    v_fail := v_fail || ('I7 overview: ' || SQLERRM);
  END;
  RESET ROLE;
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_super, 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM public.rpc_admin_delete_size_chart(v_copy, v_ver_copy);
  EXCEPTION WHEN OTHERS THEN
    v_fail := v_fail || ('I7 borrar copia sin uso: ' || SQLERRM);
  END;
  RESET ROLE;
  v_err := NULL;
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_super, 'role', 'authenticated')::text, true);
    PERFORM public.rpc_admin_delete_size_chart(v_chart_a, v_ver_a);
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;
  RESET ROLE;
  IF v_err IS NULL OR v_err NOT LIKE 'SIZE_CHART_%' THEN
    v_fail := v_fail || ('I7 borrar tabla en uso: ' || coalesce(v_err, 'no falló'));
  END IF;
  v_blocks := v_blocks + 1;

  -- I8 cliente: sin acceso a tablas de talles
  v_err := NULL;
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_customer, 'role', 'authenticated')::text, true);
    PERFORM * FROM public.rpc_admin_size_charts_overview();
  EXCEPTION WHEN insufficient_privilege THEN
    v_err := 'ok';
  END;
  RESET ROLE;
  IF v_err IS NULL THEN v_fail := v_fail || 'I8 cliente ejecutó overview'::text; END IF;
  v_err := NULL;
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_customer, 'role', 'authenticated')::text, true);
    PERFORM 1 FROM public.size_charts LIMIT 1;
  EXCEPTION WHEN insufficient_privilege THEN
    v_err := 'ok';
  END;
  RESET ROLE;
  IF v_err IS NULL THEN v_fail := v_fail || 'I8 cliente leyó size_charts'::text; END IF;
  v_blocks := v_blocks + 1;

  -- I9 super_admin: alta sin costo + costo por RPC (flujo del admin integrado)
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_super, 'role', 'authenticated')::text, true);
  BEGIN
    INSERT INTO public.products (category, handle, name, description, status, supplier_id, size_chart_id, created_at)
    VALUES ('Calzado', 'zz-ensayo-integ-super', 'ZZ ENSAYO INTEG SUPER', '', 'draft', NULL, NULL, now())
    RETURNING id INTO v_new_super;
    PERFORM public.rpc_admin_set_product_pricing(v_new_super, 15000, false, 35, 600);
    SELECT count(*) INTO v_n FROM public.rpc_admin_get_product_pricing(ARRAY[v_new_super]) r
     WHERE r.price_percentage = 35 AND r.logistic_amount = 600 AND r.cost = 15000;
    IF v_n <> 1 THEN v_fail := v_fail || 'I9 pricing super no coincide con lo guardado'::text; END IF;
  EXCEPTION WHEN OTHERS THEN
    v_fail := v_fail || ('I9 super alta + costo: ' || SQLERRM);
  END;
  RESET ROLE;
  v_blocks := v_blocks + 1;

  -- I10 colaborador: no lee costos por RPC
  v_err := NULL;
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_collab, 'role', 'authenticated')::text, true);
    PERFORM * FROM public.rpc_admin_get_product_pricing(ARRAY[v_p1]);
  EXCEPTION WHEN insufficient_privilege THEN
    v_err := 'ok';
  END;
  RESET ROLE;
  IF v_err IS NULL THEN v_fail := v_fail || 'I10 colaborador ejecutó rpc_admin_get_product_pricing'::text; END IF;
  v_blocks := v_blocks + 1;

  -- I11 lecturas de catálogo, precios/promos, stock y reservas (anon y cliente), pedidos (solo lectura)
  FOREACH v_txt IN ARRAY ARRAY['anon', 'customer'] LOOP
    BEGIN
      IF v_txt = 'anon' THEN
        SET LOCAL ROLE anon;
        PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
      ELSE
        SET LOCAL ROLE authenticated;
        PERFORM set_config('request.jwt.claims', json_build_object('sub', v_customer, 'role', 'authenticated')::text, true);
      END IF;
      v_step := 'rpc_catalog_public_version';
      PERFORM public.rpc_catalog_public_version();
      v_step := 'fn_sellable_stock_batch';
      PERFORM * FROM public.fn_sellable_stock_batch(v_variants);
      v_step := 'get_effective_price';
      PERFORM public.get_effective_price(v_variants[1], current_date);
      v_step := 'rpc_get_variant_size_reserved';
      PERFORM * FROM public.rpc_get_variant_size_reserved(v_variants);
      IF to_regclass('public.catalog_public_view') IS NOT NULL
         AND has_table_privilege(current_user, 'public.catalog_public_view', 'SELECT') THEN
        v_step := 'catalog_public_view';
        EXECUTE 'SELECT count(*) FROM public.catalog_public_view' INTO v_n;
        IF v_n = 0 THEN v_fail := v_fail || ('I11 ' || v_txt || ' catalog_public_view vacía'); END IF;
      END IF;
      IF v_txt = 'customer' THEN
        v_step := 'orders propios';
        PERFORM count(*) FROM public.orders;
        v_step := 'products columnas públicas';
        PERFORM id, name, status, size_chart_id FROM public.products WHERE id = v_p1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_fail := v_fail || format('I11 %s %s: %s', v_txt, v_step, SQLERRM);
    END;
    RESET ROLE;
  END LOOP;
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_collab, 'role', 'authenticated')::text, true);
    v_step := 'orders + order_items';
    PERFORM o.id, oi.id FROM public.orders o JOIN public.order_items oi ON oi.order_id = o.id LIMIT 50;
    v_step := 'variant_size_warehouse_stock';
    PERFORM count(*) FROM public.variant_size_warehouse_stock;
    v_step := 'color_price_offers';
    PERFORM count(*) FROM public.color_price_offers WHERE status = 'active';
    v_step := 'product_variants + products!inner';
    PERFORM pv.id, p.name FROM public.product_variants pv JOIN public.products p ON p.id = pv.product_id LIMIT 50;
  EXCEPTION WHEN OTHERS THEN
    v_fail := v_fail || format('I11 colaborador %s: %s', v_step, SQLERRM);
  END;
  RESET ROLE;
  v_blocks := v_blocks + 1;

  PERFORM set_config('request.jwt.claims', '', true);

  IF cardinality(v_fail) > 0 THEN
    RAISE EXCEPTION 'INTEG TEST FAIL: %', array_to_string(v_fail, ' | ');
  END IF;
  RAISE EXCEPTION 'INTEG TEST OK (% bloques)', v_blocks;
END
$integ$;
