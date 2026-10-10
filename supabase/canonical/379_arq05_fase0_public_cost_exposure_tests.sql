-- 379_arq05_fase0_public_cost_exposure_tests.sql
--
-- Ensayo en UNA transacción:
--   1. PARTE A (este archivo) ANTES del cuerpo de 379: línea base como anon y
--      como cliente, guardada en GUCs locales a la transacción.
--   2. Cuerpo de 379 sin BEGIN/COMMIT.
--   3. PARTE B (este archivo) DESPUÉS: siempre termina en RAISE EXCEPTION
--      ('379 TEST OK (n bloques)' o '379 TEST FAIL: ...') para forzar ROLLBACK.
-- No escribe datos: solo lecturas con SET LOCAL ROLE + claims JWT.

-- ─── PARTE A: línea base (antes de 379) ─────────────────────────────────────
DO $baseline$
DECLARE
  v_customer uuid;
  v_n bigint;
BEGIN
  SELECT u.id INTO v_customer
    FROM auth.users u
   WHERE NOT EXISTS (SELECT 1 FROM public.admins a WHERE a.user_id = u.id)
   LIMIT 1;

  SET LOCAL ROLE anon;
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  SELECT count(*) INTO v_n FROM public.catalog_public_view;
  PERFORM set_config('arq05.anon_view_total', v_n::text, true);
  SELECT count(*) INTO v_n FROM public.catalog_public_view WHERE "SupplierCode" <> '';
  PERFORM set_config('arq05.anon_view_with_code', v_n::text, true);
  SELECT count(*) INTO v_n FROM public.suppliers;
  PERFORM set_config('arq05.anon_suppliers', v_n::text, true);
  RESET ROLE;

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_customer, 'role', 'authenticated')::text, true);
  SELECT count(*) INTO v_n FROM public.catalog_public_view;
  PERFORM set_config('arq05.customer_view_total', v_n::text, true);
  RESET ROLE;

  PERFORM set_config('request.jwt.claims', '', true);
END
$baseline$;

-- ─── (aplicar aquí el cuerpo de 379) ────────────────────────────────────────

-- ─── PARTE B: verificación (después de 379) ─────────────────────────────────
DO $tests$
DECLARE
  v_fail text[] := '{}';
  v_blocks int := 0;
  v_n bigint;
  v_m bigint;
  v_col text;
  v_super uuid;
  v_customer uuid;
  v_product uuid;
  v_view_total bigint := nullif(current_setting('arq05.anon_view_total', true), '')::bigint;
  v_view_with_code bigint := nullif(current_setting('arq05.anon_view_with_code', true), '')::bigint;
  v_suppliers bigint := nullif(current_setting('arq05.anon_suppliers', true), '')::bigint;
  v_customer_view_total bigint := nullif(current_setting('arq05.customer_view_total', true), '')::bigint;
  v_all_suppliers bigint;
  v_cpd bigint;
  v_sensitive text[] := ARRAY['cost', 'cost_is_estimated', 'price_percentage', 'logistic_amount'];
  v_public text[] := ARRAY[
    'category', 'created_at', 'description', 'handle', 'height_cm', 'id',
    'last_published_at', 'length_cm', 'name', 'nuevos_ingresos_highlight_at',
    'pack_size', 'publication_status', 'season', 'status', 'supplier_id',
    'target_audience', 'updated_at', 'weight_kg', 'width_cm'
  ];
  v_anon_cols text[];
BEGIN
  SELECT a.user_id INTO v_super FROM public.admins a WHERE a.role = 'super_admin' LIMIT 1;
  SELECT u.id INTO v_customer
    FROM auth.users u
   WHERE NOT EXISTS (SELECT 1 FROM public.admins a WHERE a.user_id = u.id)
   LIMIT 1;
  SELECT p.id INTO v_product FROM public.products p WHERE p.status = 'active' LIMIT 1;
  SELECT count(*) INTO v_all_suppliers FROM public.suppliers;
  SELECT count(*) INTO v_cpd FROM public.category_pricing_defaults;

  IF v_super IS NULL OR v_customer IS NULL OR v_product IS NULL THEN
    RAISE EXCEPTION '379 TEST FAIL: faltan fixtures (super=%, customer=%, product=%)',
      v_super, v_customer, v_product;
  END IF;
  IF v_view_total IS NULL OR v_view_with_code IS NULL OR v_suppliers IS NULL
     OR v_customer_view_total IS NULL THEN
    RAISE EXCEPTION '379 TEST FAIL: falta la línea base (ejecutar PARTE A antes de 379)';
  END IF;

  -- T1 privilegios de columna de anon en products
  FOREACH v_col IN ARRAY v_sensitive LOOP
    IF has_column_privilege('anon', 'public.products', v_col, 'SELECT') THEN
      v_fail := v_fail || ('T1 anon ve products.' || v_col);
    END IF;
  END LOOP;
  IF has_table_privilege('anon', 'public.products', 'SELECT') THEN
    v_fail := v_fail || 'T1 anon conserva SELECT de tabla en products'::text;
  END IF;
  v_blocks := v_blocks + 1;

  -- T2 anon lee exactamente las columnas públicas (detecta columnas nuevas o perdidas)
  SELECT array_agg(a.attname::text ORDER BY a.attname) INTO v_anon_cols
    FROM pg_attribute a
   WHERE a.attrelid = 'public.products'::regclass
     AND a.attnum > 0
     AND NOT a.attisdropped
     AND has_column_privilege('anon', a.attrelid, a.attnum, 'SELECT');
  IF v_anon_cols IS DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(v_public) x) THEN
    v_fail := v_fail || ('T2 columnas anon products = ' || coalesce(v_anon_cols::text, 'NULL'));
  END IF;
  v_blocks := v_blocks + 1;

  -- T3 suppliers y category_pricing_defaults para anon
  IF has_column_privilege('anon', 'public.suppliers', 'name', 'SELECT')
     OR has_column_privilege('anon', 'public.suppliers', 'description', 'SELECT')
     OR NOT has_column_privilege('anon', 'public.suppliers', 'id', 'SELECT')
     OR NOT has_column_privilege('anon', 'public.suppliers', 'code', 'SELECT')
     OR has_table_privilege('anon', 'public.suppliers', 'INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('anon', 'public.category_pricing_defaults', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
  THEN
    v_fail := v_fail || 'T3 privilegios anon suppliers/category_pricing_defaults'::text;
  END IF;
  v_blocks := v_blocks + 1;

  -- T4 authenticated sin cambios en Fase 0 (Fase 1 lo resuelve)
  IF NOT has_column_privilege('authenticated', 'public.products', 'cost', 'SELECT')
     OR NOT has_column_privilege('authenticated', 'public.suppliers', 'name', 'SELECT')
  THEN
    v_fail := v_fail || 'T4 authenticated cambió privilegios (fuera de alcance)'::text;
  END IF;
  v_blocks := v_blocks + 1;

  -- T5 políticas
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
              AND tablename = 'category_pricing_defaults'
              AND policyname = 'authenticated_select_pricing_defaults')
     OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
              AND tablename = 'category_pricing_defaults'
              AND policyname = 'super_admin_write_pricing_defaults')
     OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
              AND tablename = 'suppliers' AND policyname = 'anon_select_suppliers')
     OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
              AND tablename = 'suppliers' AND policyname = 'auth_select_suppliers')
  THEN
    v_fail := v_fail || 'T5 políticas inesperadas'::text;
  END IF;
  v_blocks := v_blocks + 1;

  -- T6..T12 como anon
  SET LOCAL ROLE anon;
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);

  BEGIN
    PERFORM p.cost FROM public.products p LIMIT 1;
    v_fail := v_fail || 'T6 anon leyó products.cost'::text;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM p.price_percentage, p.logistic_amount FROM public.products p LIMIT 1;
    v_fail := v_fail || 'T6 anon leyó price_percentage/logistic_amount'::text;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  v_blocks := v_blocks + 1;

  BEGIN
    SELECT count(*) INTO v_n FROM (
      SELECT p.id, p.name, p.description, p.status, p.category, p.supplier_id,
             p.created_at, p.nuevos_ingresos_highlight_at, p.last_published_at
        FROM public.products p
       WHERE p.status = 'active'
       LIMIT 5
    ) s;
    IF v_n = 0 THEN v_fail := v_fail || 'T7 anon no ve productos activos'::text; END IF;
  EXCEPTION WHEN insufficient_privilege THEN
    v_fail := v_fail || ('T7 anon columnas públicas: ' || SQLERRM);
  END;
  v_blocks := v_blocks + 1;

  BEGIN
    SELECT count(*) INTO v_n FROM public.catalog_public_view;
    SELECT count(*) INTO v_m FROM public.catalog_public_view WHERE "SupplierCode" <> '';
    IF v_n <> v_view_total OR v_m <> v_view_with_code THEN
      v_fail := v_fail || format('T8 catalog_public_view anon %s/%s vs %s/%s',
                                 v_n, v_m, v_view_total, v_view_with_code);
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN
    v_fail := v_fail || ('T8 catalog_public_view anon: ' || SQLERRM);
  END;
  v_blocks := v_blocks + 1;

  BEGIN
    PERFORM 1 FROM public.catalog_public_available_view LIMIT 1;
    PERFORM 1 FROM public.catalog_public_snapshot LIMIT 1;
  EXCEPTION WHEN insufficient_privilege THEN
    v_fail := v_fail || ('T9 vistas/snapshot públicos anon: ' || SQLERRM);
  END;
  v_blocks := v_blocks + 1;

  BEGIN
    PERFORM s.name FROM public.suppliers s LIMIT 1;
    v_fail := v_fail || 'T10 anon leyó suppliers.name'::text;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    SELECT count(*) INTO v_n FROM (SELECT s.id, s.code FROM public.suppliers s) x;
    IF v_n <> v_suppliers THEN
      v_fail := v_fail || format('T10 anon ve %s de %s proveedores (id, code)', v_n, v_suppliers);
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN
    v_fail := v_fail || ('T10 anon suppliers(id, code): ' || SQLERRM);
  END;
  v_blocks := v_blocks + 1;

  BEGIN
    PERFORM 1 FROM public.category_pricing_defaults LIMIT 1;
    v_fail := v_fail || 'T11 anon leyó category_pricing_defaults'::text;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  v_blocks := v_blocks + 1;

  -- find_similar_products ya falla antes de 379 (proconfig search_path="pg_catalog, public"
  -- citado como un único esquema -> undefined_table); solo cuenta un error de permisos.
  BEGIN
    PERFORM 1 FROM public.find_similar_products(v_product, NULL, 3);
  EXCEPTION
    WHEN insufficient_privilege THEN
      v_fail := v_fail || ('T12 find_similar_products anon: ' || SQLERRM);
    WHEN undefined_table THEN NULL;
  END;
  v_blocks := v_blocks + 1;

  RESET ROLE;

  -- T13 cliente logueado: sin defaults de precio, catálogo intacto
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_customer, 'role', 'authenticated')::text, true);
  SELECT count(*) INTO v_n FROM public.category_pricing_defaults;
  IF v_n <> 0 THEN
    v_fail := v_fail || format('T13 cliente ve %s filas de category_pricing_defaults', v_n);
  END IF;
  SELECT count(*) INTO v_n FROM public.catalog_public_view;
  IF v_n <> v_customer_view_total THEN
    v_fail := v_fail || format('T13 catalog_public_view cliente %s vs %s', v_n, v_customer_view_total);
  END IF;
  RESET ROLE;
  v_blocks := v_blocks + 1;

  -- T14 super_admin conserva defaults y proveedores completos
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_super, 'role', 'authenticated')::text, true);
  SELECT count(*) INTO v_n FROM public.category_pricing_defaults;
  SELECT count(*) INTO v_m FROM (SELECT s.name FROM public.suppliers s) x;
  IF v_n <> v_cpd OR v_m <> v_all_suppliers THEN
    v_fail := v_fail || format('T14 super_admin cpd %s/%s suppliers %s/%s', v_n, v_cpd, v_m, v_all_suppliers);
  END IF;
  RESET ROLE;
  v_blocks := v_blocks + 1;

  PERFORM set_config('request.jwt.claims', '', true);

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION '379 TEST OK (% bloques)', v_blocks;
  ELSE
    RAISE EXCEPTION '379 TEST FAIL: %', array_to_string(v_fail, ' | ');
  END IF;
END
$tests$;
