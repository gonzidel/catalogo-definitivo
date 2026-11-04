-- 333C_revoke_insecure_catalog_writes_tests.sql
-- Privilege + RLS matrix para el lanzamiento de NJ.
-- Pensado para correr con BEGIN/ROLLBACK. No deja writes persistentes.

BEGIN;

DO $$
DECLARE
  v_customer uuid;
  v_admin uuid;
  v_variant uuid;
  v_product uuid;
  v_n int;
  v_md5 text;
BEGIN
  -- Policies agujero desaparecieron
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND policyname IN (
        'product_variants_all_access',
        'products_all_access',
        'variant_images_all_access',
        'colors_all_access',
        'tags_all_access',
        'product_tags_all_access'
      )
  ) THEN
    RAISE EXCEPTION '333C FAIL: permanece alguna policy *_all_access';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'product_variants' AND policyname = 'variants_admin_manage'
  ) THEN
    RAISE EXCEPTION '333C FAIL: falta variants_admin_manage';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'products' AND policyname = 'products_admin_manage'
  ) THEN
    RAISE EXCEPTION '333C FAIL: falta products_admin_manage';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'variant_images' AND policyname = 'variant_images_admin_manage'
  ) THEN
    RAISE EXCEPTION '333C FAIL: falta variant_images_admin_manage';
  END IF;

  -- GRANTs: anon no escribe stock/productos
  IF has_table_privilege('anon', 'public.variant_size_warehouse_stock', 'UPDATE')
     OR has_table_privilege('anon', 'public.product_variants', 'UPDATE')
     OR has_table_privilege('anon', 'public.products', 'INSERT')
     OR has_table_privilege('anon', 'public.warehouses', 'INSERT')
  THEN
    RAISE EXCEPTION '333C FAIL: anon conserva write de catálogo/stock';
  END IF;

  -- SELECT público necesario
  IF NOT has_table_privilege('anon', 'public.catalog_public_snapshot', 'SELECT')
     OR NOT has_table_privilege('anon', 'public.product_variants', 'SELECT')
     OR NOT has_table_privilege('anon', 'public.variant_size_warehouse_stock', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.cart_items', 'INSERT')
  THEN
    RAISE EXCEPTION '333C FAIL: se recortó un SELECT/cart que NJ o catalogo1 necesitan';
  END IF;

  -- authenticated conserva write GRANT (admin) pero no TRUNCATE ni warehouses write
  IF NOT has_table_privilege('authenticated', 'public.product_variants', 'UPDATE')
     OR NOT has_table_privilege('authenticated', 'public.variant_size_warehouse_stock', 'UPDATE')
  THEN
    RAISE EXCEPTION '333C FAIL: authenticated perdió GRANT write necesario para admin';
  END IF;

  IF has_table_privilege('authenticated', 'public.warehouses', 'INSERT')
     OR has_table_privilege('authenticated', 'public.product_variants', 'TRUNCATE')
  THEN
    RAISE EXCEPTION '333C FAIL: authenticated conserva GRANT innecesario (warehouses write o TRUNCATE)';
  END IF;

  -- RPCs / helpers
  IF NOT has_function_privilege('anon', 'public.rpc_get_variant_size_reserved(uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION '333C FAIL: se revocó rpc_get_variant_size_reserved a anon (todavía lo usa vanilla residual)';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.rpc_checkout_cart()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.rpc_checkout_cart()', 'EXECUTE')
  THEN
    RAISE EXCEPTION '333C FAIL: EXECUTE de rpc_checkout_cart() distinto al contrato NJ';
  END IF;

  IF NOT has_function_privilege('anon', 'public.fn_sellable_qty(uuid, text)', 'EXECUTE')
     OR NOT has_function_privilege('anon', 'public.rpc_catalog_public_version()', 'EXECUTE')
  THEN
    RAISE EXCEPTION '333C FAIL: se tocó EXECUTE de sellable/version';
  END IF;

  IF has_function_privilege('anon', 'public.fn_catalog_snapshot_rebuild()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.rpc_refresh_catalog_snapshot_if_dirty()', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.rpc_refresh_catalog_snapshot_if_dirty()', 'EXECUTE')
  THEN
    RAISE EXCEPTION '333C FAIL: grants 332 alterados';
  END IF;

  -- 331 intacto
  SELECT md5(pg_get_functiondef(p.oid)) INTO v_md5
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'rpc_checkout_cart'
    AND pg_get_function_identity_arguments(p.oid) = '';
  IF v_md5 IS DISTINCT FROM '9901c2cf5a32fc2ecad95c30c247b77e' THEN
    RAISE EXCEPTION '333C FAIL: rpc_checkout_cart() def cambió (md5=%)', v_md5;
  END IF;

  IF to_regprocedure('public.fn_commit_deferred_order_item_stock(uuid)') IS NULL THEN
    RAISE EXCEPTION '333C FAIL: 309 fn_commit_deferred_order_item_stock desapareció';
  END IF;

  SELECT user_id INTO v_admin FROM public.admins ORDER BY 1 LIMIT 1;
  SELECT c.id INTO v_customer
  FROM public.customers c
  WHERE NOT EXISTS (SELECT 1 FROM public.admins a WHERE a.user_id = c.id)
  ORDER BY 1
  LIMIT 1;
  SELECT id INTO v_variant FROM public.product_variants WHERE active IS TRUE LIMIT 1;
  SELECT id INTO v_product FROM public.products LIMIT 1;

  IF v_admin IS NULL OR v_customer IS NULL OR v_variant IS NULL THEN
    RAISE EXCEPTION '333C FAIL: faltan fixtures admin/customer/variant';
  END IF;

  -- Cliente authenticated: no write directo
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', v_customer::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_customer, 'role', 'authenticated')::text,
    true
  );

  IF public.is_admin() THEN
    RAISE EXCEPTION '333C FAIL: fixture customer resultó admin';
  END IF;

  UPDATE public.product_variants SET sku = sku WHERE id = v_variant;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 0 THEN
    RAISE EXCEPTION '333C FAIL: customer actualizó product_variants (% filas)', v_n;
  END IF;

  UPDATE public.products SET name = name WHERE id = v_product;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 0 THEN
    RAISE EXCEPTION '333C FAIL: customer actualizó products (% filas)', v_n;
  END IF;

  UPDATE public.variant_size_warehouse_stock SET stock_qty = stock_qty
  WHERE variant_id IN (SELECT id FROM public.product_variants LIMIT 1);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 0 THEN
    RAISE EXCEPTION '333C FAIL: customer actualizó VSS (% filas)', v_n;
  END IF;

  -- Admin authenticated: sí puede (no-op de valor, se revierte al ROLLBACK)
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );

  IF NOT public.is_admin() THEN
    RAISE EXCEPTION '333C FAIL: fixture admin no pasa is_admin()';
  END IF;

  UPDATE public.product_variants SET sku = sku WHERE id = v_variant;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n < 1 THEN
    RAISE EXCEPTION '333C FAIL: admin no pudo UPDATE product_variants';
  END IF;

  UPDATE public.products SET name = name WHERE id = v_product;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n < 1 THEN
    RAISE EXCEPTION '333C FAIL: admin no pudo UPDATE products';
  END IF;

  RAISE NOTICE '333C tests PASS';
END $$;

ROLLBACK;
