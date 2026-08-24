-- ============================================================================
-- COD transport differences — runtime audit 295–299
-- ============================================================================
-- Requires 295-299 already applied on the target DB OR run inside a session that
-- applied them in the same transaction. For prod fyl-core: DO NOT apply permanently
-- — use throwaway branch or apply+audit+rollback in one session.
--
-- BEGIN…ROLLBACK. MUST NOT leave anything applied.
-- MUST NEVER touch order A54945 or customer MAIRA/ORTEGA real.
--
-- Soft asserts (record ok/fail, no RAISE) so the final SELECT shows the full matrix.
-- ============================================================================

BEGIN;

-- Auth stub for SECURITY DEFINER RPCs
SELECT set_config('request.jwt.claim.sub', 'f6d58fbc-bd13-4ede-ac4c-ad7c39109983', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"f6d58fbc-bd13-4ede-ac4c-ad7c39109983","role":"authenticated"}',
  true
);

CREATE TEMP TABLE _cod_diff_audit_results (
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
  INSERT INTO _cod_diff_audit_results(case_id, ok, detail)
  VALUES (p_case, p_ok, p_detail)
  ON CONFLICT (case_id) DO UPDATE
    SET ok = EXCLUDED.ok, detail = EXCLUDED.detail;
END;
$$;

-- ---------------------------------------------------------------------------
-- Section A: structure checks (skip Section B if 295–299 not present)
-- ---------------------------------------------------------------------------
DO $structure$
DECLARE
  v_schema_ok boolean := true;
  v_admin_id uuid;
  v_perm_ok boolean;
  v_a54945 text;
  v_maira int;
BEGIN
  -- Safety: real business rows must stay untouched by this script's policy
  SELECT o.order_number INTO v_a54945
  FROM public.orders o
  WHERE o.order_number = 'A54945'
  LIMIT 1;

  PERFORM pg_temp.cod_assert(
    'A00_never_touch_a54945_policy',
    true,
    format('policy: never mutate A54945 (exists=%s)', v_a54945 IS NOT NULL)
  );

  SELECT count(*) INTO v_maira
  FROM public.customers c
  WHERE c.full_name ILIKE '%MAIRA%' OR c.full_name ILIKE '%ORTEGA%MAIRA%';

  PERFORM pg_temp.cod_assert(
    'A00_never_touch_maira_policy',
    true,
    format('policy: never mutate MAIRA/ORTEGA real (customers_name_match_count=%s)', v_maira)
  );

  -- Columns / tables
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'cod_irregularities'
      AND column_name = 'remaining_amount'
  ) THEN
    v_schema_ok := false;
    PERFORM pg_temp.cod_assert(
      'A01_remaining_amount',
      false,
      'schema_295_299_not_applied: cod_irregularities.remaining_amount missing'
    );
  ELSE
    PERFORM pg_temp.cod_assert('A01_remaining_amount', true, 'column present');
  END IF;

  IF to_regclass('public.cod_transport_adjustments') IS NULL THEN
    v_schema_ok := false;
    PERFORM pg_temp.cod_assert(
      'A02_adjustments_table',
      false,
      'schema_295_299_not_applied: cod_transport_adjustments missing'
    );
  ELSE
    PERFORM pg_temp.cod_assert('A02_adjustments_table', true, 'table present');
  END IF;

  IF to_regclass('public.cod_transport_compensations') IS NULL
     OR to_regclass('public.cod_transport_compensation_lines') IS NULL THEN
    v_schema_ok := false;
    PERFORM pg_temp.cod_assert(
      'A03_compensations_tables',
      false,
      'schema_295_299_not_applied: compensations/lines missing'
    );
  ELSE
    PERFORM pg_temp.cod_assert('A03_compensations_tables', true, 'tables present');
  END IF;

  IF to_regclass('public.cod_v_transport_difference_balances') IS NULL THEN
    v_schema_ok := false;
    PERFORM pg_temp.cod_assert(
      'A04_balance_view',
      false,
      'schema_295_299_not_applied: cod_v_transport_difference_balances missing'
    );
  ELSE
    PERFORM pg_temp.cod_assert('A04_balance_view', true, 'view present');
  END IF;

  IF to_regprocedure('public.rpc_cod_register_transport_adjustment(uuid,uuid,text,text,uuid,uuid)') IS NULL THEN
    v_schema_ok := false;
    PERFORM pg_temp.cod_assert(
      'A05_rpc_register',
      false,
      'schema_295_299_not_applied: rpc_cod_register_transport_adjustment missing'
    );
  ELSE
    PERFORM pg_temp.cod_assert('A05_rpc_register', true, 'rpc present');
  END IF;

  IF to_regprocedure('public.rpc_cod_void_transport_adjustment(uuid,text)') IS NULL THEN
    v_schema_ok := false;
    PERFORM pg_temp.cod_assert(
      'A06_rpc_void_adj',
      false,
      'schema_295_299_not_applied: rpc_cod_void_transport_adjustment missing'
    );
  ELSE
    PERFORM pg_temp.cod_assert('A06_rpc_void_adj', true, 'rpc present');
  END IF;

  IF to_regprocedure(
    'public.rpc_cod_compensate_transport_differences(uuid,uuid[],uuid[],uuid[],text)'
  ) IS NULL THEN
    v_schema_ok := false;
    PERFORM pg_temp.cod_assert(
      'A07_rpc_compensate',
      false,
      'schema_295_299_not_applied: rpc_cod_compensate_transport_differences missing'
    );
  ELSE
    PERFORM pg_temp.cod_assert('A07_rpc_compensate', true, 'rpc present');
  END IF;

  IF to_regprocedure('public.rpc_cod_list_transport_differences(uuid)') IS NULL THEN
    v_schema_ok := false;
    PERFORM pg_temp.cod_assert(
      'A08_rpc_list',
      false,
      'schema_295_299_not_applied: rpc_cod_list_transport_differences missing'
    );
  ELSE
    PERFORM pg_temp.cod_assert('A08_rpc_list', true, 'rpc present');
  END IF;

  IF to_regprocedure('public._cod_irregularity_remaining_sync()') IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = '_cod_irregularity_remaining_sync'
     ) THEN
    v_schema_ok := false;
    PERFORM pg_temp.cod_assert(
      'A09_remaining_trigger_fn',
      false,
      'schema_295_299_not_applied: _cod_irregularity_remaining_sync missing'
    );
  ELSE
    PERFORM pg_temp.cod_assert(
      'A09_remaining_trigger_fn',
      EXISTS (
        SELECT 1 FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = 'cod_irregularities'
          AND t.tgname = 'trg_cod_irregularity_remaining_sync'
          AND NOT t.tgisinternal
      ),
      'trigger trg_cod_irregularity_remaining_sync'
    );
  END IF;

  PERFORM pg_temp.cod_assert(
    'A10_classified_adjustment_allowed',
    EXISTS (
      SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public'
        AND t.relname = 'cod_remittance_rows'
        AND c.contype = 'c'
        AND pg_get_constraintdef(c.oid) ILIKE '%classified_adjustment%'
    ),
    'row_status check includes classified_adjustment'
  );

  PERFORM pg_temp.cod_assert(
    'A11_event_types',
    EXISTS (
      SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public'
        AND t.relname = 'cod_reconciliation_events'
        AND c.contype = 'c'
        AND pg_get_constraintdef(c.oid) ILIKE '%transport_adjustment_registered%'
        AND pg_get_constraintdef(c.oid) ILIKE '%transport_compensation_applied%'
        AND pg_get_constraintdef(c.oid) ILIKE '%irregularity_compensated%'
    ),
    'event_type check includes 296 transport events'
  );

  IF NOT v_schema_ok THEN
    PERFORM pg_temp.cod_assert(
      'schema_295_299_not_applied',
      false,
      'Section B skipped — apply 295–299 in this session (or branch) then re-run'
    );
  ELSE
    PERFORM pg_temp.cod_assert(
      'schema_295_299_not_applied',
      true,
      'schema objects detected — Section B will run'
    );
  END IF;

  -- Ensure JWT admin can call RPCs (permission inserted only inside this TX)
  SELECT a.id INTO v_admin_id
  FROM public.admins a
  WHERE a.user_id = 'f6d58fbc-bd13-4ede-ac4c-ad7c39109983'::uuid
  LIMIT 1;

  PERFORM pg_temp.cod_assert(
    'A12_admin_membership',
    v_admin_id IS NOT NULL,
    format('admins.user_id f6d58fbc… → admin_id=%s', v_admin_id)
  );

  IF v_admin_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.admin_permissions
      WHERE admin_id = v_admin_id AND permission_key = 'conciliacion-reembolso'
    ) THEN
      UPDATE public.admin_permissions
      SET can_view = true, can_edit = true
      WHERE admin_id = v_admin_id AND permission_key = 'conciliacion-reembolso';
    ELSE
      INSERT INTO public.admin_permissions (admin_id, permission_key, can_view, can_edit, can_delete)
      VALUES (v_admin_id, 'conciliacion-reembolso', true, true, false);
    END IF;
  END IF;

  v_perm_ok := public.has_permission(
    'f6d58fbc-bd13-4ede-ac4c-ad7c39109983'::uuid,
    'conciliacion-reembolso',
    'edit'
  );
  PERFORM pg_temp.cod_assert(
    'A13_has_permission_edit',
    COALESCE(v_perm_ok, false),
    'has_permission(f6d58fbc…, conciliacion-reembolso, edit)'
  );
END;
$structure$;

-- ---------------------------------------------------------------------------
-- Section B: synthetic runtime cases (only if schema present)
-- ---------------------------------------------------------------------------
DO $cases$
DECLARE
  v_schema_ok boolean;
  v_admin uuid := 'f6d58fbc-bd13-4ede-ac4c-ad7c39109983';
  v_tr uuid;
  v_tr2 uuid;
  v_cust uuid;
  v_ord uuid;
  v_ord2 uuid;
  v_ord3 uuid;
  v_ord4 uuid;
  v_rem uuid;
  v_rem2 uuid;
  v_rem_void uuid;
  v_rem_void2 uuid;
  v_row uuid;
  v_row2 uuid;
  v_row3 uuid;
  v_row4 uuid;
  v_row5 uuid;
  v_row_void uuid;
  v_row_void2 uuid;
  v_irreg uuid;
  v_irreg2 uuid;
  v_irreg3 uuid;
  v_irreg4 uuid;
  v_irreg_pos uuid;
  v_irreg_new uuid;
  v_adj uuid;
  v_adj2 uuid;
  v_adj3 uuid;
  v_adj4 uuid;
  v_adj_void uuid;
  v_adj_used uuid;
  v_res jsonb;
  v_err text;
  v_rem_amt numeric;
  v_diff numeric;
  v_status text;
  v_pm text;
  v_cnt int;
  v_claim_open numeric;
  v_credit_open numeric;
  v_net numeric;
  v_before_claim numeric;
  v_before_credit numeric;
  v_before_net numeric;
  v_after_claim numeric;
  v_after_credit numeric;
  v_after_net numeric;
  v_comp_before int;
  v_comp_after int;
  v_lines_before int;
  v_lines_after int;
  v_a54945_before text;
  v_a54945_after text;
  v_a54945_pm text;
  v_a54945_total numeric;
  v_dblink boolean;
BEGIN
  SELECT ok INTO v_schema_ok
  FROM _cod_diff_audit_results
  WHERE case_id = 'schema_295_299_not_applied';

  IF NOT COALESCE(v_schema_ok, false) THEN
    PERFORM pg_temp.cod_assert(
      'B00_section_skipped',
      true,
      'schema missing — synthetic cases not executed'
    );
    RETURN;
  END IF;

  -- Snapshot A54945 (must be identical at end)
  SELECT o.payment_method, o.total_amount, o.status
  INTO v_a54945_pm, v_a54945_total, v_a54945_before
  FROM public.orders o
  WHERE o.order_number = 'A54945'
  LIMIT 1;

  -- Synthetic transports (ROLLBACK removes)
  INSERT INTO public.transports (id, name)
  VALUES (gen_random_uuid(), 'FX-DIFF-AUDIT-TR-' || substr(gen_random_uuid()::text, 1, 8))
  RETURNING id INTO v_tr;

  INSERT INTO public.transports (id, name)
  VALUES (gen_random_uuid(), 'FX-DIFF-AUDIT-TR2-' || substr(gen_random_uuid()::text, 1, 8))
  RETURNING id INTO v_tr2;

  -- Synthetic customer (no auth.users FK on prod)
  v_cust := gen_random_uuid();
  INSERT INTO public.customers (id, full_name, email, created_by_admin, auth_provider)
  VALUES (
    v_cust,
    'FX COD DIFF AUDIT CUSTOMER',
    'fx-diff-audit-' || substr(v_cust::text, 1, 8) || '@example.invalid',
    true,
    'admin'
  );

  PERFORM pg_temp.cod_assert(
    'B00_fixture_customer_not_maira',
    NOT EXISTS (
      SELECT 1 FROM public.customers
      WHERE id = v_cust AND (full_name ILIKE '%MAIRA%' OR full_name ILIKE '%ORTEGA%')
    ),
    'fixture customer name safe'
  );

  -- Helper: create COD sent order
  INSERT INTO public.orders (
    id, customer_id, status, payment_method, total_amount, order_number,
    transport_id, sent_at, source
  ) VALUES (
    gen_random_uuid(), v_cust, 'sent', 'Contra Reembolso', 100000,
    'FX-DIFF-' || substr(gen_random_uuid()::text, 1, 12),
    v_tr, now(), 'admin'
  ) RETURNING id INTO v_ord;

  INSERT INTO public.orders (
    id, customer_id, status, payment_method, total_amount, order_number,
    transport_id, sent_at, source
  ) VALUES (
    gen_random_uuid(), v_cust, 'sent', 'Contra Reembolso', 50000,
    'FX-DIFF-' || substr(gen_random_uuid()::text, 1, 12),
    v_tr, now(), 'admin'
  ) RETURNING id INTO v_ord2;

  INSERT INTO public.orders (
    id, customer_id, status, payment_method, total_amount, order_number,
    transport_id, sent_at, source
  ) VALUES (
    gen_random_uuid(), v_cust, 'sent', 'Contra Reembolso', 30000,
    'FX-DIFF-' || substr(gen_random_uuid()::text, 1, 12),
    v_tr, now(), 'admin'
  ) RETURNING id INTO v_ord3;

  INSERT INTO public.orders (
    id, customer_id, status, payment_method, total_amount, order_number,
    transport_id, sent_at, source
  ) VALUES (
    gen_random_uuid(), v_cust, 'sent', 'Contra Reembolso', 40000,
    'FX-DIFF-' || substr(gen_random_uuid()::text, 1, 12),
    v_tr, now(), 'admin'
  ) RETURNING id INTO v_ord4;

  -- =========================================================================
  -- 1) Trigger remaining: insert open → abs(diff); resolved → 0; supersede → 0
  -- =========================================================================
  INSERT INTO public.cod_remittances (
    transport_id, remittance_date, reported_total, calculated_total, row_count,
    status, content_hash, notes, created_by, confirmed_by, confirmed_at,
    analyzed_at, sheet_revision
  ) VALUES (
    v_tr, CURRENT_DATE, 80000, 80000, 1, 'confirmed',
    'fx-diff-trigger-' || gen_random_uuid()::text,
    'fx trigger remaining', v_admin, v_admin, now(), now(), 1
  ) RETURNING id INTO v_rem;

  INSERT INTO public.cod_remittance_rows (
    remittance_id, row_index, sheet_revision, raw_line, raw_transport_date_text,
    raw_customer_name_text, raw_amount_text, parsed_transport_date, parsed_amount,
    row_status, matched_order_id, assignment_method, assignment_role,
    order_number_snapshot, expected_amount_snapshot, order_sent_date_snapshot,
    order_sent_date_origin, transport_name_snapshot, matched_name_snapshot,
    matched_name_source, assigned_by, assigned_at, will_create_irregularity
  ) VALUES (
    v_rem, 0, 1, 'L0', to_char(CURRENT_DATE, 'DD/MM/YYYY'),
    'FX TRIGGER', '80000', CURRENT_DATE, 80000,
    'confirmed_with_irregularity', v_ord, 'manual', 'primary',
    'FX-TRIG', 100000, CURRENT_DATE, 'sent_at', 'FX-TR', 'FX TRIGGER',
    'label', v_admin, now(), true
  ) RETURNING id INTO v_row;

  INSERT INTO public.cod_irregularities (
    remittance_row_id, order_id, remittance_id, transport_id,
    order_sent_date_snapshot, remittance_date_snapshot,
    expected_amount, reported_amount, amount_diff, status, created_by
  ) VALUES (
    v_row, v_ord, v_rem, v_tr, CURRENT_DATE, CURRENT_DATE,
    100000, 80000, -20000, 'open', v_admin
  ) RETURNING id, remaining_amount, amount_diff
  INTO v_irreg, v_rem_amt, v_diff;

  PERFORM pg_temp.cod_assert(
    '01_trigger_insert_remaining',
    v_rem_amt = 20000 AND v_diff = -20000,
    format('remaining=%s amount_diff=%s', v_rem_amt, v_diff)
  );

  UPDATE public.cod_irregularities
  SET status = 'resolved',
      resolved_by = v_admin,
      resolved_at = now(),
      resolution_note = 'fx 285-like resolve',
      updated_at = now()
  WHERE id = v_irreg
  RETURNING remaining_amount, amount_diff INTO v_rem_amt, v_diff;

  PERFORM pg_temp.cod_assert(
    '01_trigger_resolved_remaining_zero',
    v_rem_amt = 0 AND v_diff = -20000,
    format('remaining=%s amount_diff=%s (amount_diff unchanged)', v_rem_amt, v_diff)
  );

  -- second irreg for supersede path (dedicated remittance + order)
  INSERT INTO public.cod_remittances (
    transport_id, remittance_date, reported_total, calculated_total, row_count,
    status, content_hash, notes, created_by, confirmed_by, confirmed_at,
    analyzed_at, sheet_revision
  ) VALUES (
    v_tr, CURRENT_DATE, 10000, 10000, 1, 'confirmed',
    'fx-diff-supersede-' || gen_random_uuid()::text,
    'fx supersede', v_admin, v_admin, now(), now(), 1
  ) RETURNING id INTO v_rem2;

  INSERT INTO public.cod_remittance_rows (
    remittance_id, row_index, sheet_revision, raw_line, raw_transport_date_text,
    raw_customer_name_text, raw_amount_text, parsed_transport_date, parsed_amount,
    row_status, matched_order_id, assignment_method, assignment_role,
    expected_amount_snapshot, will_create_irregularity
  ) VALUES (
    v_rem2, 0, 1, 'L0', to_char(CURRENT_DATE, 'DD/MM/YYYY'),
    'FX SUPER', '10000', CURRENT_DATE, 10000,
    'confirmed_with_irregularity', v_ord2, 'manual', 'primary',
    50000, true
  ) RETURNING id INTO v_row2;

  INSERT INTO public.cod_irregularities (
    remittance_row_id, order_id, remittance_id, transport_id,
    order_sent_date_snapshot, remittance_date_snapshot,
    expected_amount, reported_amount, amount_diff, status, created_by
  ) VALUES (
    v_row2, v_ord2, v_rem2, v_tr, CURRENT_DATE, CURRENT_DATE,
    50000, 10000, -40000, 'open', v_admin
  ) RETURNING id INTO v_irreg2;

  UPDATE public.cod_irregularities
  SET status = 'superseded',
      superseded_reason = 'remittance_voided',
      superseded_at = now(),
      superseded_by = v_admin,
      updated_at = now()
  WHERE id = v_irreg2
  RETURNING remaining_amount INTO v_rem_amt;

  PERFORM pg_temp.cod_assert(
    '01_trigger_supersede_remaining_zero',
    v_rem_amt = 0,
    format('remaining=%s', v_rem_amt)
  );

  -- =========================================================================
  -- 2) Simulate 285-like resolve + complementary-like supersede+insert partial
  -- =========================================================================
  INSERT INTO public.cod_remittances (
    transport_id, remittance_date, reported_total, calculated_total, row_count,
    status, content_hash, notes, created_by, confirmed_by, confirmed_at,
    analyzed_at, sheet_revision
  ) VALUES (
    v_tr, CURRENT_DATE, 20000, 20000, 1, 'confirmed',
    'fx-diff-comp-sim-' || gen_random_uuid()::text,
    'fx complementary sim', v_admin, v_admin, now(), now(), 1
  ) RETURNING id INTO v_rem;

  INSERT INTO public.cod_remittance_rows (
    remittance_id, row_index, sheet_revision, raw_line, raw_transport_date_text,
    raw_customer_name_text, raw_amount_text, parsed_transport_date, parsed_amount,
    row_status, matched_order_id, assignment_method, assignment_role,
    expected_amount_snapshot, will_create_irregularity
  ) VALUES (
    v_rem, 0, 1, 'L0', to_char(CURRENT_DATE, 'DD/MM/YYYY'),
    'FX COMP SIM', '20000', CURRENT_DATE, 20000,
    'confirmed_with_irregularity', v_ord3, 'manual', 'primary',
    100000, true
  ) RETURNING id INTO v_row;

  INSERT INTO public.cod_irregularities (
    remittance_row_id, order_id, remittance_id, transport_id,
    order_sent_date_snapshot, remittance_date_snapshot,
    expected_amount, reported_amount, amount_diff, status, created_by
  ) VALUES (
    v_row, v_ord3, v_rem, v_tr, CURRENT_DATE, CURRENT_DATE,
    100000, 20000, -80000, 'open', v_admin
  ) RETURNING id INTO v_irreg3;

  -- complementary-like: supersede old + insert new partial shortage
  UPDATE public.cod_irregularities
  SET status = 'superseded',
      superseded_reason = 'complementary_payment_partial',
      superseded_at = now(),
      superseded_by = v_admin,
      updated_at = now()
  WHERE id = v_irreg3;

  INSERT INTO public.cod_irregularities (
    remittance_row_id, order_id, remittance_id, transport_id,
    order_sent_date_snapshot, remittance_date_snapshot,
    expected_amount, reported_amount, amount_diff, status, created_by
  ) VALUES (
    v_row, v_ord3, v_rem, v_tr, CURRENT_DATE, CURRENT_DATE,
    80000, 30000, -50000, 'open', v_admin
  ) RETURNING id, remaining_amount INTO v_irreg_new, v_rem_amt;

  SELECT remaining_amount, status INTO v_diff, v_status
  FROM public.cod_irregularities WHERE id = v_irreg3;

  PERFORM pg_temp.cod_assert(
    '02_sim_complementary_partial',
    v_status = 'superseded' AND v_diff = 0
      AND v_rem_amt = 50000
      AND NOT EXISTS (
        SELECT 1 FROM public.cod_transport_adjustments a
        WHERE a.remittance_row_id = v_row
      ),
    format('old_status=%s old_rem=%s new_rem=%s', v_status, v_diff, v_rem_amt)
  );

  -- =========================================================================
  -- 3) Register adjustment 75495 via RPC on synthetic unassigned row
  -- =========================================================================
  INSERT INTO public.cod_remittances (
    transport_id, remittance_date, reported_total, calculated_total, row_count,
    status, content_hash, notes, created_by, analyzed_at, sheet_revision
  ) VALUES (
    v_tr, CURRENT_DATE, 75495, 75495, 1, 'analyzed',
    'fx-diff-reg-' || gen_random_uuid()::text,
    'fx register adj', v_admin, now(), 1
  ) RETURNING id INTO v_rem;

  INSERT INTO public.cod_remittance_rows (
    remittance_id, row_index, sheet_revision, raw_line, raw_transport_date_text,
    raw_customer_name_text, raw_amount_text, parsed_transport_date, parsed_amount,
    row_status
  ) VALUES (
    v_rem, 0, 1, 'L0', to_char(CURRENT_DATE, 'DD/MM/YYYY'),
    'FX ADJ 75495', '75495', CURRENT_DATE, 75495, 'unassigned'
  ) RETURNING id INTO v_row;

  SELECT payment_method INTO v_pm FROM public.orders WHERE id = v_ord;

  BEGIN
    v_res := public.rpc_cod_register_transport_adjustment(
      v_rem, v_row, 'paid_other_method', 'fx register 75495', NULL, NULL
    );
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN
    v_res := NULL;
    v_err := SQLERRM;
  END;

  SELECT a.id, a.original_amount, a.remaining_amount, a.status, r.row_status
  INTO v_adj, v_diff, v_rem_amt, v_status, v_a54945_after
  FROM public.cod_transport_adjustments a
  JOIN public.cod_remittance_rows r ON r.id = a.remittance_row_id
  WHERE a.remittance_row_id = v_row AND a.status <> 'voided'
  LIMIT 1;

  PERFORM pg_temp.cod_assert(
    '03_register_75495',
    v_err IS NULL
      AND COALESCE((v_res->>'ok')::boolean, false)
      AND v_adj IS NOT NULL
      AND v_diff = 75495
      AND v_rem_amt = 75495
      AND v_status = 'open'
      AND v_a54945_after = 'classified_adjustment'
      AND (SELECT payment_method FROM public.orders WHERE id = v_ord) IS NOT DISTINCT FROM v_pm,
    format('err=%s res=%s adj=%s orig=%s rem=%s row=%s',
      v_err, left(COALESCE(v_res::text, 'null'), 120), v_adj, v_diff, v_rem_amt, v_a54945_after)
  );

  -- =========================================================================
  -- 4) Duplicate active adjustment → adjustment_already_active_for_row
  -- =========================================================================
  BEGIN
    v_res := public.rpc_cod_register_transport_adjustment(
      v_rem, v_row, 'other', 'duplicate should fail', NULL, NULL
    );
    v_err := 'NO_EXCEPTION';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    v_res := NULL;
  END;

  PERFORM pg_temp.cod_assert(
    '04_duplicate_active_adjustment',
    v_err ILIKE '%adjustment_already_active_for_row%'
      OR v_err ILIKE '%row_already_classified_adjustment%',
    format('err=%s', v_err)
  );

  -- =========================================================================
  -- Balance snapshot BEFORE compensate cases (case 15 before)
  -- =========================================================================
  SELECT COALESCE(b.claim_open, 0), COALESCE(b.credit_open, 0), COALESCE(b.net_balance, 0)
  INTO v_before_claim, v_before_credit, v_before_net
  FROM public.cod_v_transport_difference_balances b
  WHERE b.transport_id = v_tr;

  v_before_claim := COALESCE(v_before_claim, 0);
  v_before_credit := COALESCE(v_before_credit, 0);
  v_before_net := COALESCE(v_before_net, 0);

  PERFORM pg_temp.cod_assert(
    '15_balance_before',
    true,
    format('claim=%s credit=%s net=%s', v_before_claim, v_before_credit, v_before_net)
  );

  -- =========================================================================
  -- Shared claim/credit setup for cases 5–9
  -- Claim 20k + credit adj 20k (exact); then separate setups for partial/FIFO
  -- =========================================================================

  -- --- Exact 20k/20k ---
  INSERT INTO public.cod_remittances (
    transport_id, remittance_date, reported_total, calculated_total, row_count,
    status, content_hash, notes, created_by, confirmed_by, confirmed_at,
    analyzed_at, sheet_revision
  ) VALUES (
    v_tr, CURRENT_DATE, 30000, 30000, 1, 'confirmed',
    'fx-diff-exact-claim-' || gen_random_uuid()::text,
    'fx exact claim', v_admin, v_admin, now(), now(), 1
  ) RETURNING id INTO v_rem;

  INSERT INTO public.cod_remittance_rows (
    remittance_id, row_index, sheet_revision, raw_line, raw_transport_date_text,
    raw_customer_name_text, raw_amount_text, parsed_transport_date, parsed_amount,
    row_status, matched_order_id, assignment_method, assignment_role,
    expected_amount_snapshot, will_create_irregularity
  ) VALUES (
    v_rem, 0, 1, 'L0', to_char(CURRENT_DATE, 'DD/MM/YYYY'),
    'FX EXACT CLAIM', '30000', CURRENT_DATE, 30000,
    'confirmed_with_irregularity', v_ord4, 'manual', 'primary',
    50000, true
  ) RETURNING id INTO v_row;

  INSERT INTO public.cod_irregularities (
    remittance_row_id, order_id, remittance_id, transport_id,
    order_sent_date_snapshot, remittance_date_snapshot,
    expected_amount, reported_amount, amount_diff, status, created_by
  ) VALUES (
    v_row, v_ord4, v_rem, v_tr, CURRENT_DATE, CURRENT_DATE,
    50000, 30000, -20000, 'open', v_admin
  ) RETURNING id INTO v_irreg;

  INSERT INTO public.cod_remittances (
    transport_id, remittance_date, reported_total, calculated_total, row_count,
    status, content_hash, notes, created_by, analyzed_at, sheet_revision
  ) VALUES (
    v_tr, CURRENT_DATE, 20000, 20000, 1, 'analyzed',
    'fx-diff-exact-cred-' || gen_random_uuid()::text,
    'fx exact credit', v_admin, now(), 1
  ) RETURNING id INTO v_rem2;

  INSERT INTO public.cod_remittance_rows (
    remittance_id, row_index, sheet_revision, raw_line, raw_transport_date_text,
    raw_customer_name_text, raw_amount_text, parsed_transport_date, parsed_amount,
    row_status
  ) VALUES (
    v_rem2, 0, 1, 'L0', to_char(CURRENT_DATE, 'DD/MM/YYYY'),
    'FX EXACT CRED', '20000', CURRENT_DATE, 20000, 'unassigned'
  ) RETURNING id INTO v_row2;

  v_res := public.rpc_cod_register_transport_adjustment(
    v_rem2, v_row2, 'foreign_client', 'fx exact credit 20k', NULL, NULL
  );
  v_adj := (v_res->>'adjustment_id')::uuid;

  BEGIN
    v_res := public.rpc_cod_compensate_transport_differences(
      v_tr, ARRAY[v_irreg], ARRAY[v_adj], NULL, 'fx exact 20k/20k'
    );
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    v_res := NULL;
  END;

  SELECT remaining_amount, status, amount_diff
  INTO v_rem_amt, v_status, v_diff
  FROM public.cod_irregularities WHERE id = v_irreg;

  SELECT remaining_amount, status INTO v_claim_open, v_a54945_after
  FROM public.cod_transport_adjustments WHERE id = v_adj;

  PERFORM pg_temp.cod_assert(
    '05_exact_20k_20k',
    v_err IS NULL
      AND COALESCE((v_res->>'ok')::boolean, false)
      AND v_rem_amt = 0 AND v_status = 'resolved' AND v_diff = -20000
      AND v_claim_open = 0 AND v_a54945_after = 'compensated',
    format('err=%s claim_rem=%s claim_st=%s diff=%s adj_rem=%s adj_st=%s',
      v_err, v_rem_amt, v_status, v_diff, v_claim_open, v_a54945_after)
  );

  -- --- Partial 20k claim / 15k credit ---
  INSERT INTO public.orders (
    id, customer_id, status, payment_method, total_amount, order_number,
    transport_id, sent_at, source
  ) VALUES (
    gen_random_uuid(), v_cust, 'sent', 'Contra Reembolso', 40000,
    'FX-DIFF-' || substr(gen_random_uuid()::text, 1, 12),
    v_tr, now(), 'admin'
  ) RETURNING id INTO v_ord;

  INSERT INTO public.cod_remittances (
    transport_id, remittance_date, reported_total, calculated_total, row_count,
    status, content_hash, notes, created_by, confirmed_by, confirmed_at,
    analyzed_at, sheet_revision
  ) VALUES (
    v_tr, CURRENT_DATE, 20000, 20000, 1, 'confirmed',
    'fx-diff-part-claim-' || gen_random_uuid()::text,
    'fx partial claim', v_admin, v_admin, now(), now(), 1
  ) RETURNING id INTO v_rem;

  INSERT INTO public.cod_remittance_rows (
    remittance_id, row_index, sheet_revision, raw_line, raw_transport_date_text,
    raw_customer_name_text, raw_amount_text, parsed_transport_date, parsed_amount,
    row_status, matched_order_id, assignment_method, assignment_role,
    expected_amount_snapshot, will_create_irregularity
  ) VALUES (
    v_rem, 0, 1, 'L0', to_char(CURRENT_DATE, 'DD/MM/YYYY'),
    'FX PART CLAIM', '20000', CURRENT_DATE, 20000,
    'confirmed_with_irregularity', v_ord, 'manual', 'primary',
    40000, true
  ) RETURNING id INTO v_row;

  INSERT INTO public.cod_irregularities (
    remittance_row_id, order_id, remittance_id, transport_id,
    order_sent_date_snapshot, remittance_date_snapshot,
    expected_amount, reported_amount, amount_diff, status, created_by
  ) VALUES (
    v_row, v_ord, v_rem, v_tr, CURRENT_DATE, CURRENT_DATE,
    40000, 20000, -20000, 'open', v_admin
  ) RETURNING id INTO v_irreg2;

  INSERT INTO public.cod_remittances (
    transport_id, remittance_date, reported_total, calculated_total, row_count,
    status, content_hash, notes, created_by, analyzed_at, sheet_revision
  ) VALUES (
    v_tr, CURRENT_DATE, 15000, 15000, 1, 'analyzed',
    'fx-diff-part-cred-' || gen_random_uuid()::text,
    'fx partial credit', v_admin, now(), 1
  ) RETURNING id INTO v_rem2;

  INSERT INTO public.cod_remittance_rows (
    remittance_id, row_index, sheet_revision, raw_line, raw_transport_date_text,
    raw_customer_name_text, raw_amount_text, parsed_transport_date, parsed_amount,
    row_status
  ) VALUES (
    v_rem2, 0, 1, 'L0', to_char(CURRENT_DATE, 'DD/MM/YYYY'),
    'FX PART CRED', '15000', CURRENT_DATE, 15000, 'unassigned'
  ) RETURNING id INTO v_row2;

  v_res := public.rpc_cod_register_transport_adjustment(
    v_rem2, v_row2, 'transport_error', 'fx partial credit 15k', NULL, NULL
  );
  v_adj2 := (v_res->>'adjustment_id')::uuid;

  BEGIN
    v_res := public.rpc_cod_compensate_transport_differences(
      v_tr, ARRAY[v_irreg2], ARRAY[v_adj2], NULL, 'fx partial 20k/15k'
    );
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;

  SELECT remaining_amount, status INTO v_rem_amt, v_status
  FROM public.cod_irregularities WHERE id = v_irreg2;
  SELECT remaining_amount, status INTO v_claim_open, v_a54945_after
  FROM public.cod_transport_adjustments WHERE id = v_adj2;

  PERFORM pg_temp.cod_assert(
    '06_partial_20k_15k',
    v_err IS NULL
      AND v_rem_amt = 5000 AND v_status IN ('open', 'in_review')
      AND v_claim_open = 0 AND v_a54945_after = 'compensated',
    format('err=%s claim_rem=%s claim_st=%s adj_rem=%s adj_st=%s',
      v_err, v_rem_amt, v_status, v_claim_open, v_a54945_after)
  );

  -- --- Credit 75495 minus claim 16700 → remaining 58795 partially_compensated ---
  INSERT INTO public.orders (
    id, customer_id, status, payment_method, total_amount, order_number,
    transport_id, sent_at, source
  ) VALUES (
    gen_random_uuid(), v_cust, 'sent', 'Contra Reembolso', 16700,
    'FX-DIFF-' || substr(gen_random_uuid()::text, 1, 12),
    v_tr, now(), 'admin'
  ) RETURNING id INTO v_ord2;

  INSERT INTO public.cod_remittances (
    transport_id, remittance_date, reported_total, calculated_total, row_count,
    status, content_hash, notes, created_by, confirmed_by, confirmed_at,
    analyzed_at, sheet_revision
  ) VALUES (
    v_tr, CURRENT_DATE, 0, 0, 1, 'confirmed',
    'fx-diff-big-claim-' || gen_random_uuid()::text,
    'fx big claim 16700', v_admin, v_admin, now(), now(), 1
  ) RETURNING id INTO v_rem;

  INSERT INTO public.cod_remittance_rows (
    remittance_id, row_index, sheet_revision, raw_line, raw_transport_date_text,
    raw_customer_name_text, raw_amount_text, parsed_transport_date, parsed_amount,
    row_status, matched_order_id, assignment_method, assignment_role,
    expected_amount_snapshot, will_create_irregularity
  ) VALUES (
    v_rem, 0, 1, 'L0', to_char(CURRENT_DATE, 'DD/MM/YYYY'),
    'FX BIG CLAIM', '0', CURRENT_DATE, 0,
    'confirmed_with_irregularity', v_ord2, 'manual', 'primary',
    16700, true
  ) RETURNING id INTO v_row;

  INSERT INTO public.cod_irregularities (
    remittance_row_id, order_id, remittance_id, transport_id,
    order_sent_date_snapshot, remittance_date_snapshot,
    expected_amount, reported_amount, amount_diff, status, created_by
  ) VALUES (
    v_row, v_ord2, v_rem, v_tr, CURRENT_DATE, CURRENT_DATE,
    16700, 0, -16700, 'open', v_admin
  ) RETURNING id INTO v_irreg3;

  -- Reuse the open 75495 adj from case 3 if still open; else create new
  SELECT a.id INTO v_adj3
  FROM public.cod_transport_adjustments a
  WHERE a.transport_id = v_tr
    AND a.original_amount = 75495
    AND a.status IN ('open', 'partially_compensated')
    AND a.remaining_amount > 0.004
  ORDER BY a.created_at
  LIMIT 1;

  IF v_adj3 IS NULL THEN
    INSERT INTO public.cod_remittances (
      transport_id, remittance_date, reported_total, calculated_total, row_count,
      status, content_hash, notes, created_by, analyzed_at, sheet_revision
    ) VALUES (
      v_tr, CURRENT_DATE, 75495, 75495, 1, 'analyzed',
      'fx-diff-big-cred-' || gen_random_uuid()::text,
      'fx big credit', v_admin, now(), 1
    ) RETURNING id INTO v_rem2;

    INSERT INTO public.cod_remittance_rows (
      remittance_id, row_index, sheet_revision, raw_line, raw_transport_date_text,
      raw_customer_name_text, raw_amount_text, parsed_transport_date, parsed_amount,
      row_status
    ) VALUES (
      v_rem2, 0, 1, 'L0', to_char(CURRENT_DATE, 'DD/MM/YYYY'),
      'FX BIG CRED', '75495', CURRENT_DATE, 75495, 'unassigned'
    ) RETURNING id INTO v_row2;

    v_res := public.rpc_cod_register_transport_adjustment(
      v_rem2, v_row2, 'non_applicable_payment', 'fx big credit', NULL, NULL
    );
    v_adj3 := (v_res->>'adjustment_id')::uuid;
  END IF;

  BEGIN
    v_res := public.rpc_cod_compensate_transport_differences(
      v_tr, ARRAY[v_irreg3], ARRAY[v_adj3], NULL, 'fx 75495-16700'
    );
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;

  SELECT remaining_amount, status INTO v_rem_amt, v_status
  FROM public.cod_transport_adjustments WHERE id = v_adj3;
  SELECT remaining_amount, status INTO v_claim_open, v_a54945_after
  FROM public.cod_irregularities WHERE id = v_irreg3;

  PERFORM pg_temp.cod_assert(
    '07_credit_75495_minus_16700',
    v_err IS NULL
      AND v_rem_amt = 58795 AND v_status = 'partially_compensated'
      AND v_claim_open = 0 AND v_a54945_after = 'resolved',
    format('err=%s adj_rem=%s adj_st=%s claim_rem=%s claim_st=%s',
      v_err, v_rem_amt, v_status, v_claim_open, v_a54945_after)
  );

  -- =========================================================================
  -- 8) Multi FIFO: 2 claims + 2 credits
  -- =========================================================================
  INSERT INTO public.orders (
    id, customer_id, status, payment_method, total_amount, order_number,
    transport_id, sent_at, source
  ) VALUES (
    gen_random_uuid(), v_cust, 'sent', 'Contra Reembolso', 10000,
    'FX-DIFF-' || substr(gen_random_uuid()::text, 1, 12), v_tr, now(), 'admin'
  ) RETURNING id INTO v_ord3;

  INSERT INTO public.orders (
    id, customer_id, status, payment_method, total_amount, order_number,
    transport_id, sent_at, source
  ) VALUES (
    gen_random_uuid(), v_cust, 'sent', 'Contra Reembolso', 10000,
    'FX-DIFF-' || substr(gen_random_uuid()::text, 1, 12), v_tr, now(), 'admin'
  ) RETURNING id INTO v_ord4;

  INSERT INTO public.cod_remittances (
    transport_id, remittance_date, reported_total, calculated_total, row_count,
    status, content_hash, notes, created_by, confirmed_by, confirmed_at,
    analyzed_at, sheet_revision
  ) VALUES (
    v_tr, CURRENT_DATE, 0, 0, 2, 'confirmed',
    'fx-diff-fifo-' || gen_random_uuid()::text,
    'fx fifo claims', v_admin, v_admin, now(), now(), 1
  ) RETURNING id INTO v_rem;

  INSERT INTO public.cod_remittance_rows (
    remittance_id, row_index, sheet_revision, raw_line, raw_transport_date_text,
    raw_customer_name_text, raw_amount_text, parsed_transport_date, parsed_amount,
    row_status, matched_order_id, assignment_method, assignment_role,
    expected_amount_snapshot, will_create_irregularity
  ) VALUES
    (v_rem, 0, 1, 'L0', to_char(CURRENT_DATE, 'DD/MM/YYYY'), 'FX FIFO1', '0',
     CURRENT_DATE, 0, 'confirmed_with_irregularity', v_ord3, 'manual', 'primary',
     10000, true),
    (v_rem, 1, 1, 'L1', to_char(CURRENT_DATE, 'DD/MM/YYYY'), 'FX FIFO2', '0',
     CURRENT_DATE, 0, 'confirmed_with_irregularity', v_ord4, 'manual', 'primary',
     10000, true);

  SELECT id INTO v_row FROM public.cod_remittance_rows
  WHERE remittance_id = v_rem AND row_index = 0;
  SELECT id INTO v_row2 FROM public.cod_remittance_rows
  WHERE remittance_id = v_rem AND row_index = 1;

  INSERT INTO public.cod_irregularities (
    remittance_row_id, order_id, remittance_id, transport_id,
    order_sent_date_snapshot, remittance_date_snapshot,
    expected_amount, reported_amount, amount_diff, status, created_by, created_at
  ) VALUES (
    v_row, v_ord3, v_rem, v_tr, CURRENT_DATE, CURRENT_DATE,
    10000, 0, -10000, 'open', v_admin, now() - interval '2 minutes'
  ) RETURNING id INTO v_irreg;

  INSERT INTO public.cod_irregularities (
    remittance_row_id, order_id, remittance_id, transport_id,
    order_sent_date_snapshot, remittance_date_snapshot,
    expected_amount, reported_amount, amount_diff, status, created_by, created_at
  ) VALUES (
    v_row2, v_ord4, v_rem, v_tr, CURRENT_DATE, CURRENT_DATE,
    10000, 0, -10000, 'open', v_admin, now() - interval '1 minute'
  ) RETURNING id INTO v_irreg2;

  INSERT INTO public.cod_remittances (
    transport_id, remittance_date, reported_total, calculated_total, row_count,
    status, content_hash, notes, created_by, analyzed_at, sheet_revision
  ) VALUES (
    v_tr, CURRENT_DATE, 18000, 18000, 2, 'analyzed',
    'fx-diff-fifo-c-' || gen_random_uuid()::text,
    'fx fifo credits', v_admin, now(), 1
  ) RETURNING id INTO v_rem2;

  INSERT INTO public.cod_remittance_rows (
    remittance_id, row_index, sheet_revision, raw_line, raw_transport_date_text,
    raw_customer_name_text, raw_amount_text, parsed_transport_date, parsed_amount,
    row_status
  ) VALUES
    (v_rem2, 0, 1, 'L0', to_char(CURRENT_DATE, 'DD/MM/YYYY'), 'FX FC1', '8000',
     CURRENT_DATE, 8000, 'unassigned'),
    (v_rem2, 1, 1, 'L1', to_char(CURRENT_DATE, 'DD/MM/YYYY'), 'FX FC2', '10000',
     CURRENT_DATE, 10000, 'unassigned');

  SELECT id INTO v_row3 FROM public.cod_remittance_rows
  WHERE remittance_id = v_rem2 AND row_index = 0;
  SELECT id INTO v_row4 FROM public.cod_remittance_rows
  WHERE remittance_id = v_rem2 AND row_index = 1;

  v_res := public.rpc_cod_register_transport_adjustment(
    v_rem2, v_row3, 'other', 'fifo c1', NULL, NULL
  );
  v_adj := (v_res->>'adjustment_id')::uuid;
  -- force older created_at for FIFO
  UPDATE public.cod_transport_adjustments
  SET created_at = now() - interval '2 minutes'
  WHERE id = v_adj;

  v_res := public.rpc_cod_register_transport_adjustment(
    v_rem2, v_row4, 'other', 'fifo c2', NULL, NULL
  );
  v_adj2 := (v_res->>'adjustment_id')::uuid;
  UPDATE public.cod_transport_adjustments
  SET created_at = now() - interval '1 minute'
  WHERE id = v_adj2;

  BEGIN
    v_res := public.rpc_cod_compensate_transport_differences(
      v_tr,
      ARRAY[v_irreg, v_irreg2],
      ARRAY[v_adj, v_adj2],
      NULL,
      'fx fifo 2+2'
    );
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;

  -- FIFO: apply min(20000,18000)=18000 → claim1 resolved, claim2 rem 2000;
  -- credits 8000+10000=18000 → ambos remaining 0 / compensated
  SELECT remaining_amount, status INTO v_rem_amt, v_status
  FROM public.cod_irregularities WHERE id = v_irreg;
  SELECT remaining_amount, status INTO v_claim_open, v_a54945_after
  FROM public.cod_irregularities WHERE id = v_irreg2;
  SELECT remaining_amount INTO v_before_credit
  FROM public.cod_transport_adjustments WHERE id = v_adj;
  SELECT remaining_amount, status INTO v_after_credit, v_pm
  FROM public.cod_transport_adjustments WHERE id = v_adj2;

  PERFORM pg_temp.cod_assert(
    '08_multi_fifo_2_claims_2_credits',
    v_err IS NULL
      AND v_rem_amt = 0 AND v_status = 'resolved'
      AND v_claim_open = 2000 AND v_a54945_after IN ('open', 'in_review')
      AND v_before_credit = 0
      AND v_after_credit = 0 AND v_pm = 'compensated'
      AND (v_res->>'total_applied')::numeric = 18000,
    format(
      'err=%s c1_rem=%s/%s c2_rem=%s/%s adj1_rem=%s adj2_rem=%s/%s applied=%s',
      v_err, v_rem_amt, v_status, v_claim_open, v_a54945_after,
      v_before_credit, v_after_credit, v_pm, v_res->>'total_applied'
    )
  );

  -- =========================================================================
  -- 9) Cross transport reject
  -- =========================================================================
  INSERT INTO public.orders (
    id, customer_id, status, payment_method, total_amount, order_number,
    transport_id, sent_at, source
  ) VALUES (
    gen_random_uuid(), v_cust, 'sent', 'Contra Reembolso', 5000,
    'FX-DIFF-' || substr(gen_random_uuid()::text, 1, 12), v_tr2, now(), 'admin'
  ) RETURNING id INTO v_ord;

  INSERT INTO public.cod_remittances (
    transport_id, remittance_date, reported_total, calculated_total, row_count,
    status, content_hash, notes, created_by, confirmed_by, confirmed_at,
    analyzed_at, sheet_revision
  ) VALUES (
    v_tr2, CURRENT_DATE, 0, 0, 1, 'confirmed',
    'fx-diff-xtr-' || gen_random_uuid()::text,
    'fx cross tr', v_admin, v_admin, now(), now(), 1
  ) RETURNING id INTO v_rem;

  INSERT INTO public.cod_remittance_rows (
    remittance_id, row_index, sheet_revision, raw_line, raw_transport_date_text,
    raw_customer_name_text, raw_amount_text, parsed_transport_date, parsed_amount,
    row_status, matched_order_id, assignment_method, assignment_role,
    expected_amount_snapshot, will_create_irregularity
  ) VALUES (
    v_rem, 0, 1, 'L0', to_char(CURRENT_DATE, 'DD/MM/YYYY'),
    'FX XTR', '0', CURRENT_DATE, 0,
    'confirmed_with_irregularity', v_ord, 'manual', 'primary', 5000, true
  ) RETURNING id INTO v_row;

  INSERT INTO public.cod_irregularities (
    remittance_row_id, order_id, remittance_id, transport_id,
    order_sent_date_snapshot, remittance_date_snapshot,
    expected_amount, reported_amount, amount_diff, status, created_by
  ) VALUES (
    v_row, v_ord, v_rem, v_tr2, CURRENT_DATE, CURRENT_DATE,
    5000, 0, -5000, 'open', v_admin
  ) RETURNING id INTO v_irreg4;

  -- credit on v_tr (reuse any open adj or create tiny)
  SELECT a.id INTO v_adj4
  FROM public.cod_transport_adjustments a
  WHERE a.transport_id = v_tr
    AND a.status IN ('open', 'partially_compensated')
    AND a.remaining_amount > 0.004
  ORDER BY a.created_at DESC
  LIMIT 1;

  IF v_adj4 IS NULL THEN
    INSERT INTO public.cod_remittances (
      transport_id, remittance_date, reported_total, calculated_total, row_count,
      status, content_hash, notes, created_by, analyzed_at, sheet_revision
    ) VALUES (
      v_tr, CURRENT_DATE, 5000, 5000, 1, 'analyzed',
      'fx-diff-xcred-' || gen_random_uuid()::text,
      'fx x credit', v_admin, now(), 1
    ) RETURNING id INTO v_rem2;
    INSERT INTO public.cod_remittance_rows (
      remittance_id, row_index, sheet_revision, raw_line, raw_transport_date_text,
      raw_customer_name_text, raw_amount_text, parsed_transport_date, parsed_amount,
      row_status
    ) VALUES (
      v_rem2, 0, 1, 'L0', to_char(CURRENT_DATE, 'DD/MM/YYYY'),
      'FX XCRED', '5000', CURRENT_DATE, 5000, 'unassigned'
    ) RETURNING id INTO v_row2;
    v_res := public.rpc_cod_register_transport_adjustment(
      v_rem2, v_row2, 'other', 'xcred', NULL, NULL
    );
    v_adj4 := (v_res->>'adjustment_id')::uuid;
  END IF;

  BEGIN
    v_res := public.rpc_cod_compensate_transport_differences(
      v_tr, ARRAY[v_irreg4], ARRAY[v_adj4], NULL, 'fx cross should fail'
    );
    v_err := 'NO_EXCEPTION';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;

  PERFORM pg_temp.cod_assert(
    '09_cross_transport_reject',
    v_err ILIKE '%cross_transport_not_allowed%',
    format('err=%s', v_err)
  );

  -- =========================================================================
  -- 10) Overspend guard (same-session proxy for concurrency):
  --     credit 5000 + claim 5000 → compensate once; second compensate on same
  --     credit must fail credits_remaining_zero (FOR UPDATE + remaining check).
  --     True multi-session concurrency still relies on 298 FOR UPDATE.
  -- =========================================================================
  INSERT INTO public.orders (
    id, customer_id, status, payment_method, total_amount, order_number,
    transport_id, sent_at, source
  ) VALUES (
    gen_random_uuid(), v_cust, 'sent', 'Contra Reembolso', 5000,
    'FX-DIFF-' || substr(gen_random_uuid()::text, 1, 12), v_tr, now(), 'admin'
  ) RETURNING id INTO v_ord;

  INSERT INTO public.orders (
    id, customer_id, status, payment_method, total_amount, order_number,
    transport_id, sent_at, source
  ) VALUES (
    gen_random_uuid(), v_cust, 'sent', 'Contra Reembolso', 5000,
    'FX-DIFF-' || substr(gen_random_uuid()::text, 1, 12), v_tr, now(), 'admin'
  ) RETURNING id INTO v_ord2;

  INSERT INTO public.cod_remittances (
    transport_id, remittance_date, reported_total, calculated_total, row_count,
    status, content_hash, notes, created_by, confirmed_by, confirmed_at,
    analyzed_at, sheet_revision
  ) VALUES (
    v_tr, CURRENT_DATE, 0, 0, 2, 'confirmed',
    'fx-diff-conc-c-' || gen_random_uuid()::text,
    'fx concurrent claims', v_admin, v_admin, now(), now(), 1
  ) RETURNING id INTO v_rem;

  INSERT INTO public.cod_remittance_rows (
    remittance_id, row_index, sheet_revision, raw_line, raw_transport_date_text,
    raw_customer_name_text, raw_amount_text, parsed_transport_date, parsed_amount,
    row_status, matched_order_id, assignment_method, assignment_role,
    expected_amount_snapshot, will_create_irregularity
  ) VALUES
    (v_rem, 0, 1, 'L0', to_char(CURRENT_DATE, 'DD/MM/YYYY'), 'FX CONC1', '0',
     CURRENT_DATE, 0, 'confirmed_with_irregularity', v_ord, 'manual', 'primary',
     5000, true),
    (v_rem, 1, 1, 'L1', to_char(CURRENT_DATE, 'DD/MM/YYYY'), 'FX CONC2', '0',
     CURRENT_DATE, 0, 'confirmed_with_irregularity', v_ord2, 'manual', 'primary',
     5000, true);

  SELECT id INTO v_row FROM public.cod_remittance_rows
  WHERE remittance_id = v_rem AND row_index = 0;
  SELECT id INTO v_row2 FROM public.cod_remittance_rows
  WHERE remittance_id = v_rem AND row_index = 1;

  INSERT INTO public.cod_irregularities (
    remittance_row_id, order_id, remittance_id, transport_id,
    order_sent_date_snapshot, remittance_date_snapshot,
    expected_amount, reported_amount, amount_diff, status, created_by
  ) VALUES (
    v_row, v_ord, v_rem, v_tr, CURRENT_DATE, CURRENT_DATE,
    5000, 0, -5000, 'open', v_admin
  ) RETURNING id INTO v_irreg;

  INSERT INTO public.cod_irregularities (
    remittance_row_id, order_id, remittance_id, transport_id,
    order_sent_date_snapshot, remittance_date_snapshot,
    expected_amount, reported_amount, amount_diff, status, created_by
  ) VALUES (
    v_row2, v_ord2, v_rem, v_tr, CURRENT_DATE, CURRENT_DATE,
    5000, 0, -5000, 'open', v_admin
  ) RETURNING id INTO v_irreg2;

  INSERT INTO public.cod_remittances (
    transport_id, remittance_date, reported_total, calculated_total, row_count,
    status, content_hash, notes, created_by, analyzed_at, sheet_revision
  ) VALUES (
    v_tr, CURRENT_DATE, 5000, 5000, 1, 'analyzed',
    'fx-diff-conc-a-' || gen_random_uuid()::text,
    'fx concurrent credit', v_admin, now(), 1
  ) RETURNING id INTO v_rem2;

  INSERT INTO public.cod_remittance_rows (
    remittance_id, row_index, sheet_revision, raw_line, raw_transport_date_text,
    raw_customer_name_text, raw_amount_text, parsed_transport_date, parsed_amount,
    row_status
  ) VALUES (
    v_rem2, 0, 1, 'L0', to_char(CURRENT_DATE, 'DD/MM/YYYY'),
    'FX CONC CRED', '5000', CURRENT_DATE, 5000, 'unassigned'
  ) RETURNING id INTO v_row3;

  v_res := public.rpc_cod_register_transport_adjustment(
    v_rem2, v_row3, 'other', 'conc credit', NULL, NULL
  );
  v_adj := (v_res->>'adjustment_id')::uuid;

  BEGIN
    v_res := public.rpc_cod_compensate_transport_differences(
      v_tr, ARRAY[v_irreg], ARRAY[v_adj], NULL, 'fx conc first'
    );
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;

  BEGIN
    PERFORM public.rpc_cod_compensate_transport_differences(
      v_tr, ARRAY[v_irreg2], ARRAY[v_adj], NULL, 'fx conc second overspend'
    );
    v_a54945_after := 'NO_EXCEPTION';
  EXCEPTION WHEN OTHERS THEN
    v_a54945_after := SQLERRM;
  END;

  SELECT remaining_amount INTO v_after_credit
  FROM public.cod_transport_adjustments WHERE id = v_adj;
  SELECT remaining_amount INTO v_claim_open
  FROM public.cod_irregularities WHERE id = v_irreg2;

  PERFORM pg_temp.cod_assert(
    '10_overspend_second_compensate',
    v_err IS NULL
      AND v_after_credit = 0
      AND v_claim_open = 5000
      AND (
        v_a54945_after ILIKE '%credits_remaining_zero%'
        OR v_a54945_after ILIKE '%credit_adjustment_not_active%'
      ),
    format(
      'first_err=%s second_err=%s credit_rem=%s claim2_rem=%s (proxy; multi-session uses FOR UPDATE in 298)',
      v_err, v_a54945_after, v_after_credit, v_claim_open
    )
  );

  -- =========================================================================
  -- 11) Void unused OK; void used → adjustment_has_compensations
  -- =========================================================================
  INSERT INTO public.cod_remittances (
    transport_id, remittance_date, reported_total, calculated_total, row_count,
    status, content_hash, notes, created_by, analyzed_at, sheet_revision
  ) VALUES (
    v_tr, CURRENT_DATE, 3333, 3333, 1, 'analyzed',
    'fx-diff-void-ok-' || gen_random_uuid()::text,
    'fx void unused', v_admin, now(), 1
  ) RETURNING id INTO v_rem;

  INSERT INTO public.cod_remittance_rows (
    remittance_id, row_index, sheet_revision, raw_line, raw_transport_date_text,
    raw_customer_name_text, raw_amount_text, parsed_transport_date, parsed_amount,
    row_status
  ) VALUES (
    v_rem, 0, 1, 'L0', to_char(CURRENT_DATE, 'DD/MM/YYYY'),
    'FX VOID OK', '3333', CURRENT_DATE, 3333, 'unassigned'
  ) RETURNING id INTO v_row;

  v_res := public.rpc_cod_register_transport_adjustment(
    v_rem, v_row, 'other', 'void unused target', NULL, NULL
  );
  v_adj_void := (v_res->>'adjustment_id')::uuid;

  BEGIN
    v_res := public.rpc_cod_void_transport_adjustment(v_adj_void, 'fx void unused');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;

  SELECT status, row_status INTO v_status, v_a54945_after
  FROM public.cod_transport_adjustments a
  JOIN public.cod_remittance_rows r ON r.id = a.remittance_row_id
  WHERE a.id = v_adj_void;

  PERFORM pg_temp.cod_assert(
    '11_void_unused_ok',
    v_err IS NULL AND v_status = 'voided' AND v_a54945_after = 'unassigned',
    format('err=%s adj_st=%s row_st=%s', v_err, v_status, v_a54945_after)
  );

  -- used adj: pick one already compensated / partially_compensated
  SELECT a.id INTO v_adj_used
  FROM public.cod_transport_adjustments a
  WHERE a.transport_id = v_tr
    AND a.status IN ('compensated', 'partially_compensated')
  ORDER BY a.updated_at DESC
  LIMIT 1;

  IF v_adj_used IS NULL THEN
    PERFORM pg_temp.cod_assert(
      '11_void_used_reject',
      false,
      'no compensated adjustment available to test void reject'
    );
  ELSE
    BEGIN
      v_res := public.rpc_cod_void_transport_adjustment(v_adj_used, 'should fail');
      v_err := 'NO_EXCEPTION';
    EXCEPTION WHEN OTHERS THEN
      v_err := SQLERRM;
    END;

    PERFORM pg_temp.cod_assert(
      '11_void_used_reject',
      v_err ILIKE '%adjustment_has_compensations%',
      format('err=%s adj=%s', v_err, v_adj_used)
    );
  END IF;

  -- =========================================================================
  -- 12) Void remittance unused OK; compensated → remittance_has_compensated_adjustments
  -- =========================================================================
  INSERT INTO public.cod_remittances (
    transport_id, remittance_date, reported_total, calculated_total, row_count,
    status, content_hash, notes, created_by, confirmed_by, confirmed_at,
    analyzed_at, sheet_revision
  ) VALUES (
    v_tr, CURRENT_DATE, 4444, 4444, 1, 'confirmed',
    'fx-diff-void-rem-' || gen_random_uuid()::text,
    'fx void rem unused', v_admin, v_admin, now(), now(), 1
  ) RETURNING id INTO v_rem_void;

  INSERT INTO public.cod_remittance_rows (
    remittance_id, row_index, sheet_revision, raw_line, raw_transport_date_text,
    raw_customer_name_text, raw_amount_text, parsed_transport_date, parsed_amount,
    row_status
  ) VALUES (
    v_rem_void, 0, 1, 'L0', to_char(CURRENT_DATE, 'DD/MM/YYYY'),
    'FX VOID REM', '4444', CURRENT_DATE, 4444, 'unassigned'
  ) RETURNING id INTO v_row_void;

  -- register requires analyzed|confirmed — rem is confirmed OK
  v_res := public.rpc_cod_register_transport_adjustment(
    v_rem_void, v_row_void, 'other', 'void rem unused adj', NULL, NULL
  );
  v_adj := (v_res->>'adjustment_id')::uuid;

  BEGIN
    v_res := public.rpc_cod_void_confirmed_remittance(v_rem_void, 'fx void rem unused path');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    v_res := NULL;
  END;

  SELECT status INTO v_status FROM public.cod_remittances WHERE id = v_rem_void;
  SELECT status INTO v_a54945_after FROM public.cod_transport_adjustments WHERE id = v_adj;

  PERFORM pg_temp.cod_assert(
    '12_void_remittance_unused_ok',
    v_err IS NULL
      AND v_status = 'voided'
      AND v_a54945_after = 'voided',
    format('err=%s rem_st=%s adj_st=%s res=%s',
      v_err, v_status, v_a54945_after, left(COALESCE(v_res::text, 'null'), 100))
  );

  -- compensated remittance block
  INSERT INTO public.cod_remittances (
    transport_id, remittance_date, reported_total, calculated_total, row_count,
    status, content_hash, notes, created_by, confirmed_by, confirmed_at,
    analyzed_at, sheet_revision
  ) VALUES (
    v_tr, CURRENT_DATE, 5555, 5555, 1, 'confirmed',
    'fx-diff-void-rem-used-' || gen_random_uuid()::text,
    'fx void rem used', v_admin, v_admin, now(), now(), 1
  ) RETURNING id INTO v_rem_void2;

  INSERT INTO public.cod_remittance_rows (
    remittance_id, row_index, sheet_revision, raw_line, raw_transport_date_text,
    raw_customer_name_text, raw_amount_text, parsed_transport_date, parsed_amount,
    row_status
  ) VALUES (
    v_rem_void2, 0, 1, 'L0', to_char(CURRENT_DATE, 'DD/MM/YYYY'),
    'FX VOID REM USED', '5555', CURRENT_DATE, 5555, 'unassigned'
  ) RETURNING id INTO v_row_void2;

  v_res := public.rpc_cod_register_transport_adjustment(
    v_rem_void2, v_row_void2, 'other', 'will mark compensated', NULL, NULL
  );
  v_adj := (v_res->>'adjustment_id')::uuid;

  -- Simulate compensation usage without full compensate (remaining < original)
  UPDATE public.cod_transport_adjustments
  SET remaining_amount = 1000,
      status = 'partially_compensated',
      updated_at = now()
  WHERE id = v_adj;

  BEGIN
    v_res := public.rpc_cod_void_confirmed_remittance(v_rem_void2, 'should block');
    v_err := 'NO_EXCEPTION';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;

  PERFORM pg_temp.cod_assert(
    '12_void_remittance_compensated_reject',
    v_err ILIKE '%remittance_has_compensated_adjustments%',
    format('err=%s', v_err)
  );

  -- =========================================================================
  -- 13) Complementary regression: trigger-level (resolve → rem 0, no adj)
  --     Optional approve+confirm if RPCs exist on synthetic primary+shortage
  -- =========================================================================
  INSERT INTO public.orders (
    id, customer_id, status, payment_method, total_amount, order_number,
    transport_id, sent_at, source
  ) VALUES (
    gen_random_uuid(), v_cust, 'sent', 'Contra Reembolso', 160700,
    'FX-DIFF-' || substr(gen_random_uuid()::text, 1, 12), v_tr, now(), 'admin'
  ) RETURNING id INTO v_ord;

  INSERT INTO public.cod_remittances (
    transport_id, remittance_date, reported_total, calculated_total, row_count,
    status, content_hash, notes, created_by, confirmed_by, confirmed_at,
    analyzed_at, sheet_revision
  ) VALUES (
    v_tr, CURRENT_DATE, 144000, 144000, 1, 'confirmed',
    'fx-diff-comp-reg-' || gen_random_uuid()::text,
    'fx complementary regression primary', v_admin, v_admin, now(), now(), 1
  ) RETURNING id INTO v_rem;

  INSERT INTO public.cod_remittance_rows (
    remittance_id, row_index, sheet_revision, raw_line, raw_transport_date_text,
    raw_customer_name_text, raw_amount_text, parsed_transport_date, parsed_amount,
    row_status, matched_order_id, assignment_method, assignment_role,
    expected_amount_snapshot, will_create_irregularity
  ) VALUES (
    v_rem, 0, 1, 'L0', to_char(CURRENT_DATE, 'DD/MM/YYYY'),
    'FX COMP REG', '144000', CURRENT_DATE, 144000,
    'confirmed_with_irregularity', v_ord, 'manual', 'primary',
    160700, true
  ) RETURNING id INTO v_row;

  INSERT INTO public.cod_irregularities (
    remittance_row_id, order_id, remittance_id, transport_id,
    order_sent_date_snapshot, remittance_date_snapshot,
    expected_amount, reported_amount, amount_diff, status, created_by
  ) VALUES (
    v_row, v_ord, v_rem, v_tr, CURRENT_DATE, CURRENT_DATE,
    160700, 144000, -16700, 'open', v_admin
  ) RETURNING id INTO v_irreg;

  IF to_regprocedure('public.rpc_cod_approve_complementary_payment(uuid,uuid,uuid,text)') IS NOT NULL
     AND to_regprocedure('public.rpc_cod_confirm_remittance(uuid)') IS NOT NULL THEN
    INSERT INTO public.cod_remittances (
      transport_id, remittance_date, reported_total, calculated_total, row_count,
      status, content_hash, notes, created_by, analyzed_at, sheet_revision
    ) VALUES (
      v_tr, CURRENT_DATE, 16700, 16700, 1, 'analyzed',
      'fx-diff-comp-supp-' || gen_random_uuid()::text,
      'fx complementary regression supp', v_admin, now(), 1
    ) RETURNING id INTO v_rem2;

    INSERT INTO public.cod_remittance_rows (
      remittance_id, row_index, sheet_revision, raw_line, raw_transport_date_text,
      raw_customer_name_text, raw_amount_text, parsed_transport_date, parsed_amount,
      row_status
    ) VALUES (
      v_rem2, 0, 1, 'L0', to_char(CURRENT_DATE, 'DD/MM/YYYY'),
      'FX COMP REG', '16700', CURRENT_DATE, 16700, 'unassigned'
    ) RETURNING id INTO v_row2;

    BEGIN
      v_res := public.rpc_cod_approve_complementary_payment(
        v_rem2, v_row2, v_ord, 'fx audit exact complementary'
      );
      v_res := public.rpc_cod_confirm_remittance(v_rem2);
      v_err := NULL;
    EXCEPTION WHEN OTHERS THEN
      v_err := SQLERRM;
      v_res := NULL;
    END;

    SELECT remaining_amount, status INTO v_rem_amt, v_status
    FROM public.cod_irregularities WHERE id = v_irreg;

    SELECT count(*) INTO v_cnt
    FROM public.cod_transport_adjustments a
    WHERE a.remittance_row_id IN (v_row, v_row2);

    PERFORM pg_temp.cod_assert(
      '13_complementary_regression',
      v_err IS NULL
        AND v_status = 'resolved'
        AND v_rem_amt = 0
        AND v_cnt = 0,
      format('err=%s status=%s rem=%s adj_count=%s (approve+confirm path)',
        v_err, v_status, v_rem_amt, v_cnt)
    );
  ELSE
    UPDATE public.cod_irregularities
    SET status = 'resolved',
        resolved_by = v_admin,
        resolved_at = now(),
        resolution_note = 'Saldo completado por pago complementario (simulated)',
        updated_at = now()
    WHERE id = v_irreg
    RETURNING remaining_amount INTO v_rem_amt;

    SELECT count(*) INTO v_cnt
    FROM public.cod_transport_adjustments a
    WHERE a.remittance_row_id = v_row;

    PERFORM pg_temp.cod_assert(
      '13_complementary_regression',
      v_rem_amt = 0 AND v_cnt = 0,
      format('trigger-level: rem=%s adj_count=%s (approve RPC missing)', v_rem_amt, v_cnt)
    );
  END IF;

  -- =========================================================================
  -- 14) Positive irreg amount_diff>0 appears as credit in balance view
  -- =========================================================================
  INSERT INTO public.orders (
    id, customer_id, status, payment_method, total_amount, order_number,
    transport_id, sent_at, source
  ) VALUES (
    gen_random_uuid(), v_cust, 'sent', 'Contra Reembolso', 10000,
    'FX-DIFF-' || substr(gen_random_uuid()::text, 1, 12), v_tr, now(), 'admin'
  ) RETURNING id INTO v_ord;

  INSERT INTO public.cod_remittances (
    transport_id, remittance_date, reported_total, calculated_total, row_count,
    status, content_hash, notes, created_by, confirmed_by, confirmed_at,
    analyzed_at, sheet_revision
  ) VALUES (
    v_tr, CURRENT_DATE, 15000, 15000, 1, 'confirmed',
    'fx-diff-pos-' || gen_random_uuid()::text,
    'fx positive irreg', v_admin, v_admin, now(), now(), 1
  ) RETURNING id INTO v_rem;

  INSERT INTO public.cod_remittance_rows (
    remittance_id, row_index, sheet_revision, raw_line, raw_transport_date_text,
    raw_customer_name_text, raw_amount_text, parsed_transport_date, parsed_amount,
    row_status, matched_order_id, assignment_method, assignment_role,
    expected_amount_snapshot, will_create_irregularity
  ) VALUES (
    v_rem, 0, 1, 'L0', to_char(CURRENT_DATE, 'DD/MM/YYYY'),
    'FX POS', '15000', CURRENT_DATE, 15000,
    'confirmed_with_irregularity', v_ord, 'manual', 'primary',
    10000, true
  ) RETURNING id INTO v_row;

  INSERT INTO public.cod_irregularities (
    remittance_row_id, order_id, remittance_id, transport_id,
    order_sent_date_snapshot, remittance_date_snapshot,
    expected_amount, reported_amount, amount_diff, status, created_by
  ) VALUES (
    v_row, v_ord, v_rem, v_tr, CURRENT_DATE, CURRENT_DATE,
    10000, 15000, 5000, 'open', v_admin
  ) RETURNING id, remaining_amount INTO v_irreg_pos, v_rem_amt;

  SELECT COALESCE(b.credit_open, 0) INTO v_credit_open
  FROM public.cod_v_transport_difference_balances b
  WHERE b.transport_id = v_tr;

  PERFORM pg_temp.cod_assert(
    '14_positive_irreg_as_credit',
    v_rem_amt = 5000 AND COALESCE(v_credit_open, 0) >= 5000,
    format('irreg_rem=%s view_credit_open=%s', v_rem_amt, v_credit_open)
  );

  -- =========================================================================
  -- 15) Balance view after
  -- =========================================================================
  SELECT COALESCE(b.claim_open, 0), COALESCE(b.credit_open, 0), COALESCE(b.net_balance, 0)
  INTO v_after_claim, v_after_credit, v_after_net
  FROM public.cod_v_transport_difference_balances b
  WHERE b.transport_id = v_tr;

  PERFORM pg_temp.cod_assert(
    '15_balance_after',
    v_after_net = round(v_after_claim - v_after_credit, 2),
    format('claim=%s credit=%s net=%s (before claim=%s credit=%s net=%s)',
      v_after_claim, v_after_credit, v_after_net,
      v_before_claim, v_before_credit, v_before_net)
  );

  -- =========================================================================
  -- 16) Atomicity: bad id mid-path → no partial compensation rows
  -- =========================================================================
  SELECT count(*) INTO v_comp_before
  FROM public.cod_transport_compensations WHERE transport_id = v_tr;
  SELECT count(*) INTO v_lines_before
  FROM public.cod_transport_compensation_lines l
  JOIN public.cod_transport_compensations c ON c.id = l.compensation_id
  WHERE c.transport_id = v_tr;

  -- Open claim on v_tr + credit uuid that does not exist → fails before apply
  SELECT i.id INTO v_irreg
  FROM public.cod_irregularities i
  WHERE i.transport_id = v_tr
    AND i.status IN ('open', 'in_review')
    AND i.amount_diff < -0.004
    AND i.remaining_amount > 0.004
  ORDER BY i.created_at DESC
  LIMIT 1;

  IF v_irreg IS NULL THEN
    PERFORM pg_temp.cod_assert(
      '16_atomicity_bad_id',
      false,
      'no open claim left to drive atomicity probe'
    );
  ELSE
    BEGIN
      v_res := public.rpc_cod_compensate_transport_differences(
        v_tr,
        ARRAY[v_irreg],
        ARRAY[gen_random_uuid()],  -- bad credit id
        NULL,
        'fx atomicity'
      );
      v_err := 'NO_EXCEPTION';
    EXCEPTION WHEN OTHERS THEN
      v_err := SQLERRM;
    END;

    SELECT count(*) INTO v_comp_after
    FROM public.cod_transport_compensations WHERE transport_id = v_tr;
    SELECT count(*) INTO v_lines_after
    FROM public.cod_transport_compensation_lines l
    JOIN public.cod_transport_compensations c ON c.id = l.compensation_id
    WHERE c.transport_id = v_tr;

    PERFORM pg_temp.cod_assert(
      '16_atomicity_bad_id',
      v_err IS DISTINCT FROM 'NO_EXCEPTION'
        AND v_comp_after = v_comp_before
        AND v_lines_after = v_lines_before,
      format('err=%s comps %s→%s lines %s→%s',
        v_err, v_comp_before, v_comp_after, v_lines_before, v_lines_after)
    );
  END IF;

  -- Cross-transport also must not leave partials (fresh pair; no stale ids)
  INSERT INTO public.orders (
    id, customer_id, status, payment_method, total_amount, order_number,
    transport_id, sent_at, source
  ) VALUES (
    gen_random_uuid(), v_cust, 'sent', 'Contra Reembolso', 4000,
    'FX-DIFF-' || substr(gen_random_uuid()::text, 1, 12), v_tr2, now(), 'admin'
  ) RETURNING id INTO v_ord;

  INSERT INTO public.cod_remittances (
    transport_id, remittance_date, reported_total, calculated_total, row_count,
    status, content_hash, notes, created_by, confirmed_by, confirmed_at,
    analyzed_at, sheet_revision
  ) VALUES (
    v_tr2, CURRENT_DATE, 0, 0, 1, 'confirmed',
    'fx-diff-atom-x-' || gen_random_uuid()::text,
    'fx atom cross claim', v_admin, v_admin, now(), now(), 1
  ) RETURNING id INTO v_rem;

  INSERT INTO public.cod_remittance_rows (
    remittance_id, row_index, sheet_revision, raw_line, raw_transport_date_text,
    raw_customer_name_text, raw_amount_text, parsed_transport_date, parsed_amount,
    row_status, matched_order_id, assignment_method, assignment_role,
    expected_amount_snapshot, will_create_irregularity
  ) VALUES (
    v_rem, 0, 1, 'L0', to_char(CURRENT_DATE, 'DD/MM/YYYY'),
    'FX ATOM X', '0', CURRENT_DATE, 0,
    'confirmed_with_irregularity', v_ord, 'manual', 'primary', 4000, true
  ) RETURNING id INTO v_row;

  INSERT INTO public.cod_irregularities (
    remittance_row_id, order_id, remittance_id, transport_id,
    order_sent_date_snapshot, remittance_date_snapshot,
    expected_amount, reported_amount, amount_diff, status, created_by
  ) VALUES (
    v_row, v_ord, v_rem, v_tr2, CURRENT_DATE, CURRENT_DATE,
    4000, 0, -4000, 'open', v_admin
  ) RETURNING id INTO v_irreg4;

  SELECT a.id INTO v_adj4
  FROM public.cod_transport_adjustments a
  WHERE a.transport_id = v_tr
    AND a.status IN ('open', 'partially_compensated')
    AND a.remaining_amount > 0.004
  ORDER BY a.created_at DESC
  LIMIT 1;

  SELECT count(*) INTO v_comp_before
  FROM public.cod_transport_compensations WHERE transport_id = v_tr;
  SELECT count(*) INTO v_lines_before
  FROM public.cod_transport_compensation_lines l
  JOIN public.cod_transport_compensations c ON c.id = l.compensation_id
  WHERE c.transport_id = v_tr;

  BEGIN
    v_res := public.rpc_cod_compensate_transport_differences(
      v_tr, ARRAY[v_irreg4], ARRAY[v_adj4], NULL, 'fx atomicity cross'
    );
    v_err := 'NO_EXCEPTION';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;

  SELECT count(*) INTO v_comp_after
  FROM public.cod_transport_compensations WHERE transport_id = v_tr;
  SELECT count(*) INTO v_lines_after
  FROM public.cod_transport_compensation_lines l
  JOIN public.cod_transport_compensations c ON c.id = l.compensation_id
  WHERE c.transport_id = v_tr;

  PERFORM pg_temp.cod_assert(
    '16_atomicity_cross_no_partial',
    v_err ILIKE '%cross_transport_not_allowed%'
      AND v_comp_after = v_comp_before
      AND v_lines_after = v_lines_before,
    format('err=%s comps %s→%s lines %s→%s',
      v_err, v_comp_before, v_comp_after, v_lines_before, v_lines_after)
  );

  -- =========================================================================
  -- Final safety: A54945 / MAIRA untouched
  -- =========================================================================
  SELECT o.payment_method, o.total_amount, o.status
  INTO v_pm, v_diff, v_a54945_after
  FROM public.orders o
  WHERE o.order_number = 'A54945'
  LIMIT 1;

  PERFORM pg_temp.cod_assert(
    '17_a54945_untouched',
    v_pm IS NOT DISTINCT FROM v_a54945_pm
      AND v_diff IS NOT DISTINCT FROM v_a54945_total
      AND v_a54945_after IS NOT DISTINCT FROM v_a54945_before,
    format('before pm=%s total=%s st=%s | after pm=%s total=%s st=%s',
      v_a54945_pm, v_a54945_total, v_a54945_before, v_pm, v_diff, v_a54945_after)
  );

  PERFORM pg_temp.cod_assert(
    '17_no_fixture_named_maira',
    NOT EXISTS (
      SELECT 1 FROM public.customers
      WHERE id = v_cust AND full_name ILIKE '%MAIRA%'
    ),
    'fixture customer still not MAIRA'
  );

  PERFORM pg_temp.cod_assert(
    '18_ready_for_rollback',
    true,
    'all synthetic rows live only until ROLLBACK'
  );
END;
$cases$;

-- 17) Final SELECT of results
SELECT case_id, ok, detail
FROM _cod_diff_audit_results
ORDER BY case_id;

-- 18) ROLLBACK — nothing left applied
ROLLBACK;
