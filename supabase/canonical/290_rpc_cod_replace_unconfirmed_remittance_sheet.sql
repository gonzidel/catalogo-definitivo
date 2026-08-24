-- 290_rpc_cod_replace_unconfirmed_remittance_sheet.sql
--
-- Reemplaza planilla de rendicion no confirmada (draft/analyzed).
-- Fuente: dump live fyl-core.
--
CREATE OR REPLACE FUNCTION public.rpc_cod_replace_unconfirmed_remittance_sheet(p_remittance_id uuid, p_reason text, p_remittance_date date, p_reported_total numeric, p_content_hash text, p_rows jsonb, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_rem public.cod_remittances%ROWTYPE;
  v_reason text;
  v_old_revision int;
  v_new_revision int;
  v_old_row_count int;
  v_old_approved int := 0;
  v_row jsonb;
  v_idx int;
  v_raw_line text;
  v_raw_date text;
  v_raw_name text;
  v_raw_amount text;
  v_parsed_date date;
  v_parsed_amount numeric(12,2);
  v_client_date date;
  v_client_amount numeric(12,2);
  v_calc_total numeric(14,2) := 0;
  v_row_count int := 0;
  v_seen_indexes int[] := ARRAY[]::int[];
  v_row_index int;
  v_norm jsonb := '[]'::jsonb;
  v_now timestamptz := now();
  v_prev jsonb;
  v_new jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.has_permission(v_uid, 'conciliacion-reembolso', 'edit') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_remittance_id IS NULL THEN RAISE EXCEPTION 'params_required'; END IF;

  v_reason := NULLIF(trim(COALESCE(p_reason, '')), '');
  IF v_reason IS NULL THEN RAISE EXCEPTION 'reason_required'; END IF;

  IF p_remittance_date IS NULL THEN RAISE EXCEPTION 'remittance_date_required'; END IF;
  IF p_reported_total IS NULL OR p_reported_total < 0 THEN
    RAISE EXCEPTION 'invalid_reported_total';
  END IF;
  IF p_content_hash IS NULL OR length(trim(p_content_hash)) < 16 THEN
    RAISE EXCEPTION 'content_hash_invalid';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'rows_must_be_array';
  END IF;

  v_row_count := jsonb_array_length(p_rows);
  IF v_row_count < 1 THEN RAISE EXCEPTION 'rows_empty'; END IF;
  IF v_row_count > 2000 THEN RAISE EXCEPTION 'rows_too_many'; END IF;

  SELECT * INTO v_rem
  FROM public.cod_remittances
  WHERE id = p_remittance_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'remittance_not_found'; END IF;
  IF v_rem.status = 'confirmed' THEN
    RAISE EXCEPTION 'remittance_confirmed_immutable';
  END IF;
  IF v_rem.status = 'voided' THEN
    RAISE EXCEPTION 'remittance_voided_immutable';
  END IF;
  IF v_rem.status NOT IN ('draft', 'analyzed') THEN
    RAISE EXCEPTION 'remittance_not_editable status=%', v_rem.status;
  END IF;

  v_old_revision := COALESCE(v_rem.sheet_revision, 1);
  v_new_revision := v_old_revision + 1;

  PERFORM 1
  FROM public.cod_remittance_rows
  WHERE remittance_id = p_remittance_id
  ORDER BY id
  FOR UPDATE;

  SELECT count(*)::int
  INTO v_old_row_count
  FROM public.cod_remittance_rows
  WHERE remittance_id = p_remittance_id
    AND sheet_revision = v_old_revision;

  SELECT count(*)::int
  INTO v_old_approved
  FROM public.cod_remittance_rows
  WHERE remittance_id = p_remittance_id
    AND sheet_revision = v_old_revision
    AND row_status = 'approved_pending_confirmation';

  FOR v_idx IN 0 .. v_row_count - 1 LOOP
    v_row := p_rows -> v_idx;
    IF v_row IS NULL OR jsonb_typeof(v_row) <> 'object' THEN
      RAISE EXCEPTION 'invalid_row index=%', v_idx;
    END IF;

    IF (v_row ? 'row_index') AND nullif(trim(COALESCE(v_row ->> 'row_index', '')), '') IS NOT NULL THEN
      BEGIN
        v_row_index := (v_row ->> 'row_index')::int;
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'row_index_invalid index=%', v_idx;
      END;
    ELSE
      v_row_index := v_idx;
    END IF;

    IF v_row_index < 0 THEN
      RAISE EXCEPTION 'row_index_negative %', v_row_index;
    END IF;
    IF v_row_index >= v_row_count THEN
      RAISE EXCEPTION 'row_index_out_of_range %', v_row_index;
    END IF;
    IF v_row_index = ANY (v_seen_indexes) THEN
      RAISE EXCEPTION 'duplicate_row_index %', v_row_index;
    END IF;
    v_seen_indexes := array_append(v_seen_indexes, v_row_index);

    v_raw_date := nullif(trim(COALESCE(v_row ->> 'raw_transport_date_text', '')), '');
    v_raw_name := nullif(trim(COALESCE(v_row ->> 'raw_customer_name_text', '')), '');
    v_raw_amount := nullif(trim(COALESCE(v_row ->> 'raw_amount_text', '')), '');
    v_raw_line := nullif(v_row ->> 'raw_line', '');

    IF v_raw_date IS NULL OR v_raw_name IS NULL OR v_raw_amount IS NULL THEN
      RAISE EXCEPTION 'row_missing_raw index=%', v_idx;
    END IF;

    BEGIN
      v_parsed_date := public._cod_parse_remittance_date(v_raw_date);
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'row_invalid_date index=% detail=%', v_idx, SQLERRM;
    END;

    BEGIN
      v_parsed_amount := public._cod_parse_remittance_amount(v_raw_amount);
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'row_invalid_amount index=% detail=%', v_idx, SQLERRM;
    END;

    IF nullif(trim(COALESCE(v_row ->> 'parsed_transport_date', '')), '') IS NOT NULL THEN
      BEGIN
        v_client_date := (v_row ->> 'parsed_transport_date')::date;
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'row_client_date_invalid index=%', v_idx;
      END;
      IF v_client_date IS DISTINCT FROM v_parsed_date THEN
        RAISE EXCEPTION 'row_parsed_date_mismatch index=%', v_idx;
      END IF;
    END IF;

    IF v_row ? 'parsed_amount' AND v_row ->> 'parsed_amount' IS NOT NULL THEN
      BEGIN
        v_client_amount := round((v_row ->> 'parsed_amount')::numeric, 2);
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'row_client_amount_invalid index=%', v_idx;
      END;
      IF v_client_amount IS DISTINCT FROM v_parsed_amount THEN
        RAISE EXCEPTION 'row_parsed_amount_mismatch index=%', v_idx;
      END IF;
    END IF;

    v_calc_total := v_calc_total + v_parsed_amount;
    v_norm := v_norm || jsonb_build_array(jsonb_build_object(
      'row_index', v_row_index,
      'raw_line', v_raw_line,
      'raw_transport_date_text', v_raw_date,
      'raw_customer_name_text', v_raw_name,
      'raw_amount_text', v_raw_amount,
      'parsed_transport_date', to_char(v_parsed_date, 'YYYY-MM-DD'),
      'parsed_amount', v_parsed_amount
    ));
  END LOOP;

  IF coalesce(array_length(v_seen_indexes, 1), 0) <> v_row_count THEN
    RAISE EXCEPTION 'row_index_coverage_incomplete expected=% got=%',
      v_row_count, coalesce(array_length(v_seen_indexes, 1), 0);
  END IF;
  FOR v_idx IN 0 .. v_row_count - 1 LOOP
    IF NOT (v_idx = ANY (v_seen_indexes)) THEN
      RAISE EXCEPTION 'row_index_gap missing=%', v_idx;
    END IF;
  END LOOP;

  FOR v_idx IN 0 .. v_row_count - 1 LOOP
    v_row := v_norm -> v_idx;
    INSERT INTO public.cod_remittance_rows (
      remittance_id,
      sheet_revision,
      row_index,
      raw_line,
      raw_transport_date_text,
      raw_customer_name_text,
      raw_amount_text,
      parsed_transport_date,
      parsed_amount,
      parse_errors,
      row_status
    ) VALUES (
      p_remittance_id,
      v_new_revision,
      (v_row ->> 'row_index')::int,
      nullif(v_row ->> 'raw_line', ''),
      v_row ->> 'raw_transport_date_text',
      v_row ->> 'raw_customer_name_text',
      v_row ->> 'raw_amount_text',
      (v_row ->> 'parsed_transport_date')::date,
      round((v_row ->> 'parsed_amount')::numeric, 2),
      '[]'::jsonb,
      'pending_analysis'
    );
  END LOOP;

  UPDATE public.cod_remittances
  SET
    remittance_date = p_remittance_date,
    reported_total = round(p_reported_total, 2),
    calculated_total = round(v_calc_total, 2),
    row_count = v_row_count,
    content_hash = trim(p_content_hash),
    notes = nullif(trim(COALESCE(p_notes, '')), ''),
    status = 'draft',
    analyzed_at = NULL,
    sheet_revision = v_new_revision,
    sheet_edited_by = v_uid,
    sheet_edited_at = v_now,
    sheet_edit_reason = v_reason,
    sheet_edit_count = COALESCE(sheet_edit_count, 0) + 1,
    updated_at = v_now
  WHERE id = p_remittance_id;

  v_prev := jsonb_build_object(
    'old_sheet_revision', v_old_revision,
    'old_row_count', v_old_row_count,
    'old_reported_total', v_rem.reported_total,
    'old_remittance_date', to_char(v_rem.remittance_date, 'YYYY-MM-DD'),
    'old_status', v_rem.status,
    'approved_count', v_old_approved
  );
  v_new := jsonb_build_object(
    'new_sheet_revision', v_new_revision,
    'new_row_count', v_row_count,
    'new_reported_total', round(p_reported_total, 2),
    'new_calculated_total', round(v_calc_total, 2),
    'new_remittance_date', to_char(p_remittance_date, 'YYYY-MM-DD'),
    'new_status', 'draft',
    'analysis_invalidated', true,
    'transport_id_unchanged', v_rem.transport_id
  );

  INSERT INTO public.cod_reconciliation_events (
    remittance_id,
    remittance_row_id,
    irregularity_id,
    event_type,
    actor_id,
    occurred_at,
    previous_state,
    new_state,
    reason
  ) VALUES (
    p_remittance_id,
    NULL,
    NULL,
    'remittance_edited',
    v_uid,
    v_now,
    v_prev,
    v_new,
    v_reason
  );

  RETURN jsonb_build_object(
    'ok', true,
    'remittance_id', p_remittance_id,
    'old_sheet_revision', v_old_revision,
    'new_sheet_revision', v_new_revision,
    'old_row_count', v_old_row_count,
    'new_row_count', v_row_count,
    'approvals_superseded', v_old_approved,
    'calculated_total', round(v_calc_total, 2),
    'reported_total', round(p_reported_total, 2),
    'status', 'draft',
    'analysis_invalidated', true
  );
END;
$function$
