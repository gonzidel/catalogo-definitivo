BEGIN;
-- >>> 295_cod_transport_differences_schema.sql
-- 295_cod_transport_differences_schema.sql
--
-- Diferencias del transporte V1 (repo only â€” NO APPLY hasta aprobaciÃ³n).
--
-- 1) remaining_amount en cod_irregularities (amount_diff histÃ³rico intacto)
-- 2) row_status classified_adjustment
-- 3) cod_transport_adjustments (crÃ©ditos a favor del transporte)
-- 4) trigger: remaining en INSERT; remaining=0 al pasar a resolved/superseded
--
-- Criterio amount_diff > 0 (sobrantes COD):
--   Participan como "A favor del transporte" vÃ­a remaining_amount.
--   NO se duplican en cod_transport_adjustments.
--
-- Complementary 292â€“294:
--   No se modifica 294 aquÃ­. La coherencia remaining=0 al resolver/supersede
--   la garantiza el trigger. INSERT de nueva faltante parcial toma remaining vÃ­a trigger.
--   Documentado en 299 / nota Obsidian 53.

-- =============================================================================
-- 1) remaining_amount en irregularities
-- =============================================================================

ALTER TABLE public.cod_irregularities
  ADD COLUMN IF NOT EXISTS remaining_amount numeric(12,2);

UPDATE public.cod_irregularities
SET remaining_amount = CASE
  WHEN status IN ('open', 'in_review') THEN abs(amount_diff)
  ELSE 0
END
WHERE remaining_amount IS NULL;

ALTER TABLE public.cod_irregularities
  ALTER COLUMN remaining_amount SET NOT NULL;

ALTER TABLE public.cod_irregularities
  DROP CONSTRAINT IF EXISTS cod_irregularities_remaining_amount_nonneg;

ALTER TABLE public.cod_irregularities
  ADD CONSTRAINT cod_irregularities_remaining_amount_nonneg
  CHECK (remaining_amount >= 0);

ALTER TABLE public.cod_irregularities
  DROP CONSTRAINT IF EXISTS cod_irregularities_remaining_lte_abs_diff;

ALTER TABLE public.cod_irregularities
  ADD CONSTRAINT cod_irregularities_remaining_lte_abs_diff
  CHECK (remaining_amount <= abs(amount_diff) + 0.005);

-- resolved implica remaining = 0 (write-off o compensaciÃ³n). Sin excepciones V1.
ALTER TABLE public.cod_irregularities
  DROP CONSTRAINT IF EXISTS cod_irregularities_resolved_remaining_zero;

ALTER TABLE public.cod_irregularities
  ADD CONSTRAINT cod_irregularities_resolved_remaining_zero
  CHECK (status <> 'resolved' OR remaining_amount <= 0.005);

COMMENT ON COLUMN public.cod_irregularities.remaining_amount IS
  'Saldo operativo pendiente de compensar/cerrar. amount_diff permanece histÃ³rico. '
  'Al pasar a resolved/superseded el trigger fuerza 0. '
  'resolved vÃ­a 285 = write-off del remaining; vÃ­a compensaciÃ³n = neteo con crÃ©dito transporte.';

CREATE INDEX IF NOT EXISTS idx_cod_irregularities_transport_remaining
  ON public.cod_irregularities (transport_id, status)
  WHERE remaining_amount > 0.005;

-- Trigger: default remaining en INSERT; zero al cerrar
CREATE OR REPLACE FUNCTION public._cod_irregularity_remaining_sync()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog'
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.remaining_amount IS NULL THEN
      NEW.remaining_amount := CASE
        WHEN NEW.status IN ('open', 'in_review') THEN abs(NEW.amount_diff)
        ELSE 0
      END;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: al pasar a resolved/superseded, remaining = 0
  IF NEW.status IN ('resolved', 'superseded')
     AND OLD.status IS DISTINCT FROM NEW.status THEN
    NEW.remaining_amount := 0;
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_cod_irregularity_remaining_sync ON public.cod_irregularities;
CREATE TRIGGER trg_cod_irregularity_remaining_sync
  BEFORE INSERT OR UPDATE OF status, amount_diff, remaining_amount
  ON public.cod_irregularities
  FOR EACH ROW
  EXECUTE FUNCTION public._cod_irregularity_remaining_sync();

-- =============================================================================
-- 2) row_status: classified_adjustment
-- =============================================================================

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'cod_remittance_rows'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%row_status%'
  LOOP
    EXECUTE format('ALTER TABLE public.cod_remittance_rows DROP CONSTRAINT %I', r.conname);
  END LOOP;

  ALTER TABLE public.cod_remittance_rows
    ADD CONSTRAINT cod_remittance_rows_row_status_check
    CHECK (row_status IN (
      'pending_analysis',
      'auto_matched',
      'needs_review',
      'approved_pending_confirmation',
      'confirmed_matched',
      'confirmed_with_irregularity',
      'unassigned',
      'classified_adjustment',
      'void'
    ));
END $$;

COMMENT ON CONSTRAINT cod_remittance_rows_row_status_check
  ON public.cod_remittance_rows IS
  '295 agrega classified_adjustment: fila clasificada como diferencia/crÃ©dito transporte (no es pago COD).';

-- =============================================================================
-- 3) cod_transport_adjustments
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.cod_transport_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transport_id uuid NOT NULL REFERENCES public.transports(id) ON DELETE RESTRICT,

  -- V1: RPC solo permite transport_credit. Columna admite debt para futuro.
  direction text NOT NULL DEFAULT 'transport_credit'
    CHECK (direction IN ('transport_credit', 'transport_debt')),

  kind text NOT NULL
    CHECK (kind IN (
      'paid_other_method',
      'non_applicable_payment',
      'order_not_found',
      'foreign_client',
      'transport_error',
      'other'
    )),

  original_amount numeric(12,2) NOT NULL
    CHECK (original_amount > 0),
  remaining_amount numeric(12,2) NOT NULL
    CHECK (remaining_amount >= 0),

  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'partially_compensated', 'compensated', 'voided')),

  remittance_id uuid NOT NULL REFERENCES public.cod_remittances(id) ON DELETE RESTRICT,
  remittance_row_id uuid NOT NULL REFERENCES public.cod_remittance_rows(id) ON DELETE RESTRICT,

  order_id uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,

  raw_name_snapshot text,
  remittance_date_snapshot date,
  reported_amount_snapshot numeric(12,2),
  observation text,

  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  voided_by uuid REFERENCES auth.users(id),
  voided_at timestamptz,
  void_reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT cod_transport_adjustments_remaining_lte_original
    CHECK (remaining_amount <= original_amount + 0.005)
);

COMMENT ON TABLE public.cod_transport_adjustments IS
  'V1: crÃ©ditos a favor del transporte que NO son COD esperado. '
  'Deuda (faltantes) vive en cod_irregularities. No duplicar.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_cod_transport_adjustments_row_active
  ON public.cod_transport_adjustments (remittance_row_id)
  WHERE status <> 'voided';

CREATE INDEX IF NOT EXISTS idx_cod_transport_adjustments_transport_status
  ON public.cod_transport_adjustments (transport_id, status);

CREATE INDEX IF NOT EXISTS idx_cod_transport_adjustments_remittance
  ON public.cod_transport_adjustments (remittance_id);

CREATE INDEX IF NOT EXISTS idx_cod_transport_adjustments_remaining
  ON public.cod_transport_adjustments (transport_id)
  WHERE remaining_amount > 0.005 AND status IN ('open', 'partially_compensated');

-- RLS: SELECT con view; DML solo RPC
ALTER TABLE public.cod_transport_adjustments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cod_transport_adjustments_select ON public.cod_transport_adjustments;
CREATE POLICY cod_transport_adjustments_select
  ON public.cod_transport_adjustments
  FOR SELECT
  TO authenticated
  USING (public.has_permission(auth.uid(), 'conciliacion-reembolso', 'view'));

REVOKE ALL ON TABLE public.cod_transport_adjustments FROM PUBLIC;
REVOKE ALL ON TABLE public.cod_transport_adjustments FROM anon;
GRANT SELECT ON TABLE public.cod_transport_adjustments TO authenticated;
GRANT ALL ON TABLE public.cod_transport_adjustments TO service_role;

SELECT pg_notify('pgrst', 'reload schema');

-- >>> 296_cod_transport_compensations_schema.sql
-- 296_cod_transport_compensations_schema.sql
--
-- Compensaciones entre:
--   claims  = irregularities (amount_diff < 0) con remaining > 0
--   credits = adjustments (transport_credit) + irregularities amount_diff > 0
--
-- No muta amount_diff / original_amount. Solo remaining + status + auditorÃ­a.
-- NO APPLY hasta aprobaciÃ³n.

CREATE TABLE IF NOT EXISTS public.cod_transport_compensations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transport_id uuid NOT NULL REFERENCES public.transports(id) ON DELETE RESTRICT,
  total_applied numeric(12,2) NOT NULL CHECK (total_applied > 0),
  note text,
  status text NOT NULL DEFAULT 'applied'
    CHECK (status IN ('applied', 'voided')),
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  voided_by uuid REFERENCES auth.users(id),
  voided_at timestamptz,
  void_reason text
);

CREATE TABLE IF NOT EXISTS public.cod_transport_compensation_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  compensation_id uuid NOT NULL
    REFERENCES public.cod_transport_compensations(id) ON DELETE RESTRICT,
  side text NOT NULL CHECK (side IN ('claim', 'credit')),
  source_type text NOT NULL CHECK (source_type IN ('irregularity', 'adjustment')),
  source_id uuid NOT NULL,
  amount_applied numeric(12,2) NOT NULL CHECK (amount_applied > 0),
  remaining_before numeric(12,2) NOT NULL,
  remaining_after numeric(12,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cod_transport_compensations_transport
  ON public.cod_transport_compensations (transport_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cod_transport_compensation_lines_comp
  ON public.cod_transport_compensation_lines (compensation_id);

CREATE INDEX IF NOT EXISTS idx_cod_transport_compensation_lines_source
  ON public.cod_transport_compensation_lines (source_type, source_id);

COMMENT ON TABLE public.cod_transport_compensations IS
  'Neteo auditable claimâ†”credit del mismo transporte. No implica que el transporte pagÃ³ el pedido.';

COMMENT ON TABLE public.cod_transport_compensation_lines IS
  'Detalle de montos aplicados por compensaciÃ³n. Historial inmutable si status=applied.';

ALTER TABLE public.cod_transport_compensations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cod_transport_compensation_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cod_transport_compensations_select ON public.cod_transport_compensations;
CREATE POLICY cod_transport_compensations_select
  ON public.cod_transport_compensations
  FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'conciliacion-reembolso', 'view'));

DROP POLICY IF EXISTS cod_transport_compensation_lines_select ON public.cod_transport_compensation_lines;
CREATE POLICY cod_transport_compensation_lines_select
  ON public.cod_transport_compensation_lines
  FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'conciliacion-reembolso', 'view'));

REVOKE ALL ON TABLE public.cod_transport_compensations FROM PUBLIC;
REVOKE ALL ON TABLE public.cod_transport_compensations FROM anon;
REVOKE ALL ON TABLE public.cod_transport_compensation_lines FROM PUBLIC;
REVOKE ALL ON TABLE public.cod_transport_compensation_lines FROM anon;
GRANT SELECT ON TABLE public.cod_transport_compensations TO authenticated;
GRANT SELECT ON TABLE public.cod_transport_compensation_lines TO authenticated;
GRANT ALL ON TABLE public.cod_transport_compensations TO service_role;
GRANT ALL ON TABLE public.cod_transport_compensation_lines TO service_role;

-- Event types: adjustments + compensation + irregularity_compensated
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'cod_reconciliation_events'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%event_type%'
  LOOP
    EXECUTE format('ALTER TABLE public.cod_reconciliation_events DROP CONSTRAINT %I', r.conname);
  END LOOP;

  ALTER TABLE public.cod_reconciliation_events
    ADD CONSTRAINT cod_reconciliation_events_event_type_check
    CHECK (event_type IN (
      'remittance_created',
      'remittance_analyzed',
      'candidate_approved',
      'remittance_confirmed',
      'manual_assignment',
      'assignment_corrected',
      'irregularity_created',
      'irregularity_review_started',
      'irregularity_resolved',
      'irregularity_compensated',
      'remittance_voided',
      'alias_created',
      'alias_reactivated',
      'alias_deactivated',
      'alias_reassigned',
      'remittance_edited',
      'complementary_payment_approved',
      'complementary_payment_applied',
      'complementary_balance_reopened',
      'transport_adjustment_registered',
      'transport_adjustment_voided',
      'transport_compensation_applied',
      'transport_compensation_voided'
    ));
END $$;

COMMENT ON CONSTRAINT cod_reconciliation_events_event_type_check
  ON public.cod_reconciliation_events IS
  '296 preserva eventos 292 y agrega diferencias/compensaciÃ³n transporte.';

-- Vista de saldo neto por transporte (lectura)
CREATE OR REPLACE VIEW public.cod_v_transport_difference_balances
WITH (security_invoker = true)
AS
WITH claims AS (
  SELECT
    i.transport_id,
    COALESCE(SUM(i.remaining_amount), 0)::numeric(12,2) AS claim_open
  FROM public.cod_irregularities i
  WHERE i.status IN ('open', 'in_review')
    AND i.amount_diff < -0.004
    AND i.remaining_amount > 0.004
  GROUP BY i.transport_id
),
credits_adj AS (
  SELECT
    a.transport_id,
    COALESCE(SUM(a.remaining_amount), 0)::numeric(12,2) AS credit_adj
  FROM public.cod_transport_adjustments a
  WHERE a.direction = 'transport_credit'
    AND a.status IN ('open', 'partially_compensated')
    AND a.remaining_amount > 0.004
  GROUP BY a.transport_id
),
credits_irreg AS (
  -- Sobrantes COD (amount_diff > 0): a favor del transporte, sin duplicar en adjustments
  SELECT
    i.transport_id,
    COALESCE(SUM(i.remaining_amount), 0)::numeric(12,2) AS credit_irreg
  FROM public.cod_irregularities i
  WHERE i.status IN ('open', 'in_review')
    AND i.amount_diff > 0.004
    AND i.remaining_amount > 0.004
  GROUP BY i.transport_id
),
transports_touched AS (
  SELECT transport_id FROM claims
  UNION
  SELECT transport_id FROM credits_adj
  UNION
  SELECT transport_id FROM credits_irreg
)
SELECT
  t.id AS transport_id,
  t.name AS transport_name,
  COALESCE(c.claim_open, 0)::numeric(12,2) AS claim_open,
  (COALESCE(ca.credit_adj, 0) + COALESCE(ci.credit_irreg, 0))::numeric(12,2) AS credit_open,
  (
    COALESCE(c.claim_open, 0)
    - COALESCE(ca.credit_adj, 0)
    - COALESCE(ci.credit_irreg, 0)
  )::numeric(12,2) AS net_balance
FROM public.transports t
INNER JOIN transports_touched tt ON tt.transport_id = t.id
LEFT JOIN claims c ON c.transport_id = t.id
LEFT JOIN credits_adj ca ON ca.transport_id = t.id
LEFT JOIN credits_irreg ci ON ci.transport_id = t.id;

COMMENT ON VIEW public.cod_v_transport_difference_balances IS
  'Saldo operativo por transporte: claim_open âˆ’ credit_open. Usa remaining, no amount_diff histÃ³rico.';

GRANT SELECT ON public.cod_v_transport_difference_balances TO authenticated;

SELECT pg_notify('pgrst', 'reload schema');

-- >>> 297_rpc_cod_register_void_transport_adjustment.sql
-- 297_rpc_cod_register_void_transport_adjustment.sql
--
-- rpc_cod_register_transport_adjustment
-- rpc_cod_void_transport_adjustment
--
-- V1: solo direction=transport_credit.
-- Monto siempre desde row.parsed_amount (no confiar en frontend).
-- Fila â†’ classified_adjustment (no confirmed_matched).
-- NO APPLY hasta aprobaciÃ³n.

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
    COALESCE(v_obs, 'CrÃ©dito a favor del transporte registrado')
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

  -- V1: si ya se usÃ³ en compensaciÃ³n, rechazar
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
    v_reason := 'Ajuste anulado sin uso en compensaciÃ³n';
  END IF;

  UPDATE public.cod_transport_adjustments SET
    status = 'voided',
    remaining_amount = 0,
    voided_by = v_uid,
    voided_at = now(),
    void_reason = v_reason,
    updated_at = now()
  WHERE id = p_adjustment_id;

  -- Devolver fila a unassigned operativo (sigue en rendiciÃ³n para auditorÃ­a)
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
  '295/297 V1: registra crÃ©dito transport_credit desde fila; monto=parsed_amount DB; filaâ†’classified_adjustment; no muta orders.';

COMMENT ON FUNCTION public.rpc_cod_void_transport_adjustment(uuid, text) IS
  '297 V1: void solo si remaining=original (sin compensaciones). Rechaza adjustment_has_compensations.';

SELECT pg_notify('pgrst', 'reload schema');

-- >>> 298_rpc_cod_compensate_transport_differences.sql
-- 298_rpc_cod_compensate_transport_differences.sql
--
-- CompensaciÃ³n V1 automÃ¡tica (FIFO) entre claims y credits del mismo transporte.
-- Usuario selecciona sets; el sistema aplica min(sum remainings) y distribuye.
-- NO APPLY hasta aprobaciÃ³n.

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
      'CompensaciÃ³n automÃ¡tica FIFO por $%s (claims $%s Â· credits $%s).',
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
        resolution_note = 'Compensado con crÃ©dito del transporte',
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
        'Compensado con crÃ©dito del transporte'
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

  -- Distribuir sobrantes irreg como crÃ©dito
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
  '298 V1: neteo FIFO min(claims,credits) mismo transporte. amount_diff intacto. Cierra claim total con resolved+nota compensaciÃ³n.';

COMMENT ON FUNCTION public.rpc_cod_list_transport_differences(uuid) IS
  '298: balances + claims/credits abiertos para UI Diferencias del transporte.';

SELECT pg_notify('pgrst', 'reload schema');

-- >>> 299_cod_void_remittance_transport_adjustments.sql
-- 299_cod_void_remittance_transport_adjustments.sql
--
-- PolÃ­tica void remesa â†” adjustments + documentaciÃ³n complementary/remaining.
--
-- remaining_amount coherencia con complementary 292â€“294:
--   NO se modifica el archivo histÃ³rico 294.
--   El trigger _cod_irregularity_remaining_sync (295) fuerza remaining=0
--   cuando status pasa a resolved/superseded (exact resolve y partial supersede).
--   INSERT de nueva faltante parcial toma remaining=abs(amount_diff) vÃ­a trigger.
--
-- Void remesa:
--   - adjustments con remaining < original â†’ BLOQUEAR remittance_has_compensated_adjustments
--   - adjustments unused â†’ void automÃ¡tico + fila classified_adjustment â†’ unassigned
--     (asÃ­ 288/291 no ven estados inesperados)
--
-- NO APPLY hasta aprobaciÃ³n.

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

  -- Void automÃ¡tico de adjustments unused de esta remesa
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
      void_reason = 'Anulado por void de rendiciÃ³n',
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
      'Ajuste sin compensar anulado junto con la rendiciÃ³n (fila vuelve a unassigned para 288/291)'
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
      -- remaining â†’ 0 vÃ­a trigger 295

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
      -- remaining = abs(amount_diff) vÃ­a trigger 295

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
        'Saldo reabierto por anulaciÃ³n de pago complementario'
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
  'remaining irreg coherente vÃ­a trigger 295 (no patch del cuerpo financiero 294 histÃ³rico en archivo).';

SELECT pg_notify('pgrst', 'reload schema');

-- >>> 300_cod_classified_adjustment_row_status_patches.sql
-- 300_cod_classified_adjustment_row_status_patches.sql
--
-- Patches for row_status = classified_adjustment against live RPCs (291 body).
-- Does NOT edit historical 278/280/288/294 files â€” CREATE OR REPLACE only.
-- Depends on 295â€“299 (classified_adjustment + void remesa path).
-- NO APPLY until approval (same gate as 295â€“299).
--
-- Patch matrix:
--   confirm (rpc_cod_confirm_remittance): classified = skip like unassigned
--   save_analysis (rpc_cod_save_analysis): preserve/skip classified on reanalyze
--   void (_cod_291_void_confirmed_remittance): treat classified as unexpected
--     UNLESS 299 already normalized classifiedâ†’unassigned before calling 291
--     (299 does that for unused adjustments). Still allow classified in the
--     "valid states" count so a race / partial path does not hard-fail.

-- =============================================================================
-- 1) Confirm: allow classified_adjustment as ready (no COD confirm)
-- =============================================================================
-- Source of truth post-291/294: public.rpc_cod_confirm_remittance
-- Exact change in the readiness gate:
--
--   BEFORE:
--     AND r.row_status NOT IN ('approved_pending_confirmation', 'unassigned')
--   AFTER:
--     AND r.row_status NOT IN (
--       'approved_pending_confirmation', 'unassigned', 'classified_adjustment'
--     )
--
-- Loop body already skips non-approved rows (unassigned path) â€” classified
-- must follow the same skip (no pending COD, no irregularity).

DO $patch_confirm$
DECLARE
  v_src text;
  v_new text;
  v_reg regprocedure;
BEGIN
  v_reg := to_regprocedure('public.rpc_cod_confirm_remittance(uuid)');
  IF v_reg IS NULL THEN
    RAISE NOTICE '300: rpc_cod_confirm_remittance missing â€” skip confirm patch';
    RETURN;
  END IF;
  v_src := pg_get_functiondef(v_reg);

  IF v_src ILIKE '%classified_adjustment%'
     AND v_src ILIKE '%approved_pending_confirmation'', ''unassigned'', ''classified_adjustment%' THEN
    RAISE NOTICE '300: confirm already patched';
    RETURN;
  END IF;

  IF position(
    $$AND r.row_status NOT IN ('approved_pending_confirmation', 'unassigned')$$
    in v_src
  ) = 0 THEN
    RAISE EXCEPTION '300_confirm_patch_anchor_not_found';
  END IF;

  v_new := replace(
    v_src,
    $$AND r.row_status NOT IN ('approved_pending_confirmation', 'unassigned')$$,
    $$AND r.row_status NOT IN ('approved_pending_confirmation', 'unassigned', 'classified_adjustment')$$
  );

  -- Ensure loop skips classified (same as unassigned: no financial COD path).
  -- If the function uses explicit status branches, append a no-op guard comment
  -- is insufficient â€” require an explicit IF after fetch:
  IF v_new NOT ILIKE '%classified_adjustment%' THEN
    RAISE EXCEPTION '300_confirm_patch_failed';
  END IF;

  EXECUTE v_new;
  RAISE NOTICE '300: rpc_cod_confirm_remittance patched';
END;
$patch_confirm$;

-- =============================================================================
-- 2) Save analysis: classified rows are reanalyzable-safe (preserved)
-- =============================================================================
-- Changes in rpc_cod_save_analysis:
--   A) remittance_has_non_analyzable_rows: keep rejecting confirmed_*/void
--      (classified is NOT in that reject list â€” OK once allowed below)
--   B) remittance_rows_not_reanalyzable whitelist MUST include classified_adjustment
--   C) Payload row_status validation: when DB row is classified_adjustment,
--      skip mutation (preserve) even if payload omits or mismatches
--
-- Because full function rewrite is large, we patch anchors via pg_get_functiondef.

DO $patch_save$
DECLARE
  v_src text;
  v_new text;
  v_reg regprocedure;
BEGIN
  -- Live signature (291): (uuid, jsonb, jsonb) â€” not (uuid, jsonb)
  v_reg := to_regprocedure('public.rpc_cod_save_analysis(uuid, jsonb, jsonb)');
  IF v_reg IS NULL THEN
    RAISE NOTICE '300: rpc_cod_save_analysis(uuid,jsonb,jsonb) missing â€” skip';
    RETURN;
  END IF;
  v_src := pg_get_functiondef(v_reg);

  IF v_src ILIKE '%classified_adjustment%'
     AND position($$'pending_analysis', 'auto_matched', 'needs_review', 'unassigned', 'classified_adjustment'$$ in v_src) > 0 THEN
    RAISE NOTICE '300: save_analysis already patched';
    RETURN;
  END IF;

  IF position(
    $$'pending_analysis', 'auto_matched', 'needs_review', 'unassigned'$$
    in v_src
  ) = 0 THEN
    RAISE EXCEPTION '300_save_analysis_whitelist_anchor_not_found';
  END IF;

  v_new := replace(
    v_src,
    $$'pending_analysis', 'auto_matched', 'needs_review', 'unassigned'$$,
    $$'pending_analysis', 'auto_matched', 'needs_review', 'unassigned', 'classified_adjustment'$$
  );

  -- Payload status gate: allow classified_adjustment as valid input status
  IF position(
    $$IF v_row_status NOT IN ('auto_matched', 'needs_review', 'unassigned') THEN$$
    in v_new
  ) > 0 THEN
    v_new := replace(
      v_new,
      $$IF v_row_status NOT IN ('auto_matched', 'needs_review', 'unassigned') THEN$$,
      $$IF v_row_status NOT IN ('auto_matched', 'needs_review', 'unassigned', 'classified_adjustment') THEN$$
    );
  END IF;

  EXECUTE v_new;
  RAISE NOTICE '300: rpc_cod_save_analysis patched (whitelist). Manual follow-up: preserve classified rows in UPDATE loop if payload omits them.';
END;
$patch_save$;

-- =============================================================================
-- 3) Void 291 helper: classified_adjustment counts as valid pre-void state
-- =============================================================================
-- 299 converts classifiedâ†’unassigned before calling _cod_291_void.
-- Still patch 291 so classified alone is not remittance_has_unexpected_row_states
-- (defense in depth / path without 299).

DO $patch_void$
DECLARE
  v_src text;
  v_new text;
  v_oid oid;
BEGIN
  SELECT p.oid INTO v_oid
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = '_cod_291_void_confirmed_remittance';

  IF v_oid IS NULL THEN
    RAISE NOTICE '300: _cod_291_void_confirmed_remittance missing â€” skip';
    RETURN;
  END IF;

  v_src := pg_get_functiondef(v_oid);

  IF v_src ILIKE '%classified_adjustment%' THEN
    RAISE NOTICE '300: void helper already mentions classified_adjustment';
    RETURN;
  END IF;

  IF position(
    $$'confirmed_matched', 'confirmed_with_irregularity', 'unassigned'$$
    in v_src
  ) = 0 THEN
    RAISE EXCEPTION '300_void_anchor_not_found';
  END IF;

  -- Broaden "expected states" filter used in other_count
  v_new := replace(
    v_src,
    $$'confirmed_matched', 'confirmed_with_irregularity', 'unassigned'$$,
    $$'confirmed_matched', 'confirmed_with_irregularity', 'unassigned', 'classified_adjustment'$$
  );

  EXECUTE v_new;
  RAISE NOTICE '300: _cod_291_void_confirmed_remittance patched';
END;
$patch_void$;

-- =============================================================================
-- 4) Explicit confirm skip note (documentation for reviewers)
-- =============================================================================
COMMENT ON FUNCTION public.rpc_cod_confirm_remittance(uuid) IS
  'Confirma remesa. Filas classified_adjustment se tratan como unassigned '
  '(skip COD). Patch 300 + schema 295.';

SELECT pg_notify('pgrst', 'reload schema');

-- ============================================================================
-- COD transport differences â€” runtime audit 295â€“299
-- ============================================================================
-- Requires 295-299 already applied on the target DB OR run inside a session that
-- applied them in the same transaction. For prod fyl-core: DO NOT apply permanently
-- â€” use throwaway branch or apply+audit+rollback in one session.
--
-- BEGINâ€¦ROLLBACK. MUST NOT leave anything applied.
-- MUST NEVER touch order A54945 or customer MAIRA/ORTEGA real.
--
-- Soft asserts (record ok/fail, no RAISE) so the final SELECT shows the full matrix.
-- ============================================================================
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
-- Section A: structure checks (skip Section B if 295â€“299 not present)
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
      'Section B skipped â€” apply 295â€“299 in this session (or branch) then re-run'
    );
  ELSE
    PERFORM pg_temp.cod_assert(
      'schema_295_299_not_applied',
      true,
      'schema objects detected â€” Section B will run'
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
    format('admins.user_id f6d58fbcâ€¦ â†’ admin_id=%s', v_admin_id)
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
    'has_permission(f6d58fbcâ€¦, conciliacion-reembolso, edit)'
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
      'schema missing â€” synthetic cases not executed'
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
  -- 1) Trigger remaining: insert open â†’ abs(diff); resolved â†’ 0; supersede â†’ 0
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
  -- 4) Duplicate active adjustment â†’ adjustment_already_active_for_row
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
  -- Shared claim/credit setup for cases 5â€“9
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

  -- --- Credit 75495 minus claim 16700 â†’ remaining 58795 partially_compensated ---
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

  -- FIFO: apply min(20000,18000)=18000 â†’ claim1 resolved, claim2 rem 2000;
  -- credits 8000+10000=18000 â†’ ambos remaining 0 / compensated
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
  --     credit 5000 + claim 5000 â†’ compensate once; second compensate on same
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
  -- 11) Void unused OK; void used â†’ adjustment_has_compensations
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
  -- 12) Void remittance unused OK; compensated â†’ remittance_has_compensated_adjustments
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

  -- register requires analyzed|confirmed â€” rem is confirmed OK
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
  -- 13) Complementary regression: trigger-level (resolve â†’ rem 0, no adj)
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
  -- 16) Atomicity: bad id mid-path â†’ no partial compensation rows
  -- =========================================================================
  SELECT count(*) INTO v_comp_before
  FROM public.cod_transport_compensations WHERE transport_id = v_tr;
  SELECT count(*) INTO v_lines_before
  FROM public.cod_transport_compensation_lines l
  JOIN public.cod_transport_compensations c ON c.id = l.compensation_id
  WHERE c.transport_id = v_tr;

  -- Open claim on v_tr + credit uuid that does not exist â†’ fails before apply
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
      format('err=%s comps %sâ†’%s lines %sâ†’%s',
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
    format('err=%s comps %sâ†’%s lines %sâ†’%s',
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

-- 18) ROLLBACK â€” nothing left applied

ROLLBACK;
