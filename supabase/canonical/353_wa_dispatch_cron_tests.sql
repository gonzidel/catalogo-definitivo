-- 353_wa_dispatch_cron_tests.sql
-- Solo lectura / smoke. Ejecutar en transacción:
--   BEGIN;
--   \i 353_wa_dispatch_cron_tests.sql
--   ROLLBACK;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    RAISE EXCEPTION '353 FAIL: falta extensión pg_net';
  END IF;

  IF to_regprocedure('public.rpc_wa_cron_enqueue_expiry_events()') IS NULL THEN
    RAISE EXCEPTION '353 FAIL: falta rpc_wa_cron_enqueue_expiry_events';
  END IF;

  IF to_regprocedure('public.rpc_wa_dispatch_trigger()') IS NULL THEN
    RAISE EXCEPTION '353 FAIL: falta rpc_wa_dispatch_trigger';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'wa_settings' AND column_name = 'dispatch_function_url'
  ) THEN
    RAISE EXCEPTION '353 FAIL: falta wa_settings.dispatch_function_url';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'wa-notifications-dispatch') THEN
    RAISE EXCEPTION '353 FAIL: falta cron job wa-notifications-dispatch';
  END IF;

  IF EXISTS (
    SELECT 1 FROM cron.job
    WHERE jobname = 'orders-daily-maintenance'
      AND command NOT LIKE '%rpc_orders_daily_maintenance%'
  ) THEN
    RAISE EXCEPTION '353 FAIL: el job orders-daily-maintenance no debería haberse tocado';
  END IF;

  RAISE NOTICE '353 OK: objetos base presentes, job separado del de mantenimiento';
END $$;

-- Las funciones de cron NO deben ser ejecutables por authenticated ni anon.
DO $$
BEGIN
  IF has_function_privilege('authenticated', 'public.rpc_wa_cron_enqueue_expiry_events()', 'execute') THEN
    RAISE EXCEPTION '353 FAIL: authenticated puede ejecutar rpc_wa_cron_enqueue_expiry_events';
  END IF;
  IF has_function_privilege('anon', 'public.rpc_wa_cron_enqueue_expiry_events()', 'execute') THEN
    RAISE EXCEPTION '353 FAIL: anon puede ejecutar rpc_wa_cron_enqueue_expiry_events';
  END IF;
  IF has_function_privilege('authenticated', 'public.rpc_wa_dispatch_trigger()', 'execute') THEN
    RAISE EXCEPTION '353 FAIL: authenticated puede ejecutar rpc_wa_dispatch_trigger';
  END IF;
  IF has_function_privilege('anon', 'public.rpc_wa_dispatch_trigger()', 'execute') THEN
    RAISE EXCEPTION '353 FAIL: anon puede ejecutar rpc_wa_dispatch_trigger';
  END IF;

  RAISE NOTICE '353 OK: funciones de cron bloqueadas para authenticated/anon';
END $$;

-- rpc_wa_dispatch_trigger debe ser no-op mientras dispatch_function_url sea NULL.
DO $$
BEGIN
  UPDATE public.wa_settings SET dispatch_function_url = NULL WHERE id = true;
  PERFORM public.rpc_wa_dispatch_trigger(); -- no debe lanzar excepción
  RAISE NOTICE '353 OK: rpc_wa_dispatch_trigger no-op sin dispatch_function_url';
END $$;

-- El secreto de Vault existe.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'wa_dispatch_cron_secret') THEN
    RAISE EXCEPTION '353 FAIL: falta el secreto wa_dispatch_cron_secret en Vault';
  END IF;
  RAISE NOTICE '353 OK: secreto en Vault presente';
END $$;

-- rpc_wa_cron_enqueue_expiry_events respeta mode=off igual que la versión admin.
DO $$
DECLARE
  v_before int;
  v_after int;
  v_result json;
BEGIN
  UPDATE public.wa_settings SET mode = 'off' WHERE id = true;
  SELECT count(*) INTO v_before FROM public.wa_outbox;
  v_result := public.rpc_wa_cron_enqueue_expiry_events();
  SELECT count(*) INTO v_after FROM public.wa_outbox;

  IF v_after <> v_before THEN
    RAISE EXCEPTION '353 FAIL: rpc_wa_cron_enqueue_expiry_events insertó con mode=off';
  END IF;

  RAISE NOTICE '353 OK: rpc_wa_cron_enqueue_expiry_events mode=off no encola (%)', v_result;
END $$;
