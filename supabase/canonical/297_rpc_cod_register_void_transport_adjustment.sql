-- 297_rpc_cod_register_void_transport_adjustment.sql
--
-- rpc_cod_register_transport_adjustment
-- rpc_cod_void_transport_adjustment
--
-- V1: solo direction=transport_credit.
-- Monto siempre desde row.parsed_amount (no confiar en frontend).
-- Fila → classified_adjustment (no confirmed_matched).
-- NO APPLY hasta aprobación.

CREATE OR REPLACE FUNCTION public.rpc_cod_register_transport_adjustment(
  p_remittance_id uuid,
  p_row_id uuid,
  p_kind text,
  p_observation text DEFAULT NULL,
  p_order_id uuid DEFAULT NULL,
  p_customer_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_rem public.cod_remittances%ROWTYPE;
  v_row public.cod_remittance_rows%ROWTYPE;
  v_kind text;
  v_obs text;
  v_amount numeric(12,2);
  v_adj_id uuid;
  v_order_pm text;
  v_order_customer uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.has_permission(v_uid, 'conciliacion-reembolso', 'edit') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_remittance_id IS NULL OR p_row_id IS NULL THEN
    RAISE EXCEPTION 'remittance_and_row_required';
  END IF;

  v_kind := lower(trim(COALESCE(p_kind, '')));
  IF v_kind NOT IN (
    'paid_other_method',
    'non_applicable_payment',
    'order_not_found',
    'foreign_client',
    'transport_error',
    'other'
  ) THEN
    RAISE EXCEPTION 'invalid_adjustment_kind';
  END IF;

  v_obs := NULLIF(trim(COALESCE(p_observation, '')), '');
  IF v_obs IS NOT NULL AND char_length(v_obs) > 2000 THEN
    RAISE EXCEPTION 'observation_too_long';
  END IF;

  SELECT * INTO v_rem
  FROM public.cod_remittances
  WHERE id = p_remittance_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'remittance_not_found'; END IF;

  IF v_rem.status = 'voided' THEN
    RAISE EXCEPTION 'remittance_voided';
  END IF;
  IF v_rem.status NOT IN ('analyzed', 'confirmed') THEN
    RAISE EXCEPTION 'remittance_status_not_eligible';
  END IF;

  SELECT * INTO v_row
  FROM public.cod_remittance_rows
  WHERE id = p_row_id
    AND remittance_id = p_remittance_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'row_not_found'; END IF;

  IF v_row.sheet_revision IS DISTINCT FROM COALESCE(v_rem.sheet_revision, 1) THEN
    RAISE EXCEPTION 'row_not_in_current_sheet_revision';
  END IF;

  -- No COD confirmado / no supplementary / no ya clasificada
  IF v_row.row_status IN ('confirmed_matched', 'confirmed_with_irregularity') THEN
    RAISE EXCEPTION 'row_already_confirmed_cod';
  END IF;
  IF COALESCE(v_row.assignment_role, 'primary') = 'supplementary' THEN
    RAISE EXCEPTION 'row_is_supplementary';
  END IF;
  IF v_row.row_status = 'classified_adjustment' THEN
    RAISE EXCEPTION 'row_already_classified_adjustment';
  END IF;
  IF v_row.row_status = 'void' THEN
    RAISE EXCEPTION 'row_void';
  END IF;
  IF v_row.row_status NOT IN (
    'unassigned',
    'needs_review',
    'auto_matched',
    'approved_pending_confirmation',
    'pending_analysis'
  ) THEN
    RAISE EXCEPTION 'row_status_not_eligible';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.cod_transport_adjustments a
    WHERE a.remittance_row_id = p_row_id
      AND a.status <> 'voided'
  ) THEN
    RAISE EXCEPTION 'adjustment_already_active_for_row';
  END IF;

  v_amount := COALESCE(v_row.parsed_amount, 0);
  IF v_amount <= 0.004 THEN
    RAISE EXCEPTION 'parsed_amount_invalid';
  END IF;

  -- order_id opcional: referencia informativa; NO exige COD / NO muta order
  IF p_order_id IS NOT NULL THEN
    SELECT payment_method, customer_id
    INTO v_order_pm, v_order_customer
    FROM public.orders
    WHERE id = p_order_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'order_not_found'; END IF;
    IF p_customer_id IS NULL THEN
      p_customer_id := v_order_customer;
    END IF;
  END IF;

  INSERT INTO public.cod_transport_adjustments (
    transport_id,
    direction,
    kind,
    original_amount,
    remaining_amount,
    status,
    remittance_id,
    remittance_row_id,
    order_id,
    customer_id,
    raw_name_snapshot,
    remittance_date_snapshot,
    reported_amount_snapshot,
    observation,
    created_by
  ) VALUES (
    v_rem.transport_id,
    'transport_credit',
    v_kind,
    v_amount,
    v_amount,
    'open',
    p_remittance_id,
    p_row_id,
    p_order_id,
    p_customer_id,
    v_row.raw_customer_name_text,
    v_rem.remittance_date,
    v_amount,
    v_obs,
    v_uid
  )
  RETURNING id INTO v_adj_id;

  UPDATE public.cod_remittance_rows SET
    row_status = 'classified_adjustment',
    will_create_irregularity = false,
    updated_at = now()
  WHERE id = p_row_id;

  INSERT INTO public.cod_reconciliation_events (
    remittance_id, remittance_row_id, event_type, actor_id,
    previous_state, new_state, reason
  ) VALUES (
    p_remittance_id,
    p_row_id,
    'transport_adjustment_registered',
    v_uid,
    jsonb_build_object('row_status', v_row.row_status),
    jsonb_build_object(
      'row_status', 'classified_adjustment',
      'adjustment_id', v_adj_id,
      'direction', 'transport_credit',
      'kind', v_kind,
      'original_amount', v_amount,
      'order_id', p_order_id,
      'order_payment_method', v_order_pm
    ),
    COALESCE(v_obs, 'Crédito a favor del transporte registrado')
  );

  RETURN jsonb_build_object(
    'ok', true,
    'adjustment_id', v_adj_id,
    'direction', 'transport_credit',
    'kind', v_kind,
    'original_amount', v_amount,
    'remaining_amount', v_amount,
    'row_status', 'classified_adjustment',
    'transport_id', v_rem.transport_id,
    'order_id', p_order_id,
    'order_untouched', true
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.rpc_cod_void_transport_adjustment(
  p_adjustment_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_adj public.cod_transport_adjustments%ROWTYPE;
  v_reason text;
  v_prev_row_status text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.has_permission(v_uid, 'conciliacion-reembolso', 'edit') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_adjustment_id IS NULL THEN RAISE EXCEPTION 'adjustment_id_required'; END IF;

  SELECT * INTO v_adj
  FROM public.cod_transport_adjustments
  WHERE id = p_adjustment_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'adjustment_not_found'; END IF;

  IF v_adj.status = 'voided' THEN
    RAISE EXCEPTION 'adjustment_already_voided';
  END IF;

  -- V1: si ya se usó en compensación, rechazar
  IF abs(v_adj.remaining_amount - v_adj.original_amount) >= 0.005
     OR v_adj.status IN ('partially_compensated', 'compensated')
     OR EXISTS (
       SELECT 1
       FROM public.cod_transport_compensation_lines l
       INNER JOIN public.cod_transport_compensations c ON c.id = l.compensation_id
       WHERE l.source_type = 'adjustment'
         AND l.source_id = p_adjustment_id
         AND c.status = 'applied'
     )
  THEN
    RAISE EXCEPTION 'adjustment_has_compensations';
  END IF;

  v_reason := NULLIF(trim(COALESCE(p_reason, '')), '');
  IF v_reason IS NULL THEN
    v_reason := 'Ajuste anulado sin uso en compensación';
  END IF;

  UPDATE public.cod_transport_adjustments SET
    status = 'voided',
    remaining_amount = 0,
    voided_by = v_uid,
    voided_at = now(),
    void_reason = v_reason,
    updated_at = now()
  WHERE id = p_adjustment_id;

  -- Devolver fila a unassigned operativo (sigue en rendición para auditoría)
  SELECT row_status INTO v_prev_row_status
  FROM public.cod_remittance_rows
  WHERE id = v_adj.remittance_row_id
  FOR UPDATE;

  IF v_prev_row_status = 'classified_adjustment' THEN
    UPDATE public.cod_remittance_rows SET
      row_status = 'unassigned',
      updated_at = now()
    WHERE id = v_adj.remittance_row_id;
  END IF;

  INSERT INTO public.cod_reconciliation_events (
    remittance_id, remittance_row_id, event_type, actor_id,
    previous_state, new_state, reason
  ) VALUES (
    v_adj.remittance_id,
    v_adj.remittance_row_id,
    'transport_adjustment_voided',
    v_uid,
    jsonb_build_object(
      'adjustment_id', p_adjustment_id,
      'status', v_adj.status,
      'remaining_amount', v_adj.remaining_amount
    ),
    jsonb_build_object(
      'adjustment_id', p_adjustment_id,
      'status', 'voided',
      'row_status', 'unassigned'
    ),
    v_reason
  );

  RETURN jsonb_build_object(
    'ok', true,
    'adjustment_id', p_adjustment_id,
    'status', 'voided',
    'row_status', 'unassigned'
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.rpc_cod_register_transport_adjustment(uuid, uuid, text, text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_cod_register_transport_adjustment(uuid, uuid, text, text, uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.rpc_cod_register_transport_adjustment(uuid, uuid, text, text, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cod_register_transport_adjustment(uuid, uuid, text, text, uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.rpc_cod_void_transport_adjustment(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_cod_void_transport_adjustment(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.rpc_cod_void_transport_adjustment(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cod_void_transport_adjustment(uuid, text) TO service_role;

COMMENT ON FUNCTION public.rpc_cod_register_transport_adjustment(uuid, uuid, text, text, uuid, uuid) IS
  '295/297 V1: registra crédito transport_credit desde fila; monto=parsed_amount DB; fila→classified_adjustment; no muta orders.';

COMMENT ON FUNCTION public.rpc_cod_void_transport_adjustment(uuid, text) IS
  '297 V1: void solo si remaining=original (sin compensaciones). Rechaza adjustment_has_compensations.';

SELECT pg_notify('pgrst', 'reload schema');
