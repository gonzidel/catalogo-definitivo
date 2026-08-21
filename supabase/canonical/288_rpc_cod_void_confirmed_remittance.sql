-- 288_rpc_cod_void_confirmed_remittance.sql
--
-- Fase 6D — Anular una rendición YA confirmada (efecto financiero completo).
--
-- NO DELETE. Conserva filas, snapshots, matched_order_id histórico e irregularidades.
-- NO muta orders. NO toca aliases. NO modifica 279/280/286/287.
-- NO es "unvoid"/restore.
--
-- Schema ya existente (272):
--   remittance.status incluye 'voided' + voided_by/voided_at/void_reason
--   row_status incluye 'void' (fuera de uq_cod_rows_matched_order_active)
--   event_type 'remittance_voided'
--   superseded_reason 'remittance_voided'
--
-- Firma:
--   rpc_cod_void_confirmed_remittance(p_remittance_id uuid, p_reason text) → jsonb
--
-- Locks:
--   1) remittance FOR UPDATE
--   2) todas las filas de la remittance FOR UPDATE (ORDER BY id)
--   3) orders asociados confirmed_* FOR UPDATE en UUID ASC
-- Revalidación post-lock; cualquier fallo → EXCEPTION → rollback total.

CREATE OR REPLACE FUNCTION public.rpc_cod_void_confirmed_remittance(
  p_remittance_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_rem public.cod_remittances%ROWTYPE;
  v_reason text;
  v_lock_id uuid;
  v_order_ids uuid[] := ARRAY[]::uuid[];
  v_cnt_exact int := 0;
  v_cnt_irreg int := 0;
  v_cnt_unassigned int := 0;
  v_cnt_other int := 0;
  v_amt_reconciled numeric(14,2) := 0;
  v_irreg_open int := 0;
  v_irreg_review int := 0;
  v_irreg_resolved int := 0;
  v_irreg_superseded_prev int := 0;
  v_rows_voided int := 0;
  v_irregs_superseded int := 0;
  v_prev jsonb;
  v_new jsonb;
  v_row public.cod_remittance_rows%ROWTYPE;
  v_order_lock int;
  v_null_order_rows int := 0;
  v_expected_voided int := 0;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.has_permission(v_uid, 'conciliacion-reembolso', 'edit') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_remittance_id IS NULL THEN
    RAISE EXCEPTION 'params_required';
  END IF;

  v_reason := NULLIF(trim(COALESCE(p_reason, '')), '');
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'reason_required';
  END IF;

  -- 1) Lock cabecera
  SELECT * INTO v_rem
  FROM public.cod_remittances
  WHERE id = p_remittance_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'remittance_not_found'; END IF;
  IF v_rem.status = 'voided' THEN
    RAISE EXCEPTION 'remittance_already_voided';
  END IF;
  IF v_rem.status <> 'confirmed' THEN
    RAISE EXCEPTION 'remittance_not_confirmed status=%', v_rem.status;
  END IF;

  -- 2) Lock todas las filas (orden estable)
  PERFORM 1
  FROM public.cod_remittance_rows
  WHERE remittance_id = p_remittance_id
  ORDER BY id
  FOR UPDATE;

  -- Conteos / montos pre-void (para evento)
  SELECT
    count(*) FILTER (WHERE row_status = 'confirmed_matched'),
    count(*) FILTER (WHERE row_status = 'confirmed_with_irregularity'),
    count(*) FILTER (WHERE row_status = 'unassigned'),
    count(*) FILTER (
      WHERE row_status NOT IN (
        'confirmed_matched', 'confirmed_with_irregularity', 'unassigned'
      )
    ),
    coalesce(sum(COALESCE(expected_amount_snapshot, parsed_amount, 0)) FILTER (
      WHERE row_status IN ('confirmed_matched', 'confirmed_with_irregularity')
    ), 0)
  INTO
    v_cnt_exact,
    v_cnt_irreg,
    v_cnt_unassigned,
    v_cnt_other,
    v_amt_reconciled
  FROM public.cod_remittance_rows
  WHERE remittance_id = p_remittance_id;

  -- Solo confirmed_* + unassigned son estados válidos en una remittance confirmed.
  IF v_cnt_other > 0 THEN
    RAISE EXCEPTION 'remittance_has_unexpected_row_states other_count=%', v_cnt_other;
  END IF;

  -- confirmed_* sin pedido = corrupción / estado inválido → abortar
  SELECT count(*)
  INTO v_null_order_rows
  FROM public.cod_remittance_rows
  WHERE remittance_id = p_remittance_id
    AND row_status IN ('confirmed_matched', 'confirmed_with_irregularity')
    AND matched_order_id IS NULL;

  IF v_null_order_rows > 0 THEN
    RAISE EXCEPTION 'confirmed_row_missing_order count=%', v_null_order_rows;
  END IF;

  -- Pedidos a liberar (confirmed_*)
  SELECT coalesce(array_agg(x ORDER BY x), ARRAY[]::uuid[])
  INTO v_order_ids
  FROM (
    SELECT DISTINCT matched_order_id AS x
    FROM public.cod_remittance_rows
    WHERE remittance_id = p_remittance_id
      AND row_status IN ('confirmed_matched', 'confirmed_with_irregularity')
      AND matched_order_id IS NOT NULL
  ) s;

  -- 3) Lock orders en UUID ASC (anti-deadlock); order faltante → rollback
  FOR v_lock_id IN
    SELECT x FROM unnest(v_order_ids) AS t(x) ORDER BY 1
  LOOP
    SELECT 1 INTO v_order_lock
    FROM public.orders
    WHERE id = v_lock_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'matched_order_missing order_id=%', v_lock_id;
    END IF;
  END LOOP;

  -- Revalidar cabecera post-lock
  SELECT * INTO v_rem
  FROM public.cod_remittances
  WHERE id = p_remittance_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'remittance_not_found'; END IF;
  IF v_rem.status = 'voided' THEN
    RAISE EXCEPTION 'remittance_already_voided';
  END IF;
  IF v_rem.status <> 'confirmed' THEN
    RAISE EXCEPTION 'remittance_state_changed_concurrently status=%', v_rem.status;
  END IF;

  -- Revalidar filas a liberar: únicamente confirmed_* (void ya no es aceptable)
  FOR v_row IN
    SELECT *
    FROM public.cod_remittance_rows
    WHERE remittance_id = p_remittance_id
      AND matched_order_id = ANY (v_order_ids)
    FOR UPDATE
  LOOP
    IF v_row.row_status NOT IN ('confirmed_matched', 'confirmed_with_irregularity') THEN
      RAISE EXCEPTION 'row_state_changed_concurrently row_id=% status=%', v_row.id, v_row.row_status;
    END IF;
  END LOOP;

  -- Irregularidades: conteos prev + supersede activas
  SELECT
    count(*) FILTER (WHERE status = 'open'),
    count(*) FILTER (WHERE status = 'in_review'),
    count(*) FILTER (WHERE status = 'resolved'),
    count(*) FILTER (WHERE status = 'superseded')
  INTO
    v_irreg_open,
    v_irreg_review,
    v_irreg_resolved,
    v_irreg_superseded_prev
  FROM public.cod_irregularities
  WHERE remittance_id = p_remittance_id;

  UPDATE public.cod_irregularities SET
    status = 'superseded',
    superseded_reason = 'remittance_voided',
    superseded_at = now(),
    superseded_by = v_uid,
    updated_at = now()
  WHERE remittance_id = p_remittance_id
    AND status IN ('open', 'in_review');

  GET DIAGNOSTICS v_irregs_superseded = ROW_COUNT;

  -- Filas confirmed_* → void (conserva matched_order_id + snapshots)
  UPDATE public.cod_remittance_rows SET
    row_status = 'void',
    updated_at = now()
  WHERE remittance_id = p_remittance_id
    AND row_status IN ('confirmed_matched', 'confirmed_with_irregularity');

  GET DIAGNOSTICS v_rows_voided = ROW_COUNT;

  v_expected_voided := v_cnt_exact + v_cnt_irreg;
  IF v_rows_voided <> v_expected_voided THEN
    RAISE EXCEPTION 'row_void_count_mismatch expected=% got=%',
      v_expected_voided, v_rows_voided;
  END IF;

  -- Cabecera → voided
  UPDATE public.cod_remittances SET
    status = 'voided',
    voided_by = v_uid,
    voided_at = now(),
    void_reason = v_reason,
    updated_at = now()
  WHERE id = p_remittance_id
    AND status = 'confirmed';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'remittance_void_failed_concurrently';
  END IF;

  v_prev := jsonb_build_object(
    'status', 'confirmed',
    'confirmed_at', v_rem.confirmed_at,
    'confirmed_by', v_rem.confirmed_by,
    'confirmed_matched_count', v_cnt_exact,
    'confirmed_with_irregularity_count', v_cnt_irreg,
    'unassigned_count', v_cnt_unassigned,
    'other_row_count', v_cnt_other,
    'reconciled_amount_snapshot_sum', v_amt_reconciled,
    'irregularities_open', v_irreg_open,
    'irregularities_in_review', v_irreg_review,
    'irregularities_resolved', v_irreg_resolved,
    'irregularities_superseded_already', v_irreg_superseded_prev,
    'orders_to_release_count', coalesce(cardinality(v_order_ids), 0)
  );

  v_new := jsonb_build_object(
    'status', 'voided',
    'voided_at', now(),
    'voided_by', v_uid,
    'rows_voided', v_rows_voided,
    'irregularities_superseded', v_irregs_superseded,
    'orders_returned_to_pending', coalesce(cardinality(v_order_ids), 0),
    'unassigned_left_as_is', v_cnt_unassigned,
    'resolved_kept_intact', v_irreg_resolved,
    'phase', '6d',
    'financial_effect', true
  );

  INSERT INTO public.cod_reconciliation_events (
    remittance_id, event_type, actor_id, previous_state, new_state, reason
  ) VALUES (
    p_remittance_id,
    'remittance_voided',
    v_uid,
    v_prev,
    v_new,
    v_reason
  );

  RETURN jsonb_build_object(
    'ok', true,
    'remittance_id', p_remittance_id,
    'status', 'voided',
    'rows_voided', v_rows_voided,
    'irregularities_superseded', v_irregs_superseded,
    'orders_returned_to_pending', coalesce(cardinality(v_order_ids), 0),
    'unassigned_left_as_is', v_cnt_unassigned,
    'resolved_kept_intact', v_irreg_resolved
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.rpc_cod_void_confirmed_remittance(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_cod_void_confirmed_remittance(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.rpc_cod_void_confirmed_remittance(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cod_void_confirmed_remittance(uuid, text) TO service_role;

COMMENT ON FUNCTION public.rpc_cod_void_confirmed_remittance(uuid, text) IS
  'Fase 6D: anula rendición confirmed → voided. Filas confirmed_* → void (snapshots intactos). Irreg open/in_review → superseded remittance_voided. Resolved intactas. Locks UUID-ordered. No DELETE. No muta orders/aliases.';
