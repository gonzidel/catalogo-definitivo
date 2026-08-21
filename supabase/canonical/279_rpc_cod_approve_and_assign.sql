-- 279_rpc_cod_approve_and_assign.sql
--
-- Fase 5 — Aprobación / asignación manual (SIN efecto financiero).
-- ESTADO: preparada localmente. NO aplicar en producción sin autorización explícita.
--
-- Funciones:
--   1) rpc_cod_approve_auto_matched(p_remittance_id uuid) → jsonb
--      Aprueba en bloque todas las filas auto_matched → approved_pending_confirmation
--
--   2) rpc_cod_assign_row(
--        p_remittance_id uuid,
--        p_row_id uuid,
--        p_order_id uuid,
--        p_force boolean DEFAULT false,
--        p_matched_name_snapshot text DEFAULT NULL,
--        p_matched_name_source text DEFAULT NULL
--      ) → jsonb
--      Asigna/aprueba un pedido a una fila (needs_review / unassigned / auto_matched / re-asignación).
--      Snapshots financieros SIEMPRE desde DB. Si hay warnings y p_force=false → needs_force.
--
--   3) rpc_cod_mark_row_unassigned(p_remittance_id uuid, p_row_id uuid) → jsonb
--      Deja la fila sin identificar (limpia match).
--
-- Precondición de las 3 RPCs: cod_remittances.status = 'analyzed' (no draft).
-- parsed_amount obligatorio para approved_pending_confirmation (p_force no lo salta).
-- No crea irregularidades. No confirma. No muta orders. No hace draft→analyzed.

-- ---------------------------------------------------------------------------
-- Helper: cargar snapshots financieros de un pedido COD (universo V1)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._cod_load_order_financial_snapshots(p_order_id uuid)
RETURNS TABLE (
  order_number text,
  expected_amount numeric,
  sent_date date,
  sent_origin text,
  transport_id uuid,
  transport_name text,
  label_name text,
  titular_name text,
  additional_names jsonb
)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_catalog'
AS $fn$
BEGIN
  RETURN QUERY
  SELECT
    o.order_number,
    round(COALESCE(o.total_amount, 0)::numeric, 2),
    (COALESCE(o.sent_at, o.closed_at))::date,
    CASE WHEN o.sent_at IS NOT NULL THEN 'sent_at' ELSE 'closed_at_fallback' END,
    COALESCE(o.transport_id, c.transport_id),
    t.name,
    o.label_customer_name,
    c.full_name,
    COALESCE(c.additional_names, '[]'::jsonb)
  FROM public.orders o
  INNER JOIN public.customers c ON c.id = o.customer_id
  LEFT JOIN public.transports t ON t.id = COALESCE(o.transport_id, c.transport_id)
  WHERE o.id = p_order_id
    AND o.status = 'sent'
    AND o.payment_method = 'Contra Reembolso'
    AND COALESCE(o.sent_at, o.closed_at)::date >= DATE '2026-05-01'
    AND NOT EXISTS (
      SELECT 1 FROM public.local_orders lo WHERE lo.source_order_id = o.id
    );
END;
$fn$;

REVOKE ALL ON FUNCTION public._cod_load_order_financial_snapshots(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._cod_load_order_financial_snapshots(uuid) FROM anon;
REVOKE ALL ON FUNCTION public._cod_load_order_financial_snapshots(uuid) FROM authenticated;

-- ---------------------------------------------------------------------------
-- 1) Aprobar seguras en bloque
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_cod_approve_auto_matched(
  p_remittance_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_status text;
  v_transport_id uuid;
  v_row record;
  v_snap record;
  v_count int := 0;
  v_will_irreg boolean;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.has_permission(v_uid, 'conciliacion-reembolso', 'edit') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_remittance_id IS NULL THEN RAISE EXCEPTION 'remittance_id_required'; END IF;

  SELECT r.status, r.transport_id INTO v_status, v_transport_id
  FROM public.cod_remittances r
  WHERE r.id = p_remittance_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'remittance_not_found'; END IF;
  IF v_status IN ('confirmed', 'voided') THEN
    RAISE EXCEPTION 'remittance_not_editable status=%', v_status;
  END IF;
  IF v_status <> 'analyzed' THEN
    RAISE EXCEPTION 'remittance_not_analyzed status=%', v_status;
  END IF;

  FOR v_row IN
    SELECT *
    FROM public.cod_remittance_rows
    WHERE remittance_id = p_remittance_id
      AND row_status = 'auto_matched'
    ORDER BY row_index
    FOR UPDATE
  LOOP
    IF v_row.parsed_amount IS NULL THEN
      RAISE EXCEPTION 'row_missing_parsed_amount row_id=%', v_row.id;
    END IF;

    IF v_row.matched_order_id IS NULL THEN
      RAISE EXCEPTION 'auto_matched_missing_order row_id=%', v_row.id;
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.cod_remittance_rows r
      WHERE r.matched_order_id = v_row.matched_order_id
        AND r.row_status IN ('confirmed_matched', 'confirmed_with_irregularity')
    ) THEN
      RAISE EXCEPTION 'matched_order_already_confirmed order_id=%', v_row.matched_order_id;
    END IF;

    SELECT * INTO v_snap
    FROM public._cod_load_order_financial_snapshots(v_row.matched_order_id);

    IF NOT FOUND OR v_snap.sent_date IS NULL THEN
      RAISE EXCEPTION 'matched_order_not_in_cod_universe order_id=%', v_row.matched_order_id;
    END IF;

    v_will_irreg := (
      abs(v_row.parsed_amount - v_snap.expected_amount) >= 0.005
    );

    UPDATE public.cod_remittance_rows SET
      row_status = 'approved_pending_confirmation',
      assignment_method = 'auto',
      order_number_snapshot = v_snap.order_number,
      expected_amount_snapshot = v_snap.expected_amount,
      order_sent_date_snapshot = v_snap.sent_date,
      order_sent_date_origin = v_snap.sent_origin,
      transport_name_snapshot = v_snap.transport_name,
      transport_mismatch = (v_snap.transport_id IS DISTINCT FROM v_transport_id),
      will_create_irregularity = v_will_irreg,
      assigned_by = v_uid,
      assigned_at = now(),
      updated_at = now()
    WHERE id = v_row.id
      AND remittance_id = p_remittance_id;

    INSERT INTO public.cod_reconciliation_events (
      remittance_id, remittance_row_id, event_type, actor_id, previous_state, new_state, reason
    ) VALUES (
      p_remittance_id,
      v_row.id,
      'candidate_approved',
      v_uid,
      jsonb_build_object('row_status', 'auto_matched', 'matched_order_id', v_row.matched_order_id),
      jsonb_build_object(
        'row_status', 'approved_pending_confirmation',
        'matched_order_id', v_row.matched_order_id,
        'assignment_method', 'auto',
        'expected_amount_snapshot', v_snap.expected_amount,
        'will_create_irregularity', v_will_irreg
      ),
      'Aprobación en bloque de coincidencia segura (sin efecto financiero)'
    );

    v_count := v_count + 1;
  END LOOP;

  UPDATE public.cod_remittances SET updated_at = now() WHERE id = p_remittance_id;

  RETURN jsonb_build_object(
    'ok', true,
    'remittance_id', p_remittance_id,
    'approved_count', v_count
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.rpc_cod_approve_auto_matched(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_cod_approve_auto_matched(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.rpc_cod_approve_auto_matched(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cod_approve_auto_matched(uuid) TO service_role;

COMMENT ON FUNCTION public.rpc_cod_approve_auto_matched(uuid) IS
  'Fase 5: aprueba auto_matched → approved_pending_confirmation. Sin efecto financiero.';

-- ---------------------------------------------------------------------------
-- 2) Asignar / aprobar pedido a una fila
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_cod_assign_row(
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
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_status text;
  v_transport_id uuid;
  v_row public.cod_remittance_rows%ROWTYPE;
  v_snap record;
  v_warnings jsonb := '[]'::jsonb;
  v_day_diff int;
  v_amt_diff numeric;
  v_name_source text;
  v_matched_name text;
  v_name_ok boolean;
  v_method text;
  v_will_irreg boolean;
  v_prev_status text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.has_permission(v_uid, 'conciliacion-reembolso', 'edit') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_remittance_id IS NULL OR p_row_id IS NULL OR p_order_id IS NULL THEN
    RAISE EXCEPTION 'params_required';
  END IF;

  SELECT r.status, r.transport_id INTO v_status, v_transport_id
  FROM public.cod_remittances r
  WHERE r.id = p_remittance_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'remittance_not_found'; END IF;
  IF v_status IN ('confirmed', 'voided') THEN
    RAISE EXCEPTION 'remittance_not_editable status=%', v_status;
  END IF;
  IF v_status <> 'analyzed' THEN
    RAISE EXCEPTION 'remittance_not_analyzed status=%', v_status;
  END IF;

  SELECT * INTO v_row
  FROM public.cod_remittance_rows
  WHERE id = p_row_id AND remittance_id = p_remittance_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'row_not_in_remittance'; END IF;

  IF v_row.row_status NOT IN (
    'auto_matched', 'needs_review', 'unassigned', 'approved_pending_confirmation'
  ) THEN
    RAISE EXCEPTION 'row_not_assignable status=%', v_row.row_status;
  END IF;

  -- Hard: sin monto informado no hay aprobación (p_force no lo salta)
  IF v_row.parsed_amount IS NULL THEN
    RAISE EXCEPTION 'row_missing_parsed_amount row_id=%', v_row.id;
  END IF;

  v_prev_status := v_row.row_status;

  IF EXISTS (
    SELECT 1 FROM public.cod_remittance_rows r
    WHERE r.matched_order_id = p_order_id
      AND r.row_status IN ('confirmed_matched', 'confirmed_with_irregularity')
  ) THEN
    RAISE EXCEPTION 'matched_order_already_confirmed order_id=%', p_order_id;
  END IF;

  SELECT * INTO v_snap FROM public._cod_load_order_financial_snapshots(p_order_id);
  IF NOT FOUND OR v_snap.sent_date IS NULL THEN
    RAISE EXCEPTION 'matched_order_not_in_cod_universe order_id=%', p_order_id;
  END IF;

  -- Warnings (solo discrepancias; p_force las puede aceptar)
  IF v_snap.transport_id IS DISTINCT FROM v_transport_id THEN
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

  v_amt_diff := round((v_row.parsed_amount - v_snap.expected_amount)::numeric, 2);
  IF abs(v_amt_diff) >= 0.005 THEN
    v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
      'code', 'amount_diff',
      'message', 'Monto informado distinto al esperado del pedido',
      'amount_diff', v_amt_diff
    ));
  END IF;

  -- Validar matched_name_* si vienen (metadata explicativa)
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
    -- Sin metadata de nombre: advertencia suave
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
      'expected_amount', v_snap.expected_amount,
      'order_number', v_snap.order_number
    );
  END IF;

  v_method := CASE
    WHEN v_prev_status = 'auto_matched'
         AND v_row.matched_order_id IS NOT DISTINCT FROM p_order_id
      THEN 'auto'
    ELSE 'manual'
  END;

  v_will_irreg := (
    abs(v_row.parsed_amount - v_snap.expected_amount) >= 0.005
  );

  UPDATE public.cod_remittance_rows SET
    row_status = 'approved_pending_confirmation',
    matched_order_id = p_order_id,
    assignment_method = v_method,
    order_number_snapshot = v_snap.order_number,
    expected_amount_snapshot = v_snap.expected_amount,
    order_sent_date_snapshot = v_snap.sent_date,
    order_sent_date_origin = v_snap.sent_origin,
    transport_name_snapshot = v_snap.transport_name,
    matched_name_snapshot = v_matched_name,
    matched_name_source = v_name_source,
    transport_mismatch = (v_snap.transport_id IS DISTINCT FROM v_transport_id),
    will_create_irregularity = v_will_irreg,
    matched_via_broadened_search = COALESCE(matched_via_broadened_search, false)
      OR (v_snap.transport_id IS DISTINCT FROM v_transport_id),
    assigned_by = v_uid,
    assigned_at = now(),
    updated_at = now()
  WHERE id = p_row_id AND remittance_id = p_remittance_id;

  INSERT INTO public.cod_reconciliation_events (
    remittance_id, remittance_row_id, event_type, actor_id, previous_state, new_state, reason
  ) VALUES (
    p_remittance_id,
    p_row_id,
    CASE WHEN v_method = 'manual' THEN 'manual_assignment' ELSE 'candidate_approved' END,
    v_uid,
    jsonb_build_object('row_status', v_prev_status, 'matched_order_id', v_row.matched_order_id),
    jsonb_build_object(
      'row_status', 'approved_pending_confirmation',
      'matched_order_id', p_order_id,
      'assignment_method', v_method,
      'expected_amount_snapshot', v_snap.expected_amount,
      'will_create_irregularity', v_will_irreg,
      'forced', COALESCE(p_force, false),
      'warnings', v_warnings
    ),
    CASE
      WHEN v_method = 'manual' THEN 'Asignación/aprobación manual (sin efecto financiero)'
      ELSE 'Aprobación de candidato (sin efecto financiero)'
    END
  );

  UPDATE public.cod_remittances SET updated_at = now() WHERE id = p_remittance_id;

  RETURN jsonb_build_object(
    'ok', true,
    'remittance_id', p_remittance_id,
    'row_id', p_row_id,
    'matched_order_id', p_order_id,
    'assignment_method', v_method,
    'expected_amount_snapshot', v_snap.expected_amount,
    'will_create_irregularity', v_will_irreg,
    'warnings', v_warnings
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.rpc_cod_assign_row(uuid, uuid, uuid, boolean, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_cod_assign_row(uuid, uuid, uuid, boolean, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.rpc_cod_assign_row(uuid, uuid, uuid, boolean, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cod_assign_row(uuid, uuid, uuid, boolean, text, text) TO service_role;

COMMENT ON FUNCTION public.rpc_cod_assign_row(uuid, uuid, uuid, boolean, text, text) IS
  'Fase 5: aprueba/asigna pedido a fila → approved_pending_confirmation. Snapshots desde DB. Sin efecto financiero.';

-- ---------------------------------------------------------------------------
-- 3) Dejar sin identificar
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_cod_mark_row_unassigned(
  p_remittance_id uuid,
  p_row_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_status text;
  v_row public.cod_remittance_rows%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.has_permission(v_uid, 'conciliacion-reembolso', 'edit') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT r.status INTO v_status
  FROM public.cod_remittances r
  WHERE r.id = p_remittance_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'remittance_not_found'; END IF;
  IF v_status IN ('confirmed', 'voided') THEN
    RAISE EXCEPTION 'remittance_not_editable status=%', v_status;
  END IF;
  IF v_status <> 'analyzed' THEN
    RAISE EXCEPTION 'remittance_not_analyzed status=%', v_status;
  END IF;

  SELECT * INTO v_row
  FROM public.cod_remittance_rows
  WHERE id = p_row_id AND remittance_id = p_remittance_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'row_not_in_remittance'; END IF;
  IF v_row.row_status NOT IN (
    'auto_matched', 'needs_review', 'unassigned', 'approved_pending_confirmation'
  ) THEN
    RAISE EXCEPTION 'row_not_assignable status=%', v_row.row_status;
  END IF;

  UPDATE public.cod_remittance_rows SET
    row_status = 'unassigned',
    matched_order_id = NULL,
    assignment_method = NULL,
    match_score = NULL,
    order_number_snapshot = NULL,
    matched_name_snapshot = NULL,
    matched_name_source = NULL,
    transport_name_snapshot = NULL,
    order_sent_date_snapshot = NULL,
    order_sent_date_origin = NULL,
    expected_amount_snapshot = NULL,
    transport_mismatch = false,
    will_create_irregularity = false,
    matched_via_broadened_search = false,
    assigned_by = NULL,
    assigned_at = NULL,
    updated_at = now()
  WHERE id = p_row_id AND remittance_id = p_remittance_id;

  INSERT INTO public.cod_reconciliation_events (
    remittance_id, remittance_row_id, event_type, actor_id, previous_state, new_state, reason
  ) VALUES (
    p_remittance_id,
    p_row_id,
    'manual_assignment',
    v_uid,
    jsonb_build_object('row_status', v_row.row_status, 'matched_order_id', v_row.matched_order_id),
    jsonb_build_object('row_status', 'unassigned', 'matched_order_id', NULL),
    'Fila marcada sin identificar (sin efecto financiero)'
  );

  UPDATE public.cod_remittances SET updated_at = now() WHERE id = p_remittance_id;

  RETURN jsonb_build_object('ok', true, 'remittance_id', p_remittance_id, 'row_id', p_row_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.rpc_cod_mark_row_unassigned(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_cod_mark_row_unassigned(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.rpc_cod_mark_row_unassigned(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cod_mark_row_unassigned(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.rpc_cod_mark_row_unassigned(uuid, uuid) IS
  'Fase 5: deja fila unassigned. Sin efecto financiero.';
