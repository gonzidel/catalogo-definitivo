-- 298_rpc_cod_compensate_transport_differences.sql
--
-- Compensación V1 automática (FIFO) entre claims y credits del mismo transporte.
-- Usuario selecciona sets; el sistema aplica min(sum remainings) y distribuye.
-- NO APPLY hasta aprobación.

CREATE OR REPLACE FUNCTION public.rpc_cod_compensate_transport_differences(
  p_transport_id uuid,
  p_claim_ids uuid[] DEFAULT NULL,
  p_credit_adjustment_ids uuid[] DEFAULT NULL,
  p_credit_irregularity_ids uuid[] DEFAULT NULL,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_note text;
  v_comp_id uuid;
  v_claim_total numeric(12,2) := 0;
  v_credit_total numeric(12,2) := 0;
  v_apply numeric(12,2);
  v_left numeric(12,2);
  v_take numeric(12,2);
  r record;
  v_new_rem numeric(12,2);
  v_new_status text;
  v_claims_applied int := 0;
  v_credits_applied int := 0;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.has_permission(v_uid, 'conciliacion-reembolso', 'edit') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_transport_id IS NULL THEN RAISE EXCEPTION 'transport_id_required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.transports WHERE id = p_transport_id) THEN
    RAISE EXCEPTION 'transport_not_found';
  END IF;

  v_note := NULLIF(trim(COALESCE(p_note, '')), '');
  IF v_note IS NOT NULL AND char_length(v_note) > 2000 THEN
    RAISE EXCEPTION 'note_too_long';
  END IF;

  -- Lock claims (faltantes) en orden determinista
  IF p_claim_ids IS NULL OR cardinality(p_claim_ids) = 0 THEN
    RAISE EXCEPTION 'claims_required';
  END IF;

  -- Validar y sumar claims
  FOR r IN
    SELECT i.id, i.transport_id, i.amount_diff, i.remaining_amount, i.status, i.created_at
    FROM public.cod_irregularities i
    WHERE i.id = ANY (p_claim_ids)
    ORDER BY i.created_at ASC, i.id ASC
    FOR UPDATE OF i
  LOOP
    IF r.transport_id IS DISTINCT FROM p_transport_id THEN
      RAISE EXCEPTION 'cross_transport_not_allowed';
    END IF;
    IF r.status NOT IN ('open', 'in_review') THEN
      RAISE EXCEPTION 'claim_not_active';
    END IF;
    IF r.amount_diff >= -0.004 THEN
      RAISE EXCEPTION 'claim_not_shortage';
    END IF;
    IF r.remaining_amount <= 0.004 THEN
      RAISE EXCEPTION 'claim_remaining_zero';
    END IF;
    v_claim_total := v_claim_total + r.remaining_amount;
  END LOOP;

  IF v_claim_total <= 0.004 THEN
    RAISE EXCEPTION 'claims_remaining_zero';
  END IF;

  -- Credits: adjustments + sobrantes irreg
  IF (p_credit_adjustment_ids IS NULL OR cardinality(p_credit_adjustment_ids) = 0)
     AND (p_credit_irregularity_ids IS NULL OR cardinality(p_credit_irregularity_ids) = 0) THEN
    RAISE EXCEPTION 'credits_required';
  END IF;

  IF p_credit_adjustment_ids IS NOT NULL AND cardinality(p_credit_adjustment_ids) > 0 THEN
    FOR r IN
      SELECT a.id, a.transport_id, a.remaining_amount, a.status, a.direction, a.created_at
      FROM public.cod_transport_adjustments a
      WHERE a.id = ANY (p_credit_adjustment_ids)
      ORDER BY a.created_at ASC, a.id ASC
      FOR UPDATE OF a
    LOOP
      IF r.transport_id IS DISTINCT FROM p_transport_id THEN
        RAISE EXCEPTION 'cross_transport_not_allowed';
      END IF;
      IF r.direction <> 'transport_credit' THEN
        RAISE EXCEPTION 'credit_not_transport_credit';
      END IF;
      IF r.status NOT IN ('open', 'partially_compensated') THEN
        RAISE EXCEPTION 'credit_adjustment_not_active';
      END IF;
      IF r.remaining_amount <= 0.004 THEN
        RAISE EXCEPTION 'credit_remaining_zero';
      END IF;
      v_credit_total := v_credit_total + r.remaining_amount;
    END LOOP;
  END IF;

  IF p_credit_irregularity_ids IS NOT NULL AND cardinality(p_credit_irregularity_ids) > 0 THEN
    FOR r IN
      SELECT i.id, i.transport_id, i.amount_diff, i.remaining_amount, i.status, i.created_at
      FROM public.cod_irregularities i
      WHERE i.id = ANY (p_credit_irregularity_ids)
      ORDER BY i.created_at ASC, i.id ASC
      FOR UPDATE OF i
    LOOP
      IF r.transport_id IS DISTINCT FROM p_transport_id THEN
        RAISE EXCEPTION 'cross_transport_not_allowed';
      END IF;
      IF r.status NOT IN ('open', 'in_review') THEN
        RAISE EXCEPTION 'credit_irregularity_not_active';
      END IF;
      IF r.amount_diff <= 0.004 THEN
        RAISE EXCEPTION 'credit_irregularity_not_surplus';
      END IF;
      IF r.remaining_amount <= 0.004 THEN
        RAISE EXCEPTION 'credit_remaining_zero';
      END IF;
      v_credit_total := v_credit_total + r.remaining_amount;
    END LOOP;
  END IF;

  IF v_credit_total <= 0.004 THEN
    RAISE EXCEPTION 'credits_remaining_zero';
  END IF;

  v_apply := LEAST(v_claim_total, v_credit_total);
  IF v_apply <= 0.004 THEN
    RAISE EXCEPTION 'nothing_to_apply';
  END IF;

  IF v_note IS NULL AND abs(v_claim_total - v_credit_total) < 0.005 THEN
    v_note := 'Diferencias compensadas internamente; sin saldo a reclamar al transporte.';
  ELSIF v_note IS NULL THEN
    v_note := format(
      'Compensación automática FIFO por $%s (claims $%s · credits $%s).',
      v_apply, v_claim_total, v_credit_total
    );
  END IF;

  INSERT INTO public.cod_transport_compensations (
    transport_id, total_applied, note, status, created_by
  ) VALUES (
    p_transport_id, v_apply, v_note, 'applied', v_uid
  )
  RETURNING id INTO v_comp_id;

  -- Distribuir sobre claims FIFO
  v_left := v_apply;
  FOR r IN
    SELECT i.id, i.remaining_amount, i.status, i.remittance_id, i.remittance_row_id
    FROM public.cod_irregularities i
    WHERE i.id = ANY (p_claim_ids)
    ORDER BY i.created_at ASC, i.id ASC
  LOOP
    EXIT WHEN v_left <= 0.004;
    v_take := LEAST(r.remaining_amount, v_left);
    v_new_rem := round(r.remaining_amount - v_take, 2);

    INSERT INTO public.cod_transport_compensation_lines (
      compensation_id, side, source_type, source_id,
      amount_applied, remaining_before, remaining_after
    ) VALUES (
      v_comp_id, 'claim', 'irregularity', r.id,
      v_take, r.remaining_amount, v_new_rem
    );

    IF v_new_rem <= 0.004 THEN
      UPDATE public.cod_irregularities SET
        remaining_amount = 0,
        status = 'resolved',
        resolved_by = v_uid,
        resolved_at = now(),
        resolution_note = 'Compensado con crédito del transporte',
        updated_at = now()
      WHERE id = r.id;

      INSERT INTO public.cod_reconciliation_events (
        remittance_id, remittance_row_id, irregularity_id,
        event_type, actor_id, previous_state, new_state, reason
      ) VALUES (
        r.remittance_id, r.remittance_row_id, r.id,
        'irregularity_compensated', v_uid,
        jsonb_build_object('status', r.status, 'remaining_amount', r.remaining_amount),
        jsonb_build_object(
          'status', 'resolved',
          'remaining_amount', 0,
          'compensation_id', v_comp_id,
          'amount_applied', v_take
        ),
        'Compensado con crédito del transporte'
      );
    ELSE
      UPDATE public.cod_irregularities SET
        remaining_amount = v_new_rem,
        updated_at = now()
      WHERE id = r.id;
    END IF;

    v_left := round(v_left - v_take, 2);
    v_claims_applied := v_claims_applied + 1;
  END LOOP;

  -- Distribuir sobre credit adjustments FIFO
  v_left := v_apply;
  IF p_credit_adjustment_ids IS NOT NULL AND cardinality(p_credit_adjustment_ids) > 0 THEN
    FOR r IN
      SELECT a.id, a.remaining_amount, a.status, a.remittance_id, a.remittance_row_id, a.original_amount
      FROM public.cod_transport_adjustments a
      WHERE a.id = ANY (p_credit_adjustment_ids)
      ORDER BY a.created_at ASC, a.id ASC
    LOOP
      EXIT WHEN v_left <= 0.004;
      v_take := LEAST(r.remaining_amount, v_left);
      v_new_rem := round(r.remaining_amount - v_take, 2);
      v_new_status := CASE
        WHEN v_new_rem <= 0.004 THEN 'compensated'
        ELSE 'partially_compensated'
      END;

      INSERT INTO public.cod_transport_compensation_lines (
        compensation_id, side, source_type, source_id,
        amount_applied, remaining_before, remaining_after
      ) VALUES (
        v_comp_id, 'credit', 'adjustment', r.id,
        v_take, r.remaining_amount, GREATEST(v_new_rem, 0)
      );

      UPDATE public.cod_transport_adjustments SET
        remaining_amount = GREATEST(v_new_rem, 0),
        status = v_new_status,
        updated_at = now()
      WHERE id = r.id;

      v_left := round(v_left - v_take, 2);
      v_credits_applied := v_credits_applied + 1;
    END LOOP;
  END IF;

  -- Distribuir sobrantes irreg como crédito
  IF p_credit_irregularity_ids IS NOT NULL AND cardinality(p_credit_irregularity_ids) > 0 THEN
    FOR r IN
      SELECT i.id, i.remaining_amount, i.status, i.remittance_id, i.remittance_row_id
      FROM public.cod_irregularities i
      WHERE i.id = ANY (p_credit_irregularity_ids)
      ORDER BY i.created_at ASC, i.id ASC
    LOOP
      EXIT WHEN v_left <= 0.004;
      v_take := LEAST(r.remaining_amount, v_left);
      v_new_rem := round(r.remaining_amount - v_take, 2);

      INSERT INTO public.cod_transport_compensation_lines (
        compensation_id, side, source_type, source_id,
        amount_applied, remaining_before, remaining_after
      ) VALUES (
        v_comp_id, 'credit', 'irregularity', r.id,
        v_take, r.remaining_amount, GREATEST(v_new_rem, 0)
      );

      IF v_new_rem <= 0.004 THEN
        UPDATE public.cod_irregularities SET
          remaining_amount = 0,
          status = 'resolved',
          resolved_by = v_uid,
          resolved_at = now(),
          resolution_note = 'Sobrante COD compensado contra reclamos del transporte',
          updated_at = now()
        WHERE id = r.id;
      ELSE
        UPDATE public.cod_irregularities SET
          remaining_amount = v_new_rem,
          updated_at = now()
        WHERE id = r.id;
      END IF;

      v_left := round(v_left - v_take, 2);
      v_credits_applied := v_credits_applied + 1;
    END LOOP;
  END IF;

  IF abs(v_left) > 0.02 THEN
    RAISE EXCEPTION 'compensation_distribution_mismatch leftover=%', v_left;
  END IF;

  INSERT INTO public.cod_reconciliation_events (
    remittance_id, event_type, actor_id, new_state, reason
  )
  SELECT
    COALESCE(
      (SELECT remittance_id FROM public.cod_transport_adjustments
       WHERE id = ANY (COALESCE(p_credit_adjustment_ids, ARRAY[]::uuid[])) LIMIT 1),
      (SELECT remittance_id FROM public.cod_irregularities
       WHERE id = ANY (p_claim_ids) LIMIT 1)
    ),
    'transport_compensation_applied',
    v_uid,
    jsonb_build_object(
      'compensation_id', v_comp_id,
      'transport_id', p_transport_id,
      'total_applied', v_apply,
      'claim_total_selected', v_claim_total,
      'credit_total_selected', v_credit_total,
      'claims_touched', v_claims_applied,
      'credits_touched', v_credits_applied
    ),
    v_note;

  RETURN jsonb_build_object(
    'ok', true,
    'compensation_id', v_comp_id,
    'transport_id', p_transport_id,
    'total_applied', v_apply,
    'claim_total_selected', v_claim_total,
    'credit_total_selected', v_credit_total,
    'net_after_selected', round(v_claim_total - v_credit_total, 2),
    'note', v_note
  );
END;
$fn$;

-- Listado / balance (lectura)
CREATE OR REPLACE FUNCTION public.rpc_cod_list_transport_differences(
  p_transport_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_balances jsonb;
  v_claims jsonb;
  v_credits jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.has_permission(v_uid, 'conciliacion-reembolso', 'view') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY b.transport_name), '[]'::jsonb)
  INTO v_balances
  FROM public.cod_v_transport_difference_balances b
  WHERE p_transport_id IS NULL OR b.transport_id = p_transport_id;

  SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.created_at), '[]'::jsonb)
  INTO v_claims
  FROM (
    SELECT
      i.id,
      i.transport_id,
      i.order_id,
      i.amount_diff,
      i.remaining_amount,
      abs(i.amount_diff) AS original_amount,
      i.status,
      i.created_at,
      i.remittance_id,
      'claim'::text AS side
    FROM public.cod_irregularities i
    WHERE i.status IN ('open', 'in_review')
      AND i.amount_diff < -0.004
      AND i.remaining_amount > 0.004
      AND (p_transport_id IS NULL OR i.transport_id = p_transport_id)
  ) x;

  SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.created_at), '[]'::jsonb)
  INTO v_credits
  FROM (
    SELECT
      a.id,
      a.transport_id,
      a.kind,
      a.original_amount,
      a.remaining_amount,
      a.status,
      a.created_at,
      a.remittance_id,
      a.order_id,
      'adjustment'::text AS source_type,
      'credit'::text AS side
    FROM public.cod_transport_adjustments a
    WHERE a.direction = 'transport_credit'
      AND a.status IN ('open', 'partially_compensated')
      AND a.remaining_amount > 0.004
      AND (p_transport_id IS NULL OR a.transport_id = p_transport_id)
    UNION ALL
    SELECT
      i.id,
      i.transport_id,
      'cod_surplus'::text AS kind,
      abs(i.amount_diff) AS original_amount,
      i.remaining_amount,
      i.status,
      i.created_at,
      i.remittance_id,
      i.order_id,
      'irregularity'::text AS source_type,
      'credit'::text AS side
    FROM public.cod_irregularities i
    WHERE i.status IN ('open', 'in_review')
      AND i.amount_diff > 0.004
      AND i.remaining_amount > 0.004
      AND (p_transport_id IS NULL OR i.transport_id = p_transport_id)
  ) x;

  RETURN jsonb_build_object(
    'ok', true,
    'balances', v_balances,
    'claims', v_claims,
    'credits', v_credits
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.rpc_cod_compensate_transport_differences(uuid, uuid[], uuid[], uuid[], text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_cod_compensate_transport_differences(uuid, uuid[], uuid[], uuid[], text) FROM anon;
GRANT EXECUTE ON FUNCTION public.rpc_cod_compensate_transport_differences(uuid, uuid[], uuid[], uuid[], text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cod_compensate_transport_differences(uuid, uuid[], uuid[], uuid[], text) TO service_role;

REVOKE ALL ON FUNCTION public.rpc_cod_list_transport_differences(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_cod_list_transport_differences(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.rpc_cod_list_transport_differences(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cod_list_transport_differences(uuid) TO service_role;

COMMENT ON FUNCTION public.rpc_cod_compensate_transport_differences(uuid, uuid[], uuid[], uuid[], text) IS
  '298 V1: neteo FIFO min(claims,credits) mismo transporte. amount_diff intacto. Cierra claim total con resolved+nota compensación.';

COMMENT ON FUNCTION public.rpc_cod_list_transport_differences(uuid) IS
  '298: balances + claims/credits abiertos para UI Diferencias del transporte.';

SELECT pg_notify('pgrst', 'reload schema');
