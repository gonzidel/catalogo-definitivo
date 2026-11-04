-- 366_checkout_preserve_order_notes_extras_tests.sql
-- Solo lecturas. Ejecutar después de aplicar 366.

DO $$
DECLARE
  v numeric;
BEGIN
  v := public.fn_order_notes_extras_total(NULL, 1000);
  IF v <> 0 THEN RAISE EXCEPTION '366 FAIL null notes -> %', v; END IF;

  v := public.fn_order_notes_extras_total('texto libre del admin', 1000);
  IF v <> 0 THEN RAISE EXCEPTION '366 FAIL notes no JSON -> %', v; END IF;

  v := public.fn_order_notes_extras_total('{"extras_amount": 8500, "extras_label": "ALHAJEROS"}', 134900);
  IF v <> 8500 THEN RAISE EXCEPTION '366 FAIL extra fijo -> %', v; END IF;

  v := public.fn_order_notes_extras_total('{"shipping": 3000, "discount": 5000, "extras_amount": 0, "extras_percentage": 10}', 20000);
  IF v <> 3000 - 5000 + 2000 THEN RAISE EXCEPTION '366 FAIL combinado -> %', v; END IF;

  v := public.fn_order_notes_extras_total('{"shipping": "abc", "discount": "", "extras_amount": "8500"}', 1000);
  IF v <> 8500 THEN RAISE EXCEPTION '366 FAIL valores no numéricos -> %', v; END IF;

  v := public.fn_order_notes_extras_total('{"pau_source": true}', 1000);
  IF v <> 0 THEN RAISE EXCEPTION '366 FAIL sin extras -> %', v; END IF;

  RAISE NOTICE '366 OK: fn_order_notes_extras_total';
END $$;

DO $$
DECLARE
  v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'rpc_checkout_cart'
     AND pg_get_function_identity_arguments(p.oid) = '';
  IF md5(v_src) <> '04c1dac9cc7f452dc4318b6aba1ee4ca' THEN
    RAISE EXCEPTION '366 FAIL rpc_checkout_cart md5 %', md5(v_src);
  END IF;
  IF has_function_privilege('anon', 'public.fn_order_notes_extras_total(text, numeric)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_order_notes_extras_total(text, numeric)', 'EXECUTE') THEN
    RAISE EXCEPTION '366 FAIL fn_order_notes_extras_total expuesta a anon/authenticated';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.rpc_checkout_cart()', 'EXECUTE') THEN
    RAISE EXCEPTION '366 FAIL rpc_checkout_cart perdió EXECUTE para authenticated';
  END IF;
  RAISE NOTICE '366 OK: rpc_checkout_cart parcheada y grants intactos';
END $$;
