-- 357_wa_deadline_reached_taxonomy_tests.sql
-- Solo lectura + smoke. Ejecutar en transacción:
--   BEGIN;
--   \i 357_wa_deadline_reached_taxonomy_tests.sql
--   ROLLBACK;

-- fn_wa_customer_24h_uses: casos defensivos.
DO $$
BEGIN
  IF public.fn_wa_customer_24h_uses(NULL) IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION '357 FAIL: fn_wa_customer_24h_uses(NULL) debería ser 0';
  END IF;
  IF public.fn_wa_customer_24h_uses('') IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION '357 FAIL: fn_wa_customer_24h_uses('''') debería ser 0';
  END IF;
  IF public.fn_wa_customer_24h_uses('no es json') IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION '357 FAIL: fn_wa_customer_24h_uses(basura) debería ser 0';
  END IF;
  IF public.fn_wa_customer_24h_uses('[1,2,3]') IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION '357 FAIL: fn_wa_customer_24h_uses(array json) debería ser 0';
  END IF;
  IF public.fn_wa_customer_24h_uses('{}') IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION '357 FAIL: fn_wa_customer_24h_uses({}) debería ser 0';
  END IF;
  IF public.fn_wa_customer_24h_uses('{"customer_enable_24h_uses":1}') IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION '357 FAIL: fn_wa_customer_24h_uses debería leer 1';
  END IF;
  RAISE NOTICE '357 OK: fn_wa_customer_24h_uses casos defensivos correctos';
END $$;

-- Privilegios: ninguna función nueva/recreada debe ser ejecutable por
-- authenticated/anon (lección 352b).
DO $$
DECLARE
  v_bad text[];
BEGIN
  SELECT array_agg(f) INTO v_bad FROM (
    SELECT 'fn_wa_customer_24h_uses' AS f
    WHERE has_function_privilege('authenticated', 'public.fn_wa_customer_24h_uses(text)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.fn_wa_customer_24h_uses(text)', 'EXECUTE')
    UNION ALL
    SELECT 'fn_wa_expiry_candidates'
    WHERE has_function_privilege('authenticated', 'public.fn_wa_expiry_candidates()', 'EXECUTE')
       OR has_function_privilege('anon', 'public.fn_wa_expiry_candidates()', 'EXECUTE')
    UNION ALL
    SELECT 'rpc_wa_cron_enqueue_expiry_events'
    WHERE has_function_privilege('authenticated', 'public.rpc_wa_cron_enqueue_expiry_events()', 'EXECUTE')
       OR has_function_privilege('anon', 'public.rpc_wa_cron_enqueue_expiry_events()', 'EXECUTE')
  ) x;

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '357 FAIL: funciones con EXECUTE expuesto a authenticated/anon: %', v_bad;
  END IF;
  RAISE NOTICE '357 OK: ninguna función nueva/recreada es ejecutable por authenticated/anon';
END $$;

-- fn_wa_expiry_candidates: el kind viejo ya no aparece.
DO $$
DECLARE
  v_has_old_kind boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.fn_wa_expiry_candidates() WHERE kind = 'order_expiring_soon'
  ) INTO v_has_old_kind;
  IF v_has_old_kind THEN
    RAISE EXCEPTION '357 FAIL: todavía aparece el kind viejo order_expiring_soon';
  END IF;
  RAISE NOTICE '357 OK: fn_wa_expiry_candidates ya no expone order_expiring_soon';
END $$;

-- Columna customer_enable_24h_uses accesible (si esto falla con "column does
-- not exist", la función no se recreó bien).
DO $$
DECLARE
  v_uses int;
BEGIN
  SELECT customer_enable_24h_uses INTO v_uses
  FROM public.fn_wa_expiry_candidates()
  LIMIT 1;
  RAISE NOTICE '357 OK: columna customer_enable_24h_uses accesible (ejemplo: %, NULL si no hay candidatos)', v_uses;
END $$;

-- wa_outbox: CHECK constraint actualizado.
DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
  FROM pg_constraint
  WHERE conrelid = 'public.wa_outbox'::regclass AND conname = 'wa_outbox_kind_check';

  IF v_def NOT LIKE '%order_deadline_reached%' THEN
    RAISE EXCEPTION '357 FAIL: wa_outbox_kind_check no incluye order_deadline_reached: %', v_def;
  END IF;
  IF v_def LIKE '%order_expiring_soon%' THEN
    RAISE EXCEPTION '357 FAIL: wa_outbox_kind_check todavía incluye order_expiring_soon: %', v_def;
  END IF;
  RAISE NOTICE '357 OK: wa_outbox_kind_check actualizado (%)', v_def;
END $$;

-- Seguridad general: mode sigue en off, wa_outbox sigue vacía (nada de esto
-- debe haber encolado ni mandado nada).
DO $$
DECLARE
  v_mode text;
  v_outbox_count int;
BEGIN
  SELECT mode INTO v_mode FROM public.wa_settings WHERE id = true;
  SELECT count(*) INTO v_outbox_count FROM public.wa_outbox;

  IF v_mode <> 'off' THEN
    RAISE WARNING '357 CHECK: wa_settings.mode = % (se esperaba off en este punto del proyecto)', v_mode;
  END IF;
  IF v_outbox_count > 0 THEN
    RAISE WARNING '357 CHECK: wa_outbox tiene % filas (se esperaba 0)', v_outbox_count;
  END IF;
  RAISE NOTICE '357 OK: estado general — mode=%, wa_outbox filas=%', v_mode, v_outbox_count;
END $$;
