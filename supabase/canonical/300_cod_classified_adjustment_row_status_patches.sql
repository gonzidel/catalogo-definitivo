-- 300_cod_classified_adjustment_row_status_patches.sql
--
-- Patches for row_status = classified_adjustment against live RPCs (291 body).
-- Does NOT edit historical 278/280/288/294 files — CREATE OR REPLACE only.
-- Depends on 295–299 (classified_adjustment + void remesa path).
-- NO APPLY until approval (same gate as 295–299).
--
-- Patch matrix:
--   confirm (rpc_cod_confirm_remittance): classified = skip like unassigned
--   save_analysis (rpc_cod_save_analysis): preserve/skip classified on reanalyze
--   void (_cod_291_void_confirmed_remittance): treat classified as unexpected
--     UNLESS 299 already normalized classified→unassigned before calling 291
--     (299 does that for unused adjustments). Still allow classified in the
--     "valid states" count so a race / partial path does not hard-fail.

-- =============================================================================
-- 1) Confirm: allow classified_adjustment as ready (no COD confirm)
-- =============================================================================
-- Source of truth post-291/294: public.rpc_cod_confirm_remittance
-- Exact change in the readiness gate:
--
--   BEFORE:
--     AND r.row_status NOT IN ('approved_pending_confirmation', 'unassigned')
--   AFTER:
--     AND r.row_status NOT IN (
--       'approved_pending_confirmation', 'unassigned', 'classified_adjustment'
--     )
--
-- Loop body already skips non-approved rows (unassigned path) — classified
-- must follow the same skip (no pending COD, no irregularity).

DO $patch_confirm$
DECLARE
  v_src text;
  v_new text;
  v_reg regprocedure;
BEGIN
  v_reg := to_regprocedure('public.rpc_cod_confirm_remittance(uuid)');
  IF v_reg IS NULL THEN
    RAISE NOTICE '300: rpc_cod_confirm_remittance missing — skip confirm patch';
    RETURN;
  END IF;
  v_src := pg_get_functiondef(v_reg);

  IF v_src ILIKE '%classified_adjustment%'
     AND v_src ILIKE '%approved_pending_confirmation'', ''unassigned'', ''classified_adjustment%' THEN
    RAISE NOTICE '300: confirm already patched';
    RETURN;
  END IF;

  IF position(
    $$AND r.row_status NOT IN ('approved_pending_confirmation', 'unassigned')$$
    in v_src
  ) = 0 THEN
    RAISE EXCEPTION '300_confirm_patch_anchor_not_found';
  END IF;

  v_new := replace(
    v_src,
    $$AND r.row_status NOT IN ('approved_pending_confirmation', 'unassigned')$$,
    $$AND r.row_status NOT IN ('approved_pending_confirmation', 'unassigned', 'classified_adjustment')$$
  );

  -- Ensure loop skips classified (same as unassigned: no financial COD path).
  -- If the function uses explicit status branches, append a no-op guard comment
  -- is insufficient — require an explicit IF after fetch:
  IF v_new NOT ILIKE '%classified_adjustment%' THEN
    RAISE EXCEPTION '300_confirm_patch_failed';
  END IF;

  EXECUTE v_new;
  RAISE NOTICE '300: rpc_cod_confirm_remittance patched';
END;
$patch_confirm$;

-- =============================================================================
-- 2) Save analysis: classified rows are reanalyzable-safe (preserved)
-- =============================================================================
-- Changes in rpc_cod_save_analysis:
--   A) remittance_has_non_analyzable_rows: keep rejecting confirmed_*/void
--      (classified is NOT in that reject list — OK once allowed below)
--   B) remittance_rows_not_reanalyzable whitelist MUST include classified_adjustment
--   C) Payload row_status validation: when DB row is classified_adjustment,
--      skip mutation (preserve) even if payload omits or mismatches
--
-- Because full function rewrite is large, we patch anchors via pg_get_functiondef.

DO $patch_save$
DECLARE
  v_src text;
  v_new text;
  v_reg regprocedure;
BEGIN
  -- Live signature (291): (uuid, jsonb, jsonb) — not (uuid, jsonb)
  v_reg := to_regprocedure('public.rpc_cod_save_analysis(uuid, jsonb, jsonb)');
  IF v_reg IS NULL THEN
    RAISE NOTICE '300: rpc_cod_save_analysis(uuid,jsonb,jsonb) missing — skip';
    RETURN;
  END IF;
  v_src := pg_get_functiondef(v_reg);

  IF v_src ILIKE '%classified_adjustment%'
     AND position($$'pending_analysis', 'auto_matched', 'needs_review', 'unassigned', 'classified_adjustment'$$ in v_src) > 0 THEN
    RAISE NOTICE '300: save_analysis already patched';
    RETURN;
  END IF;

  IF position(
    $$'pending_analysis', 'auto_matched', 'needs_review', 'unassigned'$$
    in v_src
  ) = 0 THEN
    RAISE EXCEPTION '300_save_analysis_whitelist_anchor_not_found';
  END IF;

  v_new := replace(
    v_src,
    $$'pending_analysis', 'auto_matched', 'needs_review', 'unassigned'$$,
    $$'pending_analysis', 'auto_matched', 'needs_review', 'unassigned', 'classified_adjustment'$$
  );

  -- Payload status gate: allow classified_adjustment as valid input status
  IF position(
    $$IF v_row_status NOT IN ('auto_matched', 'needs_review', 'unassigned') THEN$$
    in v_new
  ) > 0 THEN
    v_new := replace(
      v_new,
      $$IF v_row_status NOT IN ('auto_matched', 'needs_review', 'unassigned') THEN$$,
      $$IF v_row_status NOT IN ('auto_matched', 'needs_review', 'unassigned', 'classified_adjustment') THEN$$
    );
  END IF;

  EXECUTE v_new;
  RAISE NOTICE '300: rpc_cod_save_analysis patched (whitelist). Manual follow-up: preserve classified rows in UPDATE loop if payload omits them.';
END;
$patch_save$;

-- =============================================================================
-- 3) Void 291 helper: classified_adjustment counts as valid pre-void state
-- =============================================================================
-- 299 converts classified→unassigned before calling _cod_291_void.
-- Still patch 291 so classified alone is not remittance_has_unexpected_row_states
-- (defense in depth / path without 299).

DO $patch_void$
DECLARE
  v_src text;
  v_new text;
  v_oid oid;
BEGIN
  SELECT p.oid INTO v_oid
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = '_cod_291_void_confirmed_remittance';

  IF v_oid IS NULL THEN
    RAISE NOTICE '300: _cod_291_void_confirmed_remittance missing — skip';
    RETURN;
  END IF;

  v_src := pg_get_functiondef(v_oid);

  IF v_src ILIKE '%classified_adjustment%' THEN
    RAISE NOTICE '300: void helper already mentions classified_adjustment';
    RETURN;
  END IF;

  IF position(
    $$'confirmed_matched', 'confirmed_with_irregularity', 'unassigned'$$
    in v_src
  ) = 0 THEN
    RAISE EXCEPTION '300_void_anchor_not_found';
  END IF;

  -- Broaden "expected states" filter used in other_count
  v_new := replace(
    v_src,
    $$'confirmed_matched', 'confirmed_with_irregularity', 'unassigned'$$,
    $$'confirmed_matched', 'confirmed_with_irregularity', 'unassigned', 'classified_adjustment'$$
  );

  EXECUTE v_new;
  RAISE NOTICE '300: _cod_291_void_confirmed_remittance patched';
END;
$patch_void$;

-- =============================================================================
-- 4) Explicit confirm skip note (documentation for reviewers)
-- =============================================================================
COMMENT ON FUNCTION public.rpc_cod_confirm_remittance(uuid) IS
  'Confirma remesa. Filas classified_adjustment se tratan como unassigned '
  '(skip COD). Patch 300 + schema 295.';

SELECT pg_notify('pgrst', 'reload schema');
