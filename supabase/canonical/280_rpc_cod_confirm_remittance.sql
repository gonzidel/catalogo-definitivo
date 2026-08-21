-- 280_rpc_cod_confirm_remittance.sql
--
-- Fase 5 — Confirmación financiera atómica de una rendición COD.
-- ESTADO: preparada localmente. NO aplicar en producción sin autorización explícita.
--
-- Firma:
--   public.rpc_cod_confirm_remittance(p_remittance_id uuid) RETURNS jsonb
--
-- Precondiciones:
--   - status = 'analyzed'
--   - cada fila: approved_pending_confirmation | unassigned
--   - ninguna auto_matched / needs_review / pending_analysis
--
-- Por cada approved_pending_confirmation:
--   - recalcular orders.total_amount; si ≠ expected_amount_snapshot → FAIL (rollback)
--   - si ya confirmed_* en otra fila → FAIL (constraint + check)
--   - exacto → confirmed_matched
--   - diff → confirmed_with_irregularity + INSERT cod_irregularities (open)
--
-- unassigned permanece unassigned.
-- No muta orders.
-- Confirmación 100% atómica. Serializa por pedido con SELECT orders ... FOR UPDATE
-- antes de validar confirmed_* y monto. uq_cod_rows_matched_order_active = última defensa.
-- No muta orders.

CREATE OR REPLACE FUNCTION public.rpc_cod_confirm_remittance(
  p_remittance_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_rem public.cod_remittances%ROWTYPE;
  v_row public.cod_remittance_rows%ROWTYPE;
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

  IF v_rem.status = 'confirmed' THEN
    RAISE EXCEPTION 'remittance_already_confirmed';
  END IF;
  IF v_rem.status = 'voided' THEN
    RAISE EXCEPTION 'remittance_voided';
  END IF;
  IF v_rem.status <> 'analyzed' THEN
    RAISE EXCEPTION 'remittance_not_confirmable status=%', v_rem.status;
  END IF;

  -- Todas las filas deben estar decididas
  SELECT r.row_status INTO v_bad_status
  FROM public.cod_remittance_rows r
  WHERE r.remittance_id = p_remittance_id
    AND r.row_status NOT IN ('approved_pending_confirmation', 'unassigned')
  LIMIT 1;

  IF v_bad_status IS NOT NULL THEN
    RAISE EXCEPTION 'rows_not_ready_for_confirm status=%', v_bad_status;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.cod_remittance_rows WHERE remittance_id = p_remittance_id
  ) THEN
    RAISE EXCEPTION 'remittance_has_no_rows';
  END IF;

  FOR v_row IN
    SELECT *
    FROM public.cod_remittance_rows
    WHERE remittance_id = p_remittance_id
    ORDER BY row_index
    FOR UPDATE
  LOOP
    IF v_row.row_status = 'unassigned' THEN
      v_count_unassigned := v_count_unassigned + 1;
      CONTINUE;
    END IF;

    -- approved_pending_confirmation
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

    -- 1) Lock orders: serializa confirmaciones concurrentes del mismo pedido
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
      v_ord_payment_method,
      v_ord_sent_at,
      v_ord_closed_at
    FROM public.orders o
    WHERE o.id = v_row.matched_order_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'matched_order_not_found order_id=%', v_row.matched_order_id;
    END IF;

    -- 2) Universo COD (sobre la fila ya bloqueada)
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

    -- 3) Pedido ya conciliado por otra rendición (post-lock)
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
        format(
          'El pedido %s fue conciliado por otra rendición mientras esta estaba en revisión. Revisá la fila y volvé a intentar.',
          v_conflicting_order
        );
    END IF;

    -- 4) Monto vivo vs snapshot aprobado
    IF abs(v_live_amount - v_row.expected_amount_snapshot) >= 0.005 THEN
      RAISE EXCEPTION
        'order_amount_changed_since_approval row_id=% snapshot=% live=%',
        v_row.id, v_row.expected_amount_snapshot, v_live_amount;
    END IF;

    -- 5) Confirmar fila
    v_expected := v_row.expected_amount_snapshot;
    v_reported := round(v_row.parsed_amount::numeric, 2);
    v_diff := round((v_reported - v_expected)::numeric, 2);

    IF abs(v_diff) < 0.005 THEN
      v_new_status := 'confirmed_matched';
      v_count_exact := v_count_exact + 1;

      UPDATE public.cod_remittance_rows SET
        row_status = 'confirmed_matched',
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
        will_create_irregularity = true,
        updated_at = now()
      WHERE id = v_row.id;

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
        v_row.id,
        v_row.matched_order_id,
        p_remittance_id,
        v_rem.transport_id,
        v_row.order_sent_date_snapshot,
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
        v_row.id,
        v_irreg_id,
        'irregularity_created',
        v_uid,
        jsonb_build_object(
          'amount_diff', v_diff,
          'expected_amount', v_expected,
          'reported_amount', v_reported,
          'order_id', v_row.matched_order_id
        ),
        'Irregularidad creada en confirmación financiera'
      );
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
    p_remittance_id,
    'remittance_confirmed',
    v_uid,
    jsonb_build_object(
      'status', 'confirmed',
      'confirmed_at', v_confirmed_at,
      'approved_confirmed', v_count_approved,
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
  'Fase 5: confirmación financiera atómica. Crea irregularidades solo aquí. No muta orders.';
