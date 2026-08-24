-- 293_rpc_cod_approve_complementary_payment.sql
-- Helper de saldo + aprobación SIN efecto financiero. NO APLICADA.

CREATE OR REPLACE FUNCTION public._cod_load_order_cod_balance(p_order_id uuid)
RETURNS TABLE (
  expected_total numeric(12,2),
  active_reported_total numeric(12,2),
  remaining_balance numeric(12,2),
  primary_count int,
  supplementary_count int,
  active_payment_count int,
  primary_row_id uuid,
  primary_remittance_id uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_expected numeric(12,2);
BEGIN
  SELECT round(COALESCE(o.total_amount, 0)::numeric, 2)
  INTO v_expected
  FROM public.orders o
  WHERE o.id = p_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_not_found';
  END IF;

  RETURN QUERY
  WITH active_payments AS (
    SELECT
      rr.id,
      rr.remittance_id,
      COALESCE(rr.assignment_role, 'primary') AS assignment_role,
      round(rr.parsed_amount::numeric, 2) AS amount
    FROM public.cod_remittance_rows rr
    INNER JOIN public.cod_remittances r
      ON r.id = rr.remittance_id
     AND COALESCE(r.sheet_revision, 1) = COALESCE(rr.sheet_revision, 1)
    WHERE rr.matched_order_id = p_order_id
      AND rr.row_status IN ('confirmed_matched', 'confirmed_with_irregularity')
      AND r.status <> 'voided'
  )
  SELECT
    v_expected,
    COALESCE(sum(p.amount), 0)::numeric(12,2),
    round((v_expected - COALESCE(sum(p.amount), 0))::numeric, 2)::numeric(12,2),
    count(*) FILTER (WHERE p.assignment_role = 'primary')::int,
    count(*) FILTER (WHERE p.assignment_role = 'supplementary')::int,
    count(*)::int,
    (array_agg(p.id ORDER BY p.id) FILTER (WHERE p.assignment_role = 'primary'))[1],
    (array_agg(p.remittance_id ORDER BY p.id) FILTER (WHERE p.assignment_role = 'primary'))[1]
  FROM active_payments p;
END;
$fn$;

REVOKE ALL ON FUNCTION public._cod_load_order_cod_balance(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._cod_load_order_cod_balance(uuid) FROM anon;
REVOKE ALL ON FUNCTION public._cod_load_order_cod_balance(uuid) FROM authenticated;

COMMENT ON FUNCTION public._cod_load_order_cod_balance(uuid) IS
  'Helper interno: saldo COD confirmado de un pedido. Incluye primary+supplementary vigentes; excluye approved_pending y remesas voided.';

CREATE OR REPLACE FUNCTION public.rpc_cod_approve_complementary_payment(
  p_remittance_id uuid,
  p_row_id uuid,
  p_order_id uuid,
  p_reason text DEFAULT NULL
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
  v_snap record;
  v_bal record;
  v_irreg public.cod_irregularities%ROWTYPE;
  v_irreg_count int;
  v_order_id uuid;
  v_reported numeric(12,2);
  v_projected numeric(12,2);
  v_reason text;
  v_transport_mismatch boolean;
  v_will_irregularity boolean;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.has_permission(v_uid, 'conciliacion-reembolso', 'edit') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_remittance_id IS NULL OR p_row_id IS NULL OR p_order_id IS NULL THEN
    RAISE EXCEPTION 'params_required';
  END IF;

  v_reason := NULLIF(trim(COALESCE(p_reason, '')), '');

  SELECT * INTO v_rem
  FROM public.cod_remittances
  WHERE id = p_remittance_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'remittance_not_found'; END IF;
  IF v_rem.status <> 'analyzed' THEN
    RAISE EXCEPTION 'remittance_not_analyzed status=%', v_rem.status;
  END IF;

  SELECT * INTO v_row
  FROM public.cod_remittance_rows
  WHERE id = p_row_id
    AND remittance_id = p_remittance_id
    AND sheet_revision = COALESCE(v_rem.sheet_revision, 1)
  FOR UPDATE;

  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1 FROM public.cod_remittance_rows
      WHERE id = p_row_id AND remittance_id = p_remittance_id
    ) THEN
      RAISE EXCEPTION 'row_not_in_current_sheet_revision';
    END IF;
    RAISE EXCEPTION 'row_not_in_remittance';
  END IF;

  IF v_row.row_status = 'approved_pending_confirmation' THEN
    IF v_row.matched_order_id IS DISTINCT FROM p_order_id
       OR COALESCE(v_row.assignment_role, 'primary') <> 'supplementary' THEN
      RAISE EXCEPTION 'row_approved_for_other_order';
    END IF;
  ELSIF v_row.row_status NOT IN ('unassigned', 'needs_review', 'auto_matched') THEN
    RAISE EXCEPTION 'row_not_eligible status=%', v_row.row_status;
  END IF;

  IF v_row.parsed_amount IS NULL THEN
    RAISE EXCEPTION 'row_missing_parsed_amount';
  END IF;
  v_reported := round(v_row.parsed_amount::numeric, 2);

  -- Orden primero: serializa approve/confirm/void del mismo saldo.
  SELECT o.id INTO v_order_id
  FROM public.orders o
  WHERE o.id = p_order_id
    AND o.status = 'sent'
    AND o.payment_method = 'Contra Reembolso'
    AND COALESCE(o.sent_at, o.closed_at)::date >= DATE '2026-05-01'
    AND NOT EXISTS (
      SELECT 1 FROM public.local_orders lo WHERE lo.source_order_id = o.id
    )
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'matched_order_not_in_cod_universe order_id=%', p_order_id;
  END IF;

  SELECT * INTO v_bal FROM public._cod_load_order_cod_balance(p_order_id);
  IF v_bal.remaining_balance <= 0.005 THEN
    RAISE EXCEPTION 'remaining_balance_not_positive';
  END IF;
  IF v_bal.primary_count = 0 THEN
    RAISE EXCEPTION 'no_primary_confirmed';
  END IF;
  IF v_bal.primary_count <> 1 THEN
    RAISE EXCEPTION 'order_not_partially_reconciled primary_count=%', v_bal.primary_count;
  END IF;

  SELECT count(*) INTO v_irreg_count
  FROM public.cod_irregularities i
  WHERE i.order_id = p_order_id
    AND i.status IN ('open', 'in_review')
    AND i.amount_diff < -0.005;

  IF v_irreg_count = 0 THEN
    RAISE EXCEPTION 'active_shortage_irregularity_not_found';
  ELSIF v_irreg_count > 1 THEN
    RAISE EXCEPTION 'multiple_active_shortage_irregularities';
  END IF;

  SELECT * INTO v_irreg
  FROM public.cod_irregularities i
  WHERE i.order_id = p_order_id
    AND i.status IN ('open', 'in_review')
    AND i.amount_diff < -0.005
  ORDER BY i.id
  LIMIT 1
  FOR UPDATE;

  IF NOT (
    abs(v_irreg.amount_diff + v_bal.remaining_balance) < 0.005
    OR abs(abs(v_irreg.amount_diff) - v_bal.remaining_balance) < 0.005
  ) THEN
    RAISE EXCEPTION 'shortage_balance_mismatch irregularity=% balance=%',
      v_irreg.amount_diff, v_bal.remaining_balance;
  END IF;

  IF v_reported - v_bal.remaining_balance >= 0.005 THEN
    RAISE EXCEPTION 'payment_exceeds_remaining_balance payment=% balance=%',
      v_reported, v_bal.remaining_balance;
  END IF;

  SELECT * INTO v_snap
  FROM public._cod_load_order_financial_snapshots(p_order_id);
  IF NOT FOUND OR v_snap.sent_date IS NULL THEN
    RAISE EXCEPTION 'matched_order_not_in_cod_universe order_id=%', p_order_id;
  END IF;

  v_transport_mismatch := v_snap.transport_id IS DISTINCT FROM v_rem.transport_id;
  v_projected := round(v_bal.remaining_balance - v_reported, 2);
  v_will_irregularity := abs(v_projected) >= 0.005;

  UPDATE public.cod_remittance_rows SET
    matched_order_id = p_order_id,
    assignment_role = 'supplementary',
    row_status = 'approved_pending_confirmation',
    expected_amount_snapshot = v_bal.remaining_balance,
    assignment_method = 'manual',
    order_number_snapshot = v_snap.order_number,
    order_sent_date_snapshot = v_snap.sent_date,
    order_sent_date_origin = v_snap.sent_origin,
    transport_name_snapshot = v_snap.transport_name,
    transport_mismatch = v_transport_mismatch,
    matched_via_broadened_search =
      COALESCE(matched_via_broadened_search, false) OR v_transport_mismatch,
    will_create_irregularity = v_will_irregularity,
    assigned_by = v_uid,
    assigned_at = now(),
    updated_at = now()
  WHERE id = p_row_id
    AND remittance_id = p_remittance_id
    AND sheet_revision = COALESCE(v_rem.sheet_revision, 1);

  IF NOT FOUND THEN RAISE EXCEPTION 'row_update_failed_concurrently'; END IF;

  INSERT INTO public.cod_reconciliation_events (
    remittance_id, remittance_row_id, irregularity_id, event_type, actor_id,
    previous_state, new_state, reason
  ) VALUES (
    p_remittance_id,
    p_row_id,
    v_irreg.id,
    'complementary_payment_approved',
    v_uid,
    jsonb_build_object(
      'row_status', v_row.row_status,
      'matched_order_id', v_row.matched_order_id,
      'assignment_role', COALESCE(v_row.assignment_role, 'primary')
    ),
    jsonb_build_object(
      'row_status', 'approved_pending_confirmation',
      'matched_order_id', p_order_id,
      'assignment_role', 'supplementary',
      'order_expected_total', v_bal.expected_total,
      'active_reported_before', v_bal.active_reported_total,
      'balance_before', v_bal.remaining_balance,
      'this_payment', v_reported,
      'projected_remaining_after_confirm', v_projected,
      'expected_amount_snapshot', v_bal.remaining_balance,
      'transport_mismatch', v_transport_mismatch,
      'financial_effect', 'none_until_confirm'
    ),
    COALESCE(v_reason, 'Aprobación de pago complementario; sin efecto financiero hasta confirmar la rendición')
  );

  RETURN jsonb_build_object(
    'ok', true,
    'remittance_id', p_remittance_id,
    'row_id', p_row_id,
    'order_id', p_order_id,
    'assignment_role', 'supplementary',
    'row_status', 'approved_pending_confirmation',
    'expected_total', v_bal.expected_total,
    'active_reported_total', v_bal.active_reported_total,
    'remaining_balance_before', v_bal.remaining_balance,
    'this_payment', v_reported,
    'projected_remaining_after_confirm', v_projected,
    'transport_mismatch', v_transport_mismatch,
    'will_create_irregularity', v_will_irregularity,
    'financial_effect', 'none_until_confirm'
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.rpc_cod_approve_complementary_payment(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_cod_approve_complementary_payment(uuid, uuid, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.rpc_cod_approve_complementary_payment(uuid, uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cod_approve_complementary_payment(uuid, uuid, uuid, text) TO service_role;

COMMENT ON FUNCTION public.rpc_cod_approve_complementary_payment(uuid, uuid, uuid, text) IS
  'Aprueba una fila supplementary contra el saldo COD vivo. No produce efecto financiero hasta rpc_cod_confirm_remittance.';
