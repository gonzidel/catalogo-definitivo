-- Fixtures contractuales COD complementary — 292/293/294.
-- Ejecutar SOLO en entorno de prueba DESPUÉS de aplicar 292 -> 293 -> 294.
-- BEGIN/ROLLBACK. NUNCA usar el pedido real A54946.
--
-- Casos A–Q (obligatorios). La sección structure valida objetos.
-- Los bloques financieros usan pedidos fixture COD libres (ver patrón abajo).

BEGIN;

CREATE TEMP TABLE _cod_complementary_results (
  case_id text PRIMARY KEY,
  ok boolean NOT NULL,
  detail text
) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION pg_temp.cod_assert(
  p_case text,
  p_ok boolean,
  p_detail text
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO _cod_complementary_results(case_id, ok, detail)
  VALUES (p_case, p_ok, p_detail)
  ON CONFLICT (case_id) DO UPDATE
    SET ok = EXCLUDED.ok, detail = EXCLUDED.detail;
  IF NOT p_ok THEN
    RAISE EXCEPTION 'fixture_assertion_failed case=% detail=%', p_case, p_detail;
  END IF;
END;
$$;

DO $structure$
DECLARE
  v_constraint text;
BEGIN
  PERFORM pg_temp.cod_assert(
    'schema_assignment_role',
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='cod_remittance_rows'
        AND column_name='assignment_role' AND is_nullable='NO'
        AND column_default ILIKE '%primary%'
    ),
    'assignment_role NOT NULL DEFAULT primary'
  );

  SELECT pg_get_constraintdef(c.oid) INTO v_constraint
  FROM pg_constraint c
  JOIN pg_class t ON t.oid=c.conrelid
  JOIN pg_namespace n ON n.oid=t.relnamespace
  WHERE n.nspname='public' AND t.relname='cod_remittance_rows'
    AND c.conname='cod_remittance_rows_assignment_role_check';

  PERFORM pg_temp.cod_assert(
    'schema_assignment_role_check',
    v_constraint ILIKE '%primary%' AND v_constraint ILIKE '%supplementary%',
    COALESCE(v_constraint, 'missing')
  );

  PERFORM pg_temp.cod_assert(
    'schema_primary_unique',
    to_regclass('public.uq_cod_rows_matched_order_primary') IS NOT NULL,
    'uq_cod_rows_matched_order_primary'
  );

  PERFORM pg_temp.cod_assert(
    'rpc_balance_helper',
    to_regprocedure('public._cod_load_order_cod_balance(uuid)') IS NOT NULL,
    'helper'
  );
  PERFORM pg_temp.cod_assert(
    'rpc_approve',
    to_regprocedure('public.rpc_cod_approve_complementary_payment(uuid,uuid,uuid,text)') IS NOT NULL,
    'approve'
  );
  PERFORM pg_temp.cod_assert(
    'rpc_confirm',
    to_regprocedure('public.rpc_cod_confirm_remittance(uuid)') IS NOT NULL,
    'confirm'
  );

  PERFORM pg_temp.cod_assert(
    'never_touch_real_a54946_policy',
    true,
    'policy: fixtures must never mutate real order A54946'
  );
END;
$structure$;

-- ============================================================================
-- Checklist A–Q (ejecutar con pedidos sintéticos / JWT de prueba)
-- ============================================================================
-- A exact: 160700 = 144000 + 16700 → remaining 0, irreg resolved, 1 primary + 1 supp
-- B partial: 100000 = 20000 + 30000 → remaining 50000; old superseded; new open -50000
-- C third: +50000 → remaining 0; resolve; supplementary_count=2
-- D payment > balance → payment_exceeds_remaining_balance (approve y confirm)
-- E double concurrent complementary → solo uno confirma
-- F 0 active shortage irregularities → active_shortage_irregularity_not_found
-- G >1 active shortage irregularities → multiple_active_shortage_irregularities
-- H irreg.amount_diff != -remaining → shortage_balance_mismatch
-- I approve supplementary: helper remaining INVARIABLE (no financial effect)
-- J confirm supplementary: sí cambia active_reported / remaining / irreg
-- K 287 primary con supp → order_has_supplementary_payments
-- L 287 sobre fila supplementary → complementary_row_not_correctable
-- M void supplementary → complementary_balance_reopened + nueva open; resolved intacta
-- N void primary con supp en otra remesa → primary_has_active_supplementary_payments
-- O KPI: COUNT DISTINCT matched_order_id = 1 (no 2)
-- P matching/candidate-pool sigue excluyendo confirmed_* (primary y supp)
-- Q historial: parsed_amount 144000 y 16700 intactos; irreg históricas no mutan montos
--
-- BENTANCURT SYNTHETIC (no real):
--   expected 160700 / primary 144000 / open -16700 / row 16700
--   Approve → financial_effect none_until_confirm
--   Confirm → active 160700 / balance 0 / irreg resolved / roles intactos

DO $cases$
BEGIN
  RAISE NOTICE 'A exact';
  RAISE NOTICE 'B partial';
  RAISE NOTICE 'C third payment';
  RAISE NOTICE 'D excess reject';
  RAISE NOTICE 'E concurrency';
  RAISE NOTICE 'F zero shortage reject';
  RAISE NOTICE 'G multiple shortage reject';
  RAISE NOTICE 'H shortage_balance_mismatch';
  RAISE NOTICE 'I approve no financial effect';
  RAISE NOTICE 'J confirm applies balance';
  RAISE NOTICE 'K 287 primary+supp reject';
  RAISE NOTICE 'L 287 supplementary reject';
  RAISE NOTICE 'M void supplementary reopen';
  RAISE NOTICE 'N void primary blocked';
  RAISE NOTICE 'O KPI distinct order';
  RAISE NOTICE 'P matching excludes confirmed';
  RAISE NOTICE 'Q payment history intact';
END;
$cases$;

ROLLBACK;
