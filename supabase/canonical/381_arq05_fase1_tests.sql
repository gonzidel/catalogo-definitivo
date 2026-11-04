-- 381_arq05_fase1_tests.sql
--
-- Ensayo de 380 + 381 en UNA transacción:
--   1. PARTE A (este archivo) ANTES de 380/381: línea base como cliente y
--      como colaborador, guardada en GUCs locales a la transacción.
--   2. Cuerpos de 380 y 381 sin BEGIN/COMMIT/NOTIFY.
--   3. PARTE B (este archivo) DESPUÉS: siempre termina en RAISE EXCEPTION
--      ('381 TEST OK (n bloques)' o '381 TEST FAIL: ...') para forzar ROLLBACK.
-- Escribe solo dentro de la transacción (UPDATE/INSERT de prueba que se revierten).

-- ─── PARTE A: línea base (antes de 380/381) ─────────────────────────────────
DO $baseline$
DECLARE
  v_customer uuid;
  v_collab uuid;
  v_n bigint;
BEGIN
  SELECT u.id INTO v_customer
    FROM auth.users u
   WHERE NOT EXISTS (SELECT 1 FROM public.admins a WHERE a.user_id = u.id)
   ORDER BY u.id
   LIMIT 1;
  SELECT a.user_id INTO v_collab
    FROM public.admins a
   WHERE a.role <> 'super_admin'
   ORDER BY a.user_id
   LIMIT 1;

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_customer, 'role', 'authenticated')::text, true);
  SELECT count(*) INTO v_n FROM public.products;
  PERFORM set_config('arq05f1.customer_products', v_n::text, true);
  IF to_regclass('public.catalog_public_view') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.catalog_public_view' INTO v_n;
    PERFORM set_config('arq05f1.customer_view', v_n::text, true);
  END IF;
  RESET ROLE;

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_collab, 'role', 'authenticated')::text, true);
  SELECT count(*) INTO v_n FROM public.products;
  PERFORM set_config('arq05f1.collab_products', v_n::text, true);
  RESET ROLE;

  PERFORM set_config('request.jwt.claims', '', true);
END
$baseline$;

-- ─── (aplicar aquí los cuerpos de 380 y 381) ───────────────────────────────

-- ─── PARTE B: verificación (después de 380/381) ────────────────────────────
DO $tests$
DECLARE
  v_fail text[] := '{}';
  v_blocks int := 0;
  v_n bigint;
  v_ok boolean;
  v_col text;
  v_super uuid;
  v_collab uuid;
  v_customer uuid;
  v_product uuid;
  v_orig record;
  v_got record;
  v_new_id uuid;
  v_customer_products bigint := nullif(current_setting('arq05f1.customer_products', true), '')::bigint;
  v_customer_view bigint := nullif(current_setting('arq05f1.customer_view', true), '')::bigint;
  v_collab_products bigint := nullif(current_setting('arq05f1.collab_products', true), '')::bigint;
  v_sensitive text[] := ARRAY['cost', 'cost_is_estimated', 'price_percentage', 'logistic_amount'];
  v_public text[] := ARRAY[
    'category', 'created_at', 'description', 'handle', 'height_cm', 'id',
    'last_published_at', 'length_cm', 'name', 'nuevos_ingresos_highlight_at',
    'pack_size', 'publication_status', 'season', 'status', 'supplier_id',
    'target_audience', 'updated_at', 'weight_kg', 'width_cm'
  ];
  v_expected text[];
  v_auth_cols text[];
  v_priv text;
BEGIN
  SELECT a.user_id INTO v_super FROM public.admins a WHERE a.role = 'super_admin' ORDER BY a.user_id LIMIT 1;
  SELECT a.user_id INTO v_collab FROM public.admins a WHERE a.role <> 'super_admin' ORDER BY a.user_id LIMIT 1;
  SELECT u.id INTO v_customer
    FROM auth.users u
   WHERE NOT EXISTS (SELECT 1 FROM public.admins a WHERE a.user_id = u.id)
   ORDER BY u.id
   LIMIT 1;
  SELECT p.id INTO v_product FROM public.products p WHERE p.status = 'active' ORDER BY p.id LIMIT 1;

  IF v_super IS NULL OR v_collab IS NULL OR v_customer IS NULL OR v_product IS NULL THEN
    RAISE EXCEPTION '381 TEST FAIL: faltan fixtures (super=%, collab=%, customer=%, product=%)',
      v_super, v_collab, v_customer, v_product;
  END IF;
  IF v_customer_products IS NULL OR v_collab_products IS NULL THEN
    RAISE EXCEPTION '381 TEST FAIL: falta la línea base (ejecutar PARTE A antes de 380/381)';
  END IF;

  SELECT p.cost, p.cost_is_estimated, p.price_percentage, p.logistic_amount
    INTO v_orig
    FROM public.products p WHERE p.id = v_product;

  -- T1 privilegios de authenticated: sin columnas sensibles en SELECT/INSERT/UPDATE
  FOREACH v_col IN ARRAY v_sensitive LOOP
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE'] LOOP
      IF has_column_privilege('authenticated', 'public.products', v_col, v_priv) THEN
        v_fail := v_fail || format('T1 authenticated tiene %s en products.%s', v_priv, v_col);
      END IF;
    END LOOP;
  END LOOP;
  IF has_table_privilege('authenticated', 'public.products', 'SELECT')
     OR has_table_privilege('authenticated', 'public.products', 'INSERT')
     OR has_table_privilege('authenticated', 'public.products', 'UPDATE') THEN
    v_fail := v_fail || 'T1 authenticated conserva SELECT/INSERT/UPDATE de tabla en products'::text;
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.products', 'DELETE') THEN
    v_fail := v_fail || 'T1 authenticated perdió DELETE en products'::text;
  END IF;
  v_blocks := v_blocks + 1;

  -- T2 authenticated lee exactamente las columnas públicas (+ size_chart_id si existe)
  v_expected := v_public;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'size_chart_id') THEN
    v_expected := v_expected || 'size_chart_id'::text;
  END IF;
  SELECT array_agg(a.attname::text ORDER BY a.attname) INTO v_auth_cols
    FROM pg_attribute a
   WHERE a.attrelid = 'public.products'::regclass
     AND a.attnum > 0
     AND NOT a.attisdropped
     AND has_column_privilege('authenticated', a.attrelid, a.attnum, 'SELECT');
  IF v_auth_cols IS DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(v_expected) x) THEN
    v_fail := v_fail || ('T2 columnas authenticated products = ' || coalesce(v_auth_cols::text, 'NULL'));
  END IF;
  v_blocks := v_blocks + 1;

  -- T3 cliente: no lee costo; lee las mismas filas públicas; catálogo intacto
  v_ok := false;
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_customer, 'role', 'authenticated')::text, true);
    PERFORM p.cost FROM public.products p LIMIT 1;
  EXCEPTION WHEN insufficient_privilege THEN
    v_ok := true;
  END;
  RESET ROLE;
  IF NOT v_ok THEN v_fail := v_fail || 'T3 cliente leyó products.cost'::text; END IF;

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_customer, 'role', 'authenticated')::text, true);
  SELECT count(*) INTO v_n FROM public.products p WHERE p.id IS NOT NULL AND p.name IS NOT NULL;
  IF v_n <> v_customer_products THEN
    v_fail := v_fail || format('T3 cliente products %s <> base %s', v_n, v_customer_products);
  END IF;
  IF v_customer_view IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.catalog_public_view' INTO v_n;
    IF v_n <> v_customer_view THEN
      v_fail := v_fail || format('T3 cliente catalog_public_view %s <> base %s', v_n, v_customer_view);
    END IF;
  END IF;
  RESET ROLE;
  v_blocks := v_blocks + 1;

  -- T4 cliente: RPC de costos rechazadas
  v_ok := false;
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_customer, 'role', 'authenticated')::text, true);
    PERFORM * FROM public.rpc_admin_get_product_pricing(ARRAY[v_product]);
  EXCEPTION WHEN insufficient_privilege THEN
    v_ok := true;
  END;
  RESET ROLE;
  IF NOT v_ok THEN v_fail := v_fail || 'T4 cliente ejecutó rpc_admin_get_product_pricing'::text; END IF;

  v_ok := false;
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_customer, 'role', 'authenticated')::text, true);
    PERFORM public.rpc_admin_set_product_pricing(v_product, 1, false, 1, 1);
  EXCEPTION WHEN insufficient_privilege THEN
    v_ok := true;
  END;
  RESET ROLE;
  IF NOT v_ok THEN v_fail := v_fail || 'T4 cliente ejecutó rpc_admin_set_product_pricing'::text; END IF;
  v_blocks := v_blocks + 1;

  -- T5 colaborador: no lee ni escribe costo (directo ni por RPC)
  v_ok := false;
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_collab, 'role', 'authenticated')::text, true);
    PERFORM p.price_percentage FROM public.products p LIMIT 1;
  EXCEPTION WHEN insufficient_privilege THEN
    v_ok := true;
  END;
  RESET ROLE;
  IF NOT v_ok THEN v_fail := v_fail || 'T5 colaborador leyó products.price_percentage'::text; END IF;

  v_ok := false;
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_collab, 'role', 'authenticated')::text, true);
    UPDATE public.products SET cost = 1 WHERE id = v_product;
  EXCEPTION WHEN insufficient_privilege THEN
    v_ok := true;
  END;
  RESET ROLE;
  IF NOT v_ok THEN v_fail := v_fail || 'T5 colaborador actualizó products.cost'::text; END IF;

  v_ok := false;
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_collab, 'role', 'authenticated')::text, true);
    PERFORM public.rpc_admin_set_product_pricing(v_product, 1, false, 1, 1);
  EXCEPTION WHEN insufficient_privilege THEN
    v_ok := true;
  END;
  RESET ROLE;
  IF NOT v_ok THEN v_fail := v_fail || 'T5 colaborador ejecutó rpc_admin_set_product_pricing'::text; END IF;

  v_ok := false;
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_collab, 'role', 'authenticated')::text, true);
    INSERT INTO public.products (handle, name, category, status, cost)
    VALUES ('arq05-f1-test-cost', 'ARQ05 F1 TEST COST', 'Calzado', 'draft', 1);
  EXCEPTION WHEN insufficient_privilege THEN
    v_ok := true;
  END;
  RESET ROLE;
  IF NOT v_ok THEN v_fail := v_fail || 'T5 colaborador insertó products.cost'::text; END IF;
  v_blocks := v_blocks + 1;

  -- T6 colaborador: funciones administrativas sin costo siguen funcionando
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_collab, 'role', 'authenticated')::text, true);
  SELECT count(*) INTO v_n FROM public.products p WHERE p.id IS NOT NULL;
  IF v_n <> v_collab_products THEN
    v_fail := v_fail || format('T6 colaborador products %s <> base %s', v_n, v_collab_products);
  END IF;
  UPDATE public.products SET name = name, updated_at = now() WHERE id = v_product;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN v_fail := v_fail || format('T6 colaborador update name filas=%s', v_n); END IF;
  INSERT INTO public.products (handle, name, category, status, description, supplier_id)
  VALUES ('arq05-f1-test', 'ARQ05 F1 TEST', 'Calzado', 'draft', '', NULL)
  RETURNING id INTO v_new_id;
  IF v_new_id IS NULL THEN v_fail := v_fail || 'T6 colaborador no pudo insertar producto'::text; END IF;
  RESET ROLE;
  v_blocks := v_blocks + 1;

  -- T7 super_admin: RPC get devuelve los valores reales
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_super, 'role', 'authenticated')::text, true);
  SELECT r.cost, r.cost_is_estimated, r.price_percentage, r.logistic_amount
    INTO v_got
    FROM public.rpc_admin_get_product_pricing(ARRAY[v_product]) r;
  RESET ROLE;
  IF v_got.cost IS DISTINCT FROM v_orig.cost
     OR v_got.cost_is_estimated IS DISTINCT FROM v_orig.cost_is_estimated
     OR v_got.price_percentage IS DISTINCT FROM v_orig.price_percentage
     OR v_got.logistic_amount IS DISTINCT FROM v_orig.logistic_amount THEN
    v_fail := v_fail || 'T7 rpc_admin_get_product_pricing no coincide con products'::text;
  END IF;
  v_blocks := v_blocks + 1;

  -- T8 super_admin: RPC set guarda y get lo devuelve; producto recién creado incluido
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_super, 'role', 'authenticated')::text, true);
  PERFORM public.rpc_admin_set_product_pricing(v_product, 12345.67, true, 41, 777);
  SELECT r.cost, r.cost_is_estimated, r.price_percentage, r.logistic_amount
    INTO v_got
    FROM public.rpc_admin_get_product_pricing(ARRAY[v_product]) r;
  IF v_got.cost <> 12345.67 OR v_got.cost_is_estimated IS NOT TRUE
     OR v_got.price_percentage <> 41 OR v_got.logistic_amount <> 777 THEN
    v_fail := v_fail || 'T8 rpc_admin_set_product_pricing no guardó los valores'::text;
  END IF;
  PERFORM public.rpc_admin_set_product_pricing(v_new_id, NULL, NULL, 30, 500);
  SELECT count(*) INTO v_n FROM public.rpc_admin_get_product_pricing(ARRAY[v_product, v_new_id]);
  IF v_n <> 2 THEN v_fail := v_fail || format('T8 get de 2 productos devolvió %s', v_n); END IF;
  RESET ROLE;
  SELECT p.cost_is_estimated INTO v_ok FROM public.products p WHERE p.id = v_new_id;
  IF v_ok IS DISTINCT FROM false THEN
    v_fail := v_fail || 'T8 cost_is_estimated NULL no se normalizó a false'::text;
  END IF;
  v_blocks := v_blocks + 1;

  -- T9 super_admin: lectura directa de costo bloqueada (solo por RPC)
  v_ok := false;
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_super, 'role', 'authenticated')::text, true);
    PERFORM p.cost FROM public.products p LIMIT 1;
  EXCEPTION WHEN insufficient_privilege THEN
    v_ok := true;
  END;
  RESET ROLE;
  IF NOT v_ok THEN v_fail := v_fail || 'T9 super_admin leyó products.cost directo'::text; END IF;
  v_blocks := v_blocks + 1;

  -- T10 producto inexistente y anon sin EXECUTE
  v_ok := false;
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_super, 'role', 'authenticated')::text, true);
    PERFORM public.rpc_admin_set_product_pricing('00000000-0000-4000-8000-000000000000'::uuid, 1, false, 1, 1);
  EXCEPTION WHEN no_data_found THEN
    v_ok := true;
  END;
  RESET ROLE;
  IF NOT v_ok THEN v_fail := v_fail || 'T10 set sobre producto inexistente no falló con P0002'::text; END IF;

  IF has_function_privilege('anon', 'public.rpc_admin_get_product_pricing(uuid[])', 'EXECUTE')
     OR has_function_privilege('anon', 'public.rpc_admin_set_product_pricing(uuid, numeric, boolean, numeric, numeric)', 'EXECUTE') THEN
    v_fail := v_fail || 'T10 anon puede ejecutar las RPC de costos'::text;
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.rpc_admin_get_product_pricing(uuid[])', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.rpc_admin_set_product_pricing(uuid, numeric, boolean, numeric, numeric)', 'EXECUTE') THEN
    v_fail := v_fail || 'T10 authenticated sin EXECUTE en las RPC de costos'::text;
  END IF;
  v_blocks := v_blocks + 1;

  -- T11 anon sin cambios respecto de 379
  FOREACH v_col IN ARRAY v_sensitive LOOP
    IF has_column_privilege('anon', 'public.products', v_col, 'SELECT') THEN
      v_fail := v_fail || ('T11 anon ve products.' || v_col);
    END IF;
  END LOOP;
  v_blocks := v_blocks + 1;

  PERFORM set_config('request.jwt.claims', '', true);

  IF cardinality(v_fail) > 0 THEN
    RAISE EXCEPTION '381 TEST FAIL: %', array_to_string(v_fail, ' | ');
  END IF;
  RAISE EXCEPTION '381 TEST OK (% bloques)', v_blocks;
END
$tests$;
