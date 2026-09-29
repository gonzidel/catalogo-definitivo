-- 354_wa_enabled_kinds_tests.sql
-- Solo lectura / smoke. Ejecutar en transacción:
--   BEGIN;
--   \i 354_wa_enabled_kinds_tests.sql
--   ROLLBACK;

DO $$
DECLARE
  v_kinds text[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'wa_settings' AND column_name = 'enabled_kinds'
  ) THEN
    RAISE EXCEPTION '354 FAIL: falta wa_settings.enabled_kinds';
  END IF;

  SELECT enabled_kinds INTO v_kinds FROM public.wa_settings WHERE id = true;
  IF v_kinds IS DISTINCT FROM ARRAY['order_expired'] THEN
    RAISE EXCEPTION '354 FAIL: enabled_kinds debería ser {order_expired}, es %', v_kinds;
  END IF;

  RAISE NOTICE '354 OK: enabled_kinds = {order_expired}';
END $$;

-- fn_wa_expiry_candidates debe marcar 'order_expiring_soon' como kind_disabled
-- (o antes, launch_cutoff_not_set/before_launch_cutoff si el cutoff bloquea primero).
DO $$
DECLARE
  v_bad_count int;
BEGIN
  SELECT count(*) INTO v_bad_count
  FROM public.fn_wa_expiry_candidates()
  WHERE kind = 'order_expiring_soon' AND skip_reason = 'already_queued';
  -- Sanity: no debería colarse ninguna razón que sugiera que se enviaría.
  IF v_bad_count > 0 THEN
    RAISE WARNING '354 CHECK: hay % candidatos order_expiring_soon marcados already_queued (revisar manualmente)', v_bad_count;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.fn_wa_expiry_candidates()
    WHERE kind = 'order_expiring_soon' AND skip_reason IS NULL
  ) THEN
    RAISE EXCEPTION '354 FAIL: hay un candidato order_expiring_soon que SE ENVIARÍA (skip_reason NULL) con el tipo deshabilitado';
  END IF;

  RAISE NOTICE '354 OK: ningún order_expiring_soon quedó elegible para enviar';
END $$;
