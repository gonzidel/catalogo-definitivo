-- 299_cod_void_remittance_transport_adjustments.sql
--
-- Política void remesa ↔ adjustments + documentación complementary/remaining.
--
-- remaining_amount coherencia con complementary 292–294:
--   NO se modifica el archivo histórico 294.
--   El trigger _cod_irregularity_remaining_sync (295) fuerza remaining=0
--   cuando status pasa a resolved/superseded (exact resolve y partial supersede).
--   INSERT de nueva faltante parcial toma remaining=abs(amount_diff) vía trigger.
--
-- Void remesa:
--   - adjustments con remaining < original → BLOQUEAR remittance_has_compensated_adjustments
--   - adjustments unused → void automático + fila classified_adjustment → unassigned
--     (así 288/291 no ven estados inesperados)
--
-- NO APPLY hasta aprobación.

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
  v_adj record;
  v_voided_adj int := 0;
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

  -- 299: bloquear si hay adjustments ya compensados (parcial o total)
  IF EXISTS (
    SELECT 1
    FROM public.cod_transport_adjustments a
    WHERE a.remittance_id = p_remittance_id
      AND a.status <> 'voided'
      AND (
        a.status IN ('partially_compensated', 'compensated')
        OR abs(a.remaining_amount - a.original_amount) >= 0.005
        OR EXISTS (
          SELECT 1
          FROM public.cod_transport_compensation_lines l
          INNER JOIN public.cod_transport_compensations c ON c.id = l.compensation_id
          WHERE l.source_type = 'adjustment'
            AND l.source_id = a.id
            AND c.status = 'applied'
        )
      )
  ) THEN
    RAISE EXCEPTION 'remittance_has_compensated_adjustments';
  END IF;

  -- Void automático de adjustments unused de esta remesa
  FOR v_adj IN
    SELECT a.*
    FROM public.cod_transport_adjustments a
    WHERE a.remittance_id = p_remittance_id
      AND a.status <> 'voided'
    FOR UPDATE OF a
  LOOP
    UPDATE public.cod_transport_adjustments SET
      status = 'voided',
      remaining_amount = 0,
      voided_by = v_uid,
      voided_at = now(),
      void_reason = 'Anulado por void de rendición',
      updated_at = now()
    WHERE id = v_adj.id;

    UPDATE public.cod_remittance_rows SET
      row_status = 'unassigned',
      updated_at = now()
    WHERE id = v_adj.remittance_row_id
      AND row_status = 'classified_adjustment';

    INSERT INTO public.cod_reconciliation_events (
      remittance_id, remittance_row_id, event_type, actor_id,
      previous_state, new_state, reason
    ) VALUES (
      p_remittance_id,
      v_adj.remittance_row_id,
      'transport_adjustment_voided',
      v_uid,
      jsonb_build_object('adjustment_id', v_adj.id, 'status', v_adj.status),
      jsonb_build_object(
        'adjustment_id', v_adj.id,
        'status', 'voided',
        'via', 'remittance_void',
        'row_status', 'unassigned'
      ),
      'Ajuste sin compensar anulado junto con la rendición (fila vuelve a unassigned para 288/291)'
    );

    v_voided_adj := v_voided_adj + 1;
  END LOOP;

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

  v_result := public._cod_291_void_confirmed_remittance(p_remittance_id, p_reason);

  FOREACH v_order_id IN ARRAY v_supplementary_orders
  LOOP
    SELECT * INTO v_bal FROM public._cod_load_order_cod_balance(v_order_id);

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
      -- remaining → 0 vía trigger 295

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
      -- remaining = abs(amount_diff) vía trigger 295

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
    'supplementary_orders_recalculated', cardinality(v_supplementary_orders),
    'transport_adjustments_voided', v_voided_adj
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.rpc_cod_void_confirmed_remittance(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_cod_void_confirmed_remittance(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.rpc_cod_void_confirmed_remittance(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cod_void_confirmed_remittance(uuid, text) TO service_role;

COMMENT ON FUNCTION public.rpc_cod_void_confirmed_remittance(uuid, text) IS
  '299/294: void remesa; bloquea remittance_has_compensated_adjustments; void auto de adjustments unused. '
  'remaining irreg coherente vía trigger 295 (no patch del cuerpo financiero 294 histórico en archivo).';

SELECT pg_notify('pgrst', 'reload schema');
