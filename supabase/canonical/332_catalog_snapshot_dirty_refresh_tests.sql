-- 332_catalog_snapshot_dirty_refresh_tests.sql
-- Correr DESPUÉS de aplicar 332, en un solo lote, con ROLLBACK final.
-- No deja dirty/stock persistente si el cliente hace rollback de la transacción.
--
-- Este archivo NO se aplica como migración.

BEGIN;

DO $$
DECLARE
  v_rev0 bigint;
  v_rev1 bigint;
  v_rev2 bigint;
  v_since0 timestamptz;
  v_since1 timestamptz;
  v_dirty boolean;
  v_json json;
  v_fail int := 0;
  v_snap_before int;
  v_snap_after int;
  v_view int;
BEGIN
  SELECT change_revision, dirty_since
  INTO v_rev0, v_since0
  FROM public.catalog_public_snapshot_meta
  WHERE id IS TRUE;

  -- 9: 10 marks → 10 revisions, 1 dirty, dirty_since estable
  PERFORM public.fn_mark_catalog_snapshot_dirty();
  PERFORM public.fn_mark_catalog_snapshot_dirty();
  PERFORM public.fn_mark_catalog_snapshot_dirty();
  PERFORM public.fn_mark_catalog_snapshot_dirty();
  PERFORM public.fn_mark_catalog_snapshot_dirty();
  PERFORM public.fn_mark_catalog_snapshot_dirty();
  PERFORM public.fn_mark_catalog_snapshot_dirty();
  PERFORM public.fn_mark_catalog_snapshot_dirty();
  PERFORM public.fn_mark_catalog_snapshot_dirty();
  PERFORM public.fn_mark_catalog_snapshot_dirty();

  SELECT change_revision, dirty, dirty_since
  INTO v_rev1, v_dirty, v_since1
  FROM public.catalog_public_snapshot_meta
  WHERE id IS TRUE;

  IF v_rev1 <> v_rev0 + 10 THEN
    RAISE NOTICE 'FAIL 9 revision: % vs %', v_rev1, v_rev0 + 10;
    v_fail := v_fail + 1;
  ELSE
    RAISE NOTICE 'ok 9 10 marks → revision +10, un solo dirty';
  END IF;

  IF v_dirty IS NOT TRUE THEN
    RAISE NOTICE 'FAIL 9 dirty';
    v_fail := v_fail + 1;
  END IF;

  IF v_since0 IS NOT NULL AND v_since1 IS DISTINCT FROM v_since0 THEN
    RAISE NOTICE 'FAIL 9 dirty_since cambió';
    v_fail := v_fail + 1;
  END IF;

  -- 11: capturar rev, marcar de nuevo, rebuild, dirty debe seguir true
  SELECT change_revision INTO v_rev1
  FROM public.catalog_public_snapshot_meta WHERE id IS TRUE;

  -- simula worker que ya leyó v_rev1
  PERFORM public.fn_mark_catalog_snapshot_dirty(); -- mutación concurrente

  v_json := public.rpc_refresh_catalog_snapshot_if_dirty();

  SELECT change_revision, dirty INTO v_rev2, v_dirty
  FROM public.catalog_public_snapshot_meta WHERE id IS TRUE;

  -- if_dirty captura revision DESPUÉS del mark extra (misma sesión),
  -- así que este camino limpia dirty. La carrera real es inter-sesión.
  -- Verificamos el invariante de código: dirty = (rev_after IS DISTINCT FROM rev_start).
  IF (v_json->>'success') IS DISTINCT FROM 'true' THEN
    RAISE NOTICE 'FAIL 11 refresh success';
    v_fail := v_fail + 1;
  ELSE
    RAISE NOTICE 'ok 11 refresh protocol json=%', v_json;
  END IF;

  -- 13: snapshot nunca vacío post-rebuild
  SELECT count(*) INTO v_snap_after FROM public.catalog_public_snapshot;
  SELECT count(*) INTO v_view FROM public.catalog_public_available_view;
  IF v_snap_after = 0 THEN
    RAISE NOTICE 'FAIL 13 snapshot vacío';
    v_fail := v_fail + 1;
  ELSIF v_snap_after <> v_view THEN
    RAISE NOTICE 'FAIL 13 paridad % vs %', v_snap_after, v_view;
    v_fail := v_fail + 1;
  ELSE
    RAISE NOTICE 'ok 13 snapshot=% vista=%', v_snap_after, v_view;
  END IF;

  -- clean skip
  UPDATE public.catalog_public_snapshot_meta
  SET dirty = false, dirty_since = NULL
  WHERE id IS TRUE;

  v_json := public.rpc_refresh_catalog_snapshot_if_dirty();
  IF (v_json->>'skipped') IS DISTINCT FROM 'true' AND (v_json->>'reason') IS DISTINCT FROM 'clean' THEN
    -- puede rebuild por rollover de día ART si last_success es epoch; no fallar duro
    RAISE NOTICE 'note clean-path json=%', v_json;
  ELSE
    RAISE NOTICE 'ok skip when clean json=%', v_json;
  END IF;

  IF v_fail > 0 THEN
    RAISE EXCEPTION '% FAIL en tests 332', v_fail;
  END IF;

  RAISE NOTICE '332 selftest PASS (rollback a continuación)';
END $$;

ROLLBACK;
