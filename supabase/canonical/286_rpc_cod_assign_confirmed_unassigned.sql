-- 286_rpc_cod_assign_confirmed_unassigned.sql
--
-- Fase 6B — Asignar fila unassigned de una rendición YA confirmada.
-- EFECTO FINANCIERO inmediato (confirmed_matched | confirmed_with_irregularity + irreg open).
--
-- NO reutiliza rpc_cod_assign_row (279): esa RPC exige status=analyzed y solo llega a
-- approved_pending_confirmation (sin efecto financiero).
-- NO modifica 279/280.
-- NO reabre la cabecera (cod_remittances.status permanece 'confirmed').
--
-- Firma:
--   rpc_cod_assign_confirmed_unassigned_row(
--     p_remittance_id uuid,
--     p_row_id uuid,
--     p_order_id uuid,
--     p_force boolean DEFAULT false,
--     p_matched_name_snapshot text DEFAULT NULL,
--     p_matched_name_source text DEFAULT NULL
--   ) → jsonb
--
-- Concurrencia: SELECT orders ... FOR UPDATE antes de validar confirmed_*.
-- Defensa final: uq_cod_rows_matched_order_active.
-- Evento: manual_assignment (new_state.financial_effect=true, phase='6b').
-- amount_diff = reported - expected (paridad 280).

CREATE OR REPLACE FUNCTION public.rpc_cod_assign_confirmed_unassigned_row(
  p_remittance_id uuid,
  p_row_id uuid,
  p_order_id uuid,
  p_force boolean DEFAULT false,
  p_matched_name_snapshot text DEFAULT NULL,
  p_matched_name_source text DEFAULT NULL
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
  v_warnings jsonb := '[]'::jsonb;
  v_day_diff int;
  v_amt_diff numeric;
  v_name_source text;
  v_matched_name text;
  v_name_ok boolean;
  v_reported numeric(12,2);
  v_expected numeric(12,2);
  v_diff numeric(12,2);
  v_diff_pct numeric(6,3);
  v_new_status text;
  v_irreg_id uuid;
  v_ord_id uuid;
  v_ord_number text;
  v_ord_status text;
  v_ord_payment text;
  v_ord_sent_at timestamptz;
  v_ord_closed_at timestamptz;
  v_live_amount numeric(12,2);
  v_conflicting text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.has_permission(v_uid, 'conciliacion-reembolso', 'edit') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_remittance_id IS NULL OR p_row_id IS NULL OR p_order_id IS NULL THEN
    RAISE EXCEPTION 'params_required';
  END IF;

  SELECT * INTO v_rem
  FROM public.cod_remittances
  WHERE id = p_remittance_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'remittance_not_found'; END IF;
  IF v_rem.status <> 'confirmed' THEN
    RAISE EXCEPTION 'remittance_not_confirmed status=%', v_rem.status;
  END IF;

  SELECT * INTO v_row
  FROM public.cod_remittance_rows
  WHERE id = p_row_id AND remittance_id = p_remittance_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'row_not_in_remittance'; END IF;
  IF v_row.row_status <> 'unassigned' THEN
    RAISE EXCEPTION 'row_not_unassigned status=%', v_row.row_status;
  END IF;
  IF v_row.parsed_amount IS NULL THEN
    RAISE EXCEPTION 'row_missing_parsed_amount row_id=%', v_row.id;
  END IF;

  -- 1) Lock pedido ANTES de validar doble conciliación / universo
  SELECT
    o.id,
    o.order_number,
    round(COALESCE(o.total_amount, 0)::numeric, 2),
    o.status,
    o.payment_method,
    o.sent_at,
    o.closed_at
  INTO
    v_ord_id,
    v_ord_number,
    v_live_amount,
    v_ord_status,
    v_ord_payment,
    v_ord_sent_at,
    v_ord_closed_at
  FROM public.orders o
  WHERE o.id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'matched_order_not_found order_id=%', p_order_id;
  END IF;

  -- 2) Universo COD (hard — no forceable)
  IF v_ord_status <> 'sent'
     OR v_ord_payment <> 'Contra Reembolso'
     OR COALESCE(v_ord_sent_at, v_ord_closed_at)::date < DATE '2026-05-01'
     OR EXISTS (SELECT 1 FROM public.local_orders lo WHERE lo.source_order_id = p_order_id)
  THEN
    RAISE EXCEPTION 'matched_order_not_in_cod_universe order_id=%', p_order_id;
  END IF;

  -- 3) Ya conciliado confirmed_* (post-lock)
  IF EXISTS (
    SELECT 1 FROM public.cod_remittance_rows r
    WHERE r.matched_order_id = p_order_id
      AND r.row_status IN ('confirmed_matched', 'confirmed_with_irregularity')
  ) THEN
    v_conflicting := COALESCE(v_ord_number, p_order_id::text);
    RAISE EXCEPTION
      'order_confirmed_elsewhere order=% msg=%',
      v_conflicting,
      format('El pedido %s ya está conciliado.', v_conflicting);
  END IF;

  -- Snapshots auxiliares (nombres / transporte) vía helper existente
  SELECT * INTO v_snap FROM public._cod_load_order_financial_snapshots(p_order_id);
  IF NOT FOUND OR v_snap.sent_date IS NULL THEN
    RAISE EXCEPTION 'matched_order_not_in_cod_universe order_id=%', p_order_id;
  END IF;

  -- Monto esperado LIVE (paridad con lock)
  v_expected := v_live_amount;
  v_reported := round(v_row.parsed_amount::numeric, 2);
  v_diff := round((v_reported - v_expected)::numeric, 2);

  -- Warnings (forceables)
  IF v_snap.transport_id IS DISTINCT FROM v_rem.transport_id THEN
    v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
      'code', 'transport_mismatch',
      'message', 'Transporte efectivo distinto al de la rendición'
    ));
  END IF;

  IF v_row.parsed_transport_date IS NOT NULL THEN
    v_day_diff := abs(v_row.parsed_transport_date - v_snap.sent_date);
    IF v_day_diff > 3 THEN
      v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
        'code', 'date_far',
        'message', format('Fecha alejada (%s días)', v_day_diff),
        'day_diff', v_day_diff
      ));
    END IF;
  END IF;

  IF abs(v_diff) >= 0.005 THEN
    v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
      'code', 'amount_diff',
      'message', 'Monto informado distinto al esperado del pedido',
      'amount_diff', v_diff
    ));
  END IF;

  v_name_source := NULLIF(trim(COALESCE(p_matched_name_source, '')), '');
  v_matched_name := NULLIF(trim(COALESCE(p_matched_name_snapshot, '')), '');
  IF (v_name_source IS NULL) <> (v_matched_name IS NULL) THEN
    RAISE EXCEPTION 'matched_name_source_snapshot_mismatch';
  END IF;
  IF v_name_source IS NOT NULL THEN
    IF v_name_source NOT IN ('label', 'titular', 'sub_name') THEN
      RAISE EXCEPTION 'invalid_matched_name_source';
    END IF;
    v_name_ok := false;
    IF v_name_source = 'label' THEN
      v_name_ok := public._cod_normalize_match_name(v_matched_name)
                = public._cod_normalize_match_name(v_snap.label_name);
    ELSIF v_name_source = 'titular' THEN
      v_name_ok := public._cod_normalize_match_name(v_matched_name)
                = public._cod_normalize_match_name(v_snap.titular_name);
    ELSE
      SELECT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(v_snap.additional_names, '[]'::jsonb)) e
        WHERE public._cod_normalize_match_name(v_matched_name)
            = public._cod_normalize_match_name(
                COALESCE(
                  NULLIF(trim(e.value->>'full_name'), ''),
                  NULLIF(trim(COALESCE(e.value->>'first_name','') || ' ' || COALESCE(e.value->>'last_name','')), ''),
                  NULLIF(trim(e.value->>'name'), '')
                )
              )
      ) INTO v_name_ok;
    END IF;
    IF NOT COALESCE(v_name_ok, false) THEN
      v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
        'code', 'name_weak',
        'message', 'Nombre informado no coincide con la identidad declarada del pedido'
      ));
    END IF;
  ELSE
    v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
      'code', 'name_unverified',
      'message', 'Asignación sin validación explícita de nombre'
    ));
  END IF;

  IF jsonb_array_length(v_warnings) > 0 AND NOT COALESCE(p_force, false) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'needs_force',
      'warnings', v_warnings,
      'order_id', p_order_id,
      'expected_amount', v_expected,
      'reported_amount', v_reported,
      'amount_diff', v_diff,
      'order_number', v_snap.order_number,
      'will_create_irregularity', abs(v_diff) >= 0.005
    );
  END IF;

  IF abs(v_diff) < 0.005 THEN
    v_new_status := 'confirmed_matched';

    UPDATE public.cod_remittance_rows SET
      row_status = 'confirmed_matched',
      matched_order_id = p_order_id,
      assignment_method = 'manual',
      order_number_snapshot = v_snap.order_number,
      expected_amount_snapshot = v_expected,
      order_sent_date_snapshot = v_snap.sent_date,
      order_sent_date_origin = v_snap.sent_origin,
      transport_name_snapshot = v_snap.transport_name,
      matched_name_snapshot = v_matched_name,
      matched_name_source = v_name_source,
      transport_mismatch = (v_snap.transport_id IS DISTINCT FROM v_rem.transport_id),
      will_create_irregularity = false,
      matched_via_broadened_search = COALESCE(matched_via_broadened_search, false)
        OR (v_snap.transport_id IS DISTINCT FROM v_rem.transport_id),
      assigned_by = v_uid,
      assigned_at = now(),
      updated_at = now()
    WHERE id = p_row_id AND remittance_id = p_remittance_id;
  ELSE
    v_new_status := 'confirmed_with_irregularity';
    v_diff_pct := CASE
      WHEN abs(v_expected) < 0.005 THEN NULL
      ELSE round((v_diff / abs(v_expected) * 100)::numeric, 3)
    END;

    UPDATE public.cod_remittance_rows SET
      row_status = 'confirmed_with_irregularity',
      matched_order_id = p_order_id,
      assignment_method = 'manual',
      order_number_snapshot = v_snap.order_number,
      expected_amount_snapshot = v_expected,
      order_sent_date_snapshot = v_snap.sent_date,
      order_sent_date_origin = v_snap.sent_origin,
      transport_name_snapshot = v_snap.transport_name,
      matched_name_snapshot = v_matched_name,
      matched_name_source = v_name_source,
      transport_mismatch = (v_snap.transport_id IS DISTINCT FROM v_rem.transport_id),
      will_create_irregularity = true,
      matched_via_broadened_search = COALESCE(matched_via_broadened_search, false)
        OR (v_snap.transport_id IS DISTINCT FROM v_rem.transport_id),
      assigned_by = v_uid,
      assigned_at = now(),
      updated_at = now()
    WHERE id = p_row_id AND remittance_id = p_remittance_id;

    INSERT INTO public.cod_irregularities (
      remittance_row_id,
      order_id,
      remittance_id,
      transport_id,
      order_sent_date_snapshot,
      remittance_date_snapshot,
      expected_amount,
      reported_amount,
      amount_diff,
      amount_diff_pct,
      status,
      created_by
    ) VALUES (
      p_row_id,
      p_order_id,
      p_remittance_id,
      v_rem.transport_id,
      v_snap.sent_date,
      v_rem.remittance_date,
      v_expected,
      v_reported,
      v_diff,
      v_diff_pct,
      'open',
      v_uid
    )
    RETURNING id INTO v_irreg_id;

    INSERT INTO public.cod_reconciliation_events (
      remittance_id, remittance_row_id, irregularity_id, event_type, actor_id, new_state, reason
    ) VALUES (
      p_remittance_id,
      p_row_id,
      v_irreg_id,
      'irregularity_created',
      v_uid,
      jsonb_build_object(
        'amount_diff', v_diff,
        'expected_amount', v_expected,
        'reported_amount', v_reported,
        'order_id', p_order_id,
        'phase', '6b'
      ),
      'Irregularidad creada al asignar pago sin identificar (post-confirmación)'
    );
  END IF;

  INSERT INTO public.cod_reconciliation_events (
    remittance_id, remittance_row_id, irregularity_id, event_type, actor_id,
    previous_state, new_state, reason
  ) VALUES (
    p_remittance_id,
    p_row_id,
    v_irreg_id,
    'manual_assignment',
    v_uid,
    jsonb_build_object('row_status', 'unassigned', 'matched_order_id', NULL),
    jsonb_build_object(
      'row_status', v_new_status,
      'matched_order_id', p_order_id,
      'assignment_method', 'manual',
      'expected_amount_snapshot', v_expected,
      'reported_amount', v_reported,
      'amount_diff', v_diff,
      'financial_effect', true,
      'phase', '6b',
      'forced', COALESCE(p_force, false),
      'warnings', v_warnings,
      'irregularity_id', v_irreg_id
    ),
    'Asignación de pago sin identificar en rendición confirmada (efecto financiero)'
  );

  -- Cabecera: solo touch updated_at; status sigue confirmed
  UPDATE public.cod_remittances SET updated_at = now() WHERE id = p_remittance_id;

  RETURN jsonb_build_object(
    'ok', true,
    'remittance_id', p_remittance_id,
    'row_id', p_row_id,
    'matched_order_id', p_order_id,
    'row_status', v_new_status,
    'expected_amount', v_expected,
    'reported_amount', v_reported,
    'amount_diff', v_diff,
    'irregularity_id', v_irreg_id,
    'warnings', v_warnings
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.rpc_cod_assign_confirmed_unassigned_row(uuid, uuid, uuid, boolean, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_cod_assign_confirmed_unassigned_row(uuid, uuid, uuid, boolean, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.rpc_cod_assign_confirmed_unassigned_row(uuid, uuid, uuid, boolean, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cod_assign_confirmed_unassigned_row(uuid, uuid, uuid, boolean, text, text) TO service_role;

COMMENT ON FUNCTION public.rpc_cod_assign_confirmed_unassigned_row(uuid, uuid, uuid, boolean, text, text) IS
  'Fase 6B: asigna fila unassigned de rendición confirmed → confirmed_* (+ irreg si diff). FOR UPDATE orders. No reabre cabecera. No muta orders.';
