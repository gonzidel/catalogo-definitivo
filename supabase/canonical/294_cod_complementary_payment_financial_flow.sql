-- 294_cod_complementary_payment_financial_flow.sql
-- Confirmación, corrección y anulación compatibles con supplementary. NO APLICADA.
--
-- Las implementaciones revision-aware de 287/288 creadas por 291 se congelan
-- como helpers internos y se envuelven con los guards/reapertura de 294. Esto
-- conserva íntegro el comportamiento 291 y evita divergencia entre copias.
-- En V1 primary+supplementary del mismo pedido en una misma remesa es imposible:
-- supplementary exige una primary ya confirmada y esa remesa ya no es editable.

-- =============================================================================
-- Confirmación: primary primero; supplementary aplica contra saldo vivo.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_cod_confirm_remittance(p_remittance_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_rem public.cod_remittances%ROWTYPE;
  v_row public.cod_remittance_rows%ROWTYPE;
  v_bal record;
  v_shortage public.cod_irregularities%ROWTYPE;
  v_shortage_count int;
  v_live_amount numeric(12,2);
  v_reported numeric(12,2);
  v_expected numeric(12,2);
  v_diff numeric(12,2);
  v_diff_pct numeric(6,3);
  v_new_status text;
  v_irreg_id uuid;
  v_count_exact int := 0;
  v_count_irreg int := 0;
  v_count_unassigned int := 0;
  v_count_approved int := 0;
  v_count_supplementary int := 0;
  v_bad_status text;
  v_conflicting_order text;
  v_confirmed_at timestamptz := now();
  v_ord_id uuid;
  v_ord_number text;
  v_ord_status text;
  v_ord_payment_method text;
  v_ord_sent_at timestamptz;
  v_ord_closed_at timestamptz;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.has_permission(v_uid, 'conciliacion-reembolso', 'edit') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_remittance_id IS NULL THEN RAISE EXCEPTION 'remittance_id_required'; END IF;

  SELECT * INTO v_rem
  FROM public.cod_remittances
  WHERE id = p_remittance_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'remittance_not_found'; END IF;
  IF v_rem.status = 'confirmed' THEN RAISE EXCEPTION 'remittance_already_confirmed'; END IF;
  IF v_rem.status = 'voided' THEN RAISE EXCEPTION 'remittance_voided'; END IF;
  IF v_rem.status <> 'analyzed' THEN
    RAISE EXCEPTION 'remittance_not_confirmable status=%', v_rem.status;
  END IF;

  SELECT r.row_status INTO v_bad_status
  FROM public.cod_remittance_rows r
  WHERE r.remittance_id = p_remittance_id
    AND r.sheet_revision = COALESCE(v_rem.sheet_revision, 1)
    AND r.row_status NOT IN ('approved_pending_confirmation', 'unassigned')
  LIMIT 1;
  IF v_bad_status IS NOT NULL THEN
    RAISE EXCEPTION 'rows_not_ready_for_confirm status=%', v_bad_status;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.cod_remittance_rows
    WHERE remittance_id = p_remittance_id
      AND sheet_revision = COALESCE(v_rem.sheet_revision, 1)
  ) THEN
    RAISE EXCEPTION 'remittance_has_no_rows';
  END IF;

  FOR v_row IN
    SELECT *
    FROM public.cod_remittance_rows
    WHERE remittance_id = p_remittance_id
      AND sheet_revision = COALESCE(v_rem.sheet_revision, 1)
    ORDER BY
      CASE COALESCE(assignment_role, 'primary')
        WHEN 'primary' THEN 0
        ELSE 1
      END,
      row_index
    FOR UPDATE
  LOOP
    IF v_row.row_status = 'unassigned' THEN
      v_count_unassigned := v_count_unassigned + 1;
      CONTINUE;
    END IF;

    v_count_approved := v_count_approved + 1;
    IF v_row.matched_order_id IS NULL THEN
      RAISE EXCEPTION 'approved_row_missing_order row_id=%', v_row.id;
    END IF;
    IF v_row.expected_amount_snapshot IS NULL THEN
      RAISE EXCEPTION 'approved_row_missing_expected_snapshot row_id=%', v_row.id;
    END IF;
    IF v_row.parsed_amount IS NULL THEN
      RAISE EXCEPTION 'approved_row_missing_parsed_amount row_id=%', v_row.id;
    END IF;

    SELECT
      o.id, o.order_number, round(COALESCE(o.total_amount, 0)::numeric, 2),
      o.status, o.payment_method, o.sent_at, o.closed_at
    INTO
      v_ord_id, v_ord_number, v_live_amount, v_ord_status,
      v_ord_payment_method, v_ord_sent_at, v_ord_closed_at
    FROM public.orders o
    WHERE o.id = v_row.matched_order_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'matched_order_not_found order_id=%', v_row.matched_order_id;
    END IF;
    IF v_ord_status <> 'sent'
       OR v_ord_payment_method <> 'Contra Reembolso'
       OR COALESCE(v_ord_sent_at, v_ord_closed_at)::date < DATE '2026-05-01'
       OR EXISTS (
         SELECT 1 FROM public.local_orders lo
         WHERE lo.source_order_id = v_row.matched_order_id
       )
    THEN
      RAISE EXCEPTION 'matched_order_not_in_cod_universe order_id=%', v_row.matched_order_id;
    END IF;

    v_reported := round(v_row.parsed_amount::numeric, 2);

    IF COALESCE(v_row.assignment_role, 'primary') = 'supplementary' THEN
      v_count_supplementary := v_count_supplementary + 1;

      -- Exactamente una faltante operativa. Se bloquea antes de recalcular saldo.
      SELECT count(*) INTO v_shortage_count
      FROM public.cod_irregularities i
      WHERE i.order_id = v_row.matched_order_id
        AND i.status IN ('open', 'in_review')
        AND i.amount_diff < -0.005;

      IF v_shortage_count = 0 THEN
        RAISE EXCEPTION 'active_shortage_irregularity_not_found';
      ELSIF v_shortage_count > 1 THEN
        RAISE EXCEPTION 'multiple_active_shortage_irregularities';
      END IF;

      SELECT * INTO v_shortage
      FROM public.cod_irregularities i
      WHERE i.order_id = v_row.matched_order_id
        AND i.status IN ('open', 'in_review')
        AND i.amount_diff < -0.005
      ORDER BY i.id
      LIMIT 1
      FOR UPDATE;

      SELECT * INTO v_bal
      FROM public._cod_load_order_cod_balance(v_row.matched_order_id);

      IF v_bal.primary_count <> 1 THEN
        RAISE EXCEPTION 'order_not_partially_reconciled primary_count=%', v_bal.primary_count;
      END IF;
      IF v_bal.remaining_balance <= 0.005 THEN
        RAISE EXCEPTION 'balance_already_settled';
      END IF;
      IF v_reported - v_bal.remaining_balance >= 0.005 THEN
        RAISE EXCEPTION 'payment_exceeds_remaining_balance payment=% balance=%',
          v_reported, v_bal.remaining_balance;
      END IF;
      IF abs(v_bal.remaining_balance - v_row.expected_amount_snapshot) >= 0.005 THEN
        RAISE EXCEPTION
          'complementary_balance_changed_since_approval snapshot=% live=%',
          v_row.expected_amount_snapshot, v_bal.remaining_balance;
      END IF;
      IF NOT (
        abs(v_shortage.amount_diff + v_bal.remaining_balance) < 0.005
        OR abs(abs(v_shortage.amount_diff) - v_bal.remaining_balance) < 0.005
      ) THEN
        RAISE EXCEPTION 'shortage_balance_mismatch';
      END IF;

      v_expected := v_bal.remaining_balance;
      v_diff := round(v_reported - v_expected, 2);
      v_diff_pct := CASE
        WHEN abs(v_expected) < 0.005 THEN NULL
        ELSE round((v_diff / abs(v_expected) * 100)::numeric, 3)
      END;

      IF abs(v_diff) < 0.005 THEN
        v_new_status := 'confirmed_matched';
        v_count_exact := v_count_exact + 1;

        UPDATE public.cod_remittance_rows SET
          row_status = 'confirmed_matched',
          assignment_role = 'supplementary',
          will_create_irregularity = false,
          updated_at = now()
        WHERE id = v_row.id;

        UPDATE public.cod_irregularities SET
          status = 'resolved',
          resolved_by = v_uid,
          resolved_at = now(),
          resolution_note = format(
            'Saldo completado por pago complementario de remesa %s, fila %s.',
            p_remittance_id, v_row.id
          ),
          updated_at = now()
        WHERE id = v_shortage.id;

        INSERT INTO public.cod_reconciliation_events (
          remittance_id, remittance_row_id, irregularity_id,
          event_type, actor_id, previous_state, new_state, reason
        ) VALUES (
          p_remittance_id, v_row.id, v_shortage.id,
          'irregularity_resolved', v_uid,
          jsonb_build_object('status', v_shortage.status, 'amount_diff', v_shortage.amount_diff),
          jsonb_build_object('status', 'resolved', 'order_id', v_row.matched_order_id),
          'Faltante resuelto por pago complementario exacto'
        );
      ELSE
        v_new_status := 'confirmed_with_irregularity';
        v_count_irreg := v_count_irreg + 1;

        UPDATE public.cod_remittance_rows SET
          row_status = 'confirmed_with_irregularity',
          assignment_role = 'supplementary',
          will_create_irregularity = true,
          updated_at = now()
        WHERE id = v_row.id;

        UPDATE public.cod_irregularities SET
          status = 'superseded',
          superseded_reason = 'complementary_payment_partial',
          superseded_at = now(),
          superseded_by = v_uid,
          updated_at = now()
        WHERE id = v_shortage.id;

        INSERT INTO public.cod_irregularities (
          remittance_row_id, order_id, remittance_id, transport_id,
          order_sent_date_snapshot, remittance_date_snapshot,
          expected_amount, reported_amount, amount_diff, amount_diff_pct,
          status, created_by
        ) VALUES (
          v_row.id, v_row.matched_order_id, p_remittance_id, v_rem.transport_id,
          v_row.order_sent_date_snapshot, v_rem.remittance_date,
          v_expected, v_reported, v_diff, v_diff_pct, 'open', v_uid
        )
        RETURNING id INTO v_irreg_id;

        INSERT INTO public.cod_reconciliation_events (
          remittance_id, remittance_row_id, irregularity_id,
          event_type, actor_id, new_state, reason
        ) VALUES (
          p_remittance_id, v_row.id, v_irreg_id,
          'irregularity_created', v_uid,
          jsonb_build_object(
            'order_id', v_row.matched_order_id,
            'expected_amount', v_expected,
            'reported_amount', v_reported,
            'amount_diff', v_diff,
            'supersedes_irregularity_id', v_shortage.id
          ),
          'Nuevo saldo faltante luego de pago complementario parcial'
        );
      END IF;

      INSERT INTO public.cod_reconciliation_events (
        remittance_id, remittance_row_id, irregularity_id,
        event_type, actor_id, previous_state, new_state, reason
      ) VALUES (
        p_remittance_id,
        v_row.id,
        CASE WHEN abs(v_diff) < 0.005 THEN v_shortage.id ELSE v_irreg_id END,
        'complementary_payment_applied',
        v_uid,
        jsonb_build_object(
          'balance_before', v_bal.remaining_balance,
          'active_reported_before', v_bal.active_reported_total
        ),
        jsonb_build_object(
          'order_id', v_row.matched_order_id,
          'assignment_role', 'supplementary',
          'row_status', v_new_status,
          'balance_before', v_bal.remaining_balance,
          'payment', v_reported,
          'balance_after', round(v_bal.remaining_balance - v_reported, 2),
          'financial_effect', true
        ),
        'Pago complementario aplicado al confirmar la rendición'
      );
    ELSE
      -- Rama primary: comportamiento financiero de 291.
      IF EXISTS (
        SELECT 1
        FROM public.cod_remittance_rows r
        WHERE r.matched_order_id = v_row.matched_order_id
          AND r.id <> v_row.id
          AND r.row_status IN ('confirmed_matched', 'confirmed_with_irregularity')
      ) THEN
        v_conflicting_order := COALESCE(v_ord_number, v_row.matched_order_id::text);
        RAISE EXCEPTION
          'order_confirmed_elsewhere order=% msg=%',
          v_conflicting_order,
          format('El pedido %s ya fue conciliado por otra rendición.', v_conflicting_order);
      END IF;

      IF abs(v_live_amount - v_row.expected_amount_snapshot) >= 0.005 THEN
        RAISE EXCEPTION
          'order_amount_changed_since_approval row_id=% snapshot=% live=%',
          v_row.id, v_row.expected_amount_snapshot, v_live_amount;
      END IF;

      v_expected := v_row.expected_amount_snapshot;
      v_diff := round(v_reported - v_expected, 2);

      IF abs(v_diff) < 0.005 THEN
        v_new_status := 'confirmed_matched';
        v_count_exact := v_count_exact + 1;
        UPDATE public.cod_remittance_rows SET
          row_status = 'confirmed_matched',
          assignment_role = 'primary',
          will_create_irregularity = false,
          updated_at = now()
        WHERE id = v_row.id;
      ELSE
        v_new_status := 'confirmed_with_irregularity';
        v_count_irreg := v_count_irreg + 1;
        v_diff_pct := CASE
          WHEN abs(v_expected) < 0.005 THEN NULL
          ELSE round((v_diff / abs(v_expected) * 100)::numeric, 3)
        END;

        UPDATE public.cod_remittance_rows SET
          row_status = 'confirmed_with_irregularity',
          assignment_role = 'primary',
          will_create_irregularity = true,
          updated_at = now()
        WHERE id = v_row.id;

        INSERT INTO public.cod_irregularities (
          remittance_row_id, order_id, remittance_id, transport_id,
          order_sent_date_snapshot, remittance_date_snapshot,
          expected_amount, reported_amount, amount_diff, amount_diff_pct,
          status, created_by
        ) VALUES (
          v_row.id, v_row.matched_order_id, p_remittance_id, v_rem.transport_id,
          v_row.order_sent_date_snapshot, v_rem.remittance_date,
          v_expected, v_reported, v_diff, v_diff_pct, 'open', v_uid
        )
        RETURNING id INTO v_irreg_id;

        INSERT INTO public.cod_reconciliation_events (
          remittance_id, remittance_row_id, irregularity_id,
          event_type, actor_id, new_state, reason
        ) VALUES (
          p_remittance_id, v_row.id, v_irreg_id,
          'irregularity_created', v_uid,
          jsonb_build_object(
            'amount_diff', v_diff,
            'expected_amount', v_expected,
            'reported_amount', v_reported,
            'order_id', v_row.matched_order_id
          ),
          'Irregularidad creada en confirmación financiera'
        );
      END IF;
    END IF;
  END LOOP;

  UPDATE public.cod_remittances SET
    status = 'confirmed',
    confirmed_by = v_uid,
    confirmed_at = v_confirmed_at,
    updated_at = now()
  WHERE id = p_remittance_id;

  INSERT INTO public.cod_reconciliation_events (
    remittance_id, event_type, actor_id, new_state, reason
  ) VALUES (
    p_remittance_id, 'remittance_confirmed', v_uid,
    jsonb_build_object(
      'status', 'confirmed',
      'confirmed_at', v_confirmed_at,
      'approved_confirmed', v_count_approved,
      'supplementary_confirmed', v_count_supplementary,
      'exact', v_count_exact,
      'with_irregularity', v_count_irreg,
      'unassigned', v_count_unassigned
    ),
    'Confirmación financiera atómica de rendición COD'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'remittance_id', p_remittance_id,
    'confirmed_at', v_confirmed_at,
    'counts', jsonb_build_object(
      'confirmed_matched', v_count_exact,
      'confirmed_with_irregularity', v_count_irreg,
      'supplementary', v_count_supplementary,
      'unassigned', v_count_unassigned,
      'total_confirmed_payments', v_count_approved
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.rpc_cod_confirm_remittance(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_cod_confirm_remittance(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.rpc_cod_confirm_remittance(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cod_confirm_remittance(uuid) TO service_role;

COMMENT ON FUNCTION public.rpc_cod_confirm_remittance(uuid) IS
  '294: confirmación atómica primary/supplementary. Supplementary valida saldo e irregularidad faltante bajo locks.';

-- =============================================================================
-- 287: congelar cuerpo revision-aware de 291 y agregar rechazos supplementary.
-- =============================================================================

DO $do$
BEGIN
  IF to_regprocedure('public._cod_291_correct_confirmed_assignment(uuid,uuid,uuid,text,boolean,text,text)') IS NULL THEN
    ALTER FUNCTION public.rpc_cod_correct_confirmed_assignment(uuid, uuid, uuid, text, boolean, text, text)
      RENAME TO _cod_291_correct_confirmed_assignment;
  END IF;
END;
$do$;

REVOKE ALL ON FUNCTION public._cod_291_correct_confirmed_assignment(uuid, uuid, uuid, text, boolean, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._cod_291_correct_confirmed_assignment(uuid, uuid, uuid, text, boolean, text, text) FROM anon;
REVOKE ALL ON FUNCTION public._cod_291_correct_confirmed_assignment(uuid, uuid, uuid, text, boolean, text, text) FROM authenticated;
REVOKE ALL ON FUNCTION public._cod_291_correct_confirmed_assignment(uuid, uuid, uuid, text, boolean, text, text) FROM service_role;

CREATE OR REPLACE FUNCTION public.rpc_cod_correct_confirmed_assignment(
  p_remittance_id uuid,
  p_row_id uuid,
  p_new_order_id uuid,
  p_reason text,
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
  v_old_order_id uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.has_permission(v_uid, 'conciliacion-reembolso', 'edit') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_rem
  FROM public.cod_remittances
  WHERE id = p_remittance_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'remittance_not_found'; END IF;

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

  IF COALESCE(v_row.assignment_role, 'primary') = 'supplementary' THEN
    RAISE EXCEPTION 'complementary_row_not_correctable';
  END IF;

  v_old_order_id := v_row.matched_order_id;
  IF EXISTS (
    SELECT 1
    FROM public.cod_remittance_rows rr
    INNER JOIN public.cod_remittances r ON r.id = rr.remittance_id
    WHERE rr.matched_order_id = v_old_order_id
      AND rr.id <> p_row_id
      AND rr.assignment_role = 'supplementary'
      AND rr.row_status IN ('confirmed_matched', 'confirmed_with_irregularity')
      AND r.status <> 'voided'
      AND rr.sheet_revision = COALESCE(r.sheet_revision, 1)
  ) THEN
    RAISE EXCEPTION 'order_has_supplementary_payments';
  END IF;

  RETURN public._cod_291_correct_confirmed_assignment(
    p_remittance_id, p_row_id, p_new_order_id, p_reason, p_force,
    p_matched_name_snapshot, p_matched_name_source
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.rpc_cod_correct_confirmed_assignment(uuid, uuid, uuid, text, boolean, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_cod_correct_confirmed_assignment(uuid, uuid, uuid, text, boolean, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.rpc_cod_correct_confirmed_assignment(uuid, uuid, uuid, text, boolean, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cod_correct_confirmed_assignment(uuid, uuid, uuid, text, boolean, text, text) TO service_role;

COMMENT ON FUNCTION public.rpc_cod_correct_confirmed_assignment(uuid, uuid, uuid, text, boolean, text, text) IS
  '294/287 revision-aware: rechaza corregir supplementary o primary cuyo pedido tenga pagos supplementary activos.';

-- =============================================================================
-- 288: guard primary + reapertura de saldo al anular supplementary.
-- =============================================================================

DO $do$
BEGIN
  IF to_regprocedure('public._cod_291_void_confirmed_remittance(uuid,text)') IS NULL THEN
    ALTER FUNCTION public.rpc_cod_void_confirmed_remittance(uuid, text)
      RENAME TO _cod_291_void_confirmed_remittance;
  END IF;
END;
$do$;

REVOKE ALL ON FUNCTION public._cod_291_void_confirmed_remittance(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._cod_291_void_confirmed_remittance(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public._cod_291_void_confirmed_remittance(uuid, text) FROM authenticated;
REVOKE ALL ON FUNCTION public._cod_291_void_confirmed_remittance(uuid, text) FROM service_role;

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
  v_rev int;
  v_order_id uuid;
  v_supplementary_orders uuid[] := ARRAY[]::uuid[];
  v_bal record;
  v_leftover_count int;
  v_new_irreg_id uuid;
  v_result jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.has_permission(v_uid, 'conciliacion-reembolso', 'edit') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_rem
  FROM public.cod_remittances
  WHERE id = p_remittance_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'remittance_not_found'; END IF;
  v_rev := COALESCE(v_rem.sheet_revision, 1);

  -- Una primary no puede anularse mientras otra remesa conserve supplementary.
  IF EXISTS (
    SELECT 1
    FROM public.cod_remittance_rows primary_row
    INNER JOIN public.cod_remittance_rows supplementary_row
      ON supplementary_row.matched_order_id = primary_row.matched_order_id
     AND supplementary_row.remittance_id <> p_remittance_id
     AND supplementary_row.assignment_role = 'supplementary'
     AND supplementary_row.row_status IN ('confirmed_matched', 'confirmed_with_irregularity')
    INNER JOIN public.cod_remittances supplementary_rem
      ON supplementary_rem.id = supplementary_row.remittance_id
     AND supplementary_rem.status <> 'voided'
     AND supplementary_row.sheet_revision = COALESCE(supplementary_rem.sheet_revision, 1)
    WHERE primary_row.remittance_id = p_remittance_id
      AND primary_row.sheet_revision = v_rev
      AND COALESCE(primary_row.assignment_role, 'primary') = 'primary'
      AND primary_row.row_status IN ('confirmed_matched', 'confirmed_with_irregularity')
  ) THEN
    RAISE EXCEPTION 'primary_has_active_supplementary_payments';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT matched_order_id), ARRAY[]::uuid[])
  INTO v_supplementary_orders
  FROM public.cod_remittance_rows
  WHERE remittance_id = p_remittance_id
    AND sheet_revision = v_rev
    AND assignment_role = 'supplementary'
    AND row_status IN ('confirmed_matched', 'confirmed_with_irregularity')
    AND matched_order_id IS NOT NULL;

  -- Cuerpo 288/291: void de filas, supersede irreg de ESTA remesa y evento.
  v_result := public._cod_291_void_confirmed_remittance(p_remittance_id, p_reason);

  FOREACH v_order_id IN ARRAY v_supplementary_orders
  LOOP
    SELECT * INTO v_bal FROM public._cod_load_order_cod_balance(v_order_id);

    -- Si también se anuló la primary (estado imposible en V1), no se reabre:
    -- el pedido vuelve al universo pendiente.
    IF v_bal.primary_count = 1 AND v_bal.remaining_balance > 0.005 THEN
      SELECT count(*) INTO v_leftover_count
      FROM public.cod_irregularities
      WHERE order_id = v_order_id
        AND status IN ('open', 'in_review')
        AND amount_diff < -0.005;

      IF v_leftover_count > 1 THEN
        RAISE EXCEPTION 'multiple_active_shortage_irregularities';
      END IF;

      UPDATE public.cod_irregularities SET
        status = 'superseded',
        superseded_reason = 'remittance_voided',
        superseded_at = now(),
        superseded_by = v_uid,
        updated_at = now()
      WHERE order_id = v_order_id
        AND status IN ('open', 'in_review')
        AND amount_diff < -0.005;

      INSERT INTO public.cod_irregularities (
        remittance_row_id, order_id, remittance_id, transport_id,
        order_sent_date_snapshot, remittance_date_snapshot,
        expected_amount, reported_amount, amount_diff, amount_diff_pct,
        status, created_by
      )
      SELECT
        v_bal.primary_row_id,
        v_order_id,
        v_bal.primary_remittance_id,
        primary_rem.transport_id,
        primary_row.order_sent_date_snapshot,
        primary_rem.remittance_date,
        v_bal.expected_total,
        v_bal.active_reported_total,
        round(v_bal.active_reported_total - v_bal.expected_total, 2),
        CASE
          WHEN abs(v_bal.expected_total) < 0.005 THEN NULL
          ELSE round(
            ((v_bal.active_reported_total - v_bal.expected_total)
              / abs(v_bal.expected_total) * 100)::numeric,
            3
          )
        END,
        'open',
        v_uid
      FROM public.cod_remittance_rows primary_row
      INNER JOIN public.cod_remittances primary_rem
        ON primary_rem.id = primary_row.remittance_id
      WHERE primary_row.id = v_bal.primary_row_id
      RETURNING id INTO v_new_irreg_id;

      INSERT INTO public.cod_reconciliation_events (
        remittance_id, remittance_row_id, irregularity_id,
        event_type, actor_id, new_state, reason
      ) VALUES (
        p_remittance_id,
        v_bal.primary_row_id,
        v_new_irreg_id,
        'complementary_balance_reopened',
        v_uid,
        jsonb_build_object(
          'order_id', v_order_id,
          'primary_row_id', v_bal.primary_row_id,
          'expected_total', v_bal.expected_total,
          'active_reported_total', v_bal.active_reported_total,
          'remaining_balance', v_bal.remaining_balance,
          'voided_supplementary_remittance_id', p_remittance_id,
          'historical_resolved_irregularities_reopened', false
        ),
        'Saldo reabierto por anulación de pago complementario'
      );
    END IF;
  END LOOP;

  RETURN v_result || jsonb_build_object(
    'supplementary_orders_recalculated', cardinality(v_supplementary_orders)
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.rpc_cod_void_confirmed_remittance(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_cod_void_confirmed_remittance(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.rpc_cod_void_confirmed_remittance(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cod_void_confirmed_remittance(uuid, text) TO service_role;

COMMENT ON FUNCTION public.rpc_cod_void_confirmed_remittance(uuid, text) IS
  '294/288 revision-aware: bloquea void primary con supplementary externas y crea nueva faltante al anular supplementary; nunca reabre resolved histórica.';
