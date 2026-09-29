-- 351_wa_notifications_foundation_tests.sql
-- Solo lectura / smoke. Ejecutar en transacción:
--   BEGIN;
--   \i 351_wa_notifications_foundation_tests.sql
--   ROLLBACK;

DO $$
BEGIN
  IF to_regclass('public.wa_settings') IS NULL THEN
    RAISE EXCEPTION '351 FAIL: falta tabla wa_settings';
  END IF;
  IF to_regclass('public.wa_channels') IS NULL THEN
    RAISE EXCEPTION '351 FAIL: falta tabla wa_channels';
  END IF;
  IF to_regclass('public.wa_outbox') IS NULL THEN
    RAISE EXCEPTION '351 FAIL: falta tabla wa_outbox';
  END IF;
  IF to_regclass('public.wa_webhook_events') IS NULL THEN
    RAISE EXCEPTION '351 FAIL: falta tabla wa_webhook_events';
  END IF;

  RAISE NOTICE '351 OK: 4 tablas presentes';
END $$;

DO $$
DECLARE
  v_mode text;
  v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM public.wa_settings;
  IF v_count <> 1 THEN
    RAISE EXCEPTION '351 FAIL: wa_settings debe tener exactamente 1 fila, tiene %', v_count;
  END IF;

  SELECT mode INTO v_mode FROM public.wa_settings WHERE id = true;
  IF v_mode <> 'off' THEN
    RAISE EXCEPTION '351 FAIL: wa_settings.mode default debe ser off, es %', v_mode;
  END IF;

  RAISE NOTICE '351 OK: wa_settings singleton en modo off';
END $$;

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM public.wa_channels WHERE owner_key IN ('ani', 'fati');
  IF v_count <> 2 THEN
    RAISE EXCEPTION '351 FAIL: esperaba 2 canales (ani, fati), hay %', v_count;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.wa_channels WHERE owner_key = 'fati' AND is_default = true) THEN
    RAISE EXCEPTION '351 FAIL: fati debería ser el canal por defecto (primer número a conectar)';
  END IF;

  RAISE NOTICE '351 OK: canales ani/fati sembrados, fati es default';
END $$;

-- Smoke: no se puede insertar mode inválido ni owner_key inválido.
DO $$
BEGIN
  BEGIN
    UPDATE public.wa_settings SET mode = 'lo-que-sea' WHERE id = true;
    RAISE EXCEPTION '351 FAIL: el CHECK de mode no bloqueó un valor inválido';
  EXCEPTION WHEN check_violation THEN
    NULL; -- esperado
  END;

  BEGIN
    INSERT INTO public.wa_channels (owner_key, display_name) VALUES ('gonzalo', 'Gonzalo');
    RAISE EXCEPTION '351 FAIL: el CHECK de owner_key no bloqueó un valor inválido';
  EXCEPTION WHEN check_violation THEN
    NULL; -- esperado
  END;

  RAISE NOTICE '351 OK: CHECK constraints activos';
END $$;
