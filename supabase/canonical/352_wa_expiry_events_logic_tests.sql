-- 352_wa_expiry_events_logic_tests.sql
-- Requiere 351 aplicada antes. Solo lectura / smoke sobre datos reales
-- (fn_wa_expiry_candidates no escribe nada) + inserts de prueba en transacción.
-- Ejecutar en transacción:
--   BEGIN;
--   \i 352_wa_expiry_events_logic_tests.sql
--   ROLLBACK;

-- -----------------------------------------------------------------------------
-- A) Objetos presentes
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regprocedure('public.fn_wa_phone_e164(text)') IS NULL THEN
    RAISE EXCEPTION '352 FAIL: falta fn_wa_phone_e164';
  END IF;
  IF to_regprocedure('public.fn_wa_format_deadline_es(timestamptz)') IS NULL THEN
    RAISE EXCEPTION '352 FAIL: falta fn_wa_format_deadline_es';
  END IF;
  IF to_regprocedure('public.fn_wa_expiry_candidates()') IS NULL THEN
    RAISE EXCEPTION '352 FAIL: falta fn_wa_expiry_candidates';
  END IF;
  IF to_regprocedure('public.rpc_wa_preview_expiry_events()') IS NULL THEN
    RAISE EXCEPTION '352 FAIL: falta rpc_wa_preview_expiry_events';
  END IF;
  IF to_regprocedure('public.rpc_wa_enqueue_expiry_events()') IS NULL THEN
    RAISE EXCEPTION '352 FAIL: falta rpc_wa_enqueue_expiry_events';
  END IF;

  RAISE NOTICE '352 OK: 5 funciones presentes';
END $$;

-- -----------------------------------------------------------------------------
-- B) fn_wa_phone_e164 — casos reales verificados contra producción
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF public.fn_wa_phone_e164('3644123456') IS DISTINCT FROM '+5493644123456' THEN
    RAISE EXCEPTION '352 FAIL: fn_wa_phone_e164 10 dígitos -> %', public.fn_wa_phone_e164('3644123456');
  END IF;

  IF public.fn_wa_phone_e164('+54 9 3644 123456') IS DISTINCT FROM '+5493644123456' THEN
    RAISE EXCEPTION '352 FAIL: fn_wa_phone_e164 ya E.164 con espacios -> %', public.fn_wa_phone_e164('+54 9 3644 123456');
  END IF;

  IF public.fn_wa_phone_e164('03644123456') IS DISTINCT FROM '+5493644123456' THEN
    RAISE EXCEPTION '352 FAIL: fn_wa_phone_e164 con 0 inicial -> %', public.fn_wa_phone_e164('03644123456');
  END IF;

  IF public.fn_wa_phone_e164('123') IS NOT NULL THEN
    RAISE EXCEPTION '352 FAIL: fn_wa_phone_e164 con basura debería dar NULL, dio %', public.fn_wa_phone_e164('123');
  END IF;

  IF public.fn_wa_phone_e164(NULL) IS NOT NULL THEN
    RAISE EXCEPTION '352 FAIL: fn_wa_phone_e164(NULL) debería dar NULL';
  END IF;

  RAISE NOTICE '352 OK: fn_wa_phone_e164';
END $$;

-- -----------------------------------------------------------------------------
-- C) fn_wa_format_deadline_es — fecha conocida (2026-09-28 es lunes)
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_label text;
BEGIN
  v_label := public.fn_wa_format_deadline_es('2026-09-28 20:00:00+00'::timestamptz); -- 17:00 AR
  IF v_label IS DISTINCT FROM 'lunes 28/09 a las 17:00' THEN
    RAISE EXCEPTION '352 FAIL: fn_wa_format_deadline_es -> "%", esperaba "lunes 28/09 a las 17:00"', v_label;
  END IF;

  IF public.fn_wa_format_deadline_es(NULL) IS NOT NULL THEN
    RAISE EXCEPTION '352 FAIL: fn_wa_format_deadline_es(NULL) debería dar NULL';
  END IF;

  RAISE NOTICE '352 OK: fn_wa_format_deadline_es';
END $$;

-- -----------------------------------------------------------------------------
-- D) rpc_wa_enqueue_expiry_events con mode=off no inserta nada
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_before int;
  v_after int;
  v_result json;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()) THEN
    RAISE NOTICE '352 SKIP: sesión sin admin, no se puede probar rpc_wa_enqueue_expiry_events (correr como admin JWT)';
    RETURN;
  END IF;

  UPDATE public.wa_settings SET mode = 'off' WHERE id = true;

  SELECT count(*) INTO v_before FROM public.wa_outbox;
  v_result := public.rpc_wa_enqueue_expiry_events();
  SELECT count(*) INTO v_after FROM public.wa_outbox;

  IF v_after <> v_before THEN
    RAISE EXCEPTION '352 FAIL: mode=off insertó filas en wa_outbox (antes % después %)', v_before, v_after;
  END IF;

  IF (v_result->>'inserted')::int <> 0 THEN
    RAISE EXCEPTION '352 FAIL: mode=off debería devolver inserted=0, devolvió %', v_result;
  END IF;

  RAISE NOTICE '352 OK: mode=off no encola nada (%)', v_result;
END $$;
