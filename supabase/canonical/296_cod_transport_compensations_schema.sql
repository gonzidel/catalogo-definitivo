-- 296_cod_transport_compensations_schema.sql
--
-- Compensaciones entre:
--   claims  = irregularities (amount_diff < 0) con remaining > 0
--   credits = adjustments (transport_credit) + irregularities amount_diff > 0
--
-- No muta amount_diff / original_amount. Solo remaining + status + auditoría.
-- NO APPLY hasta aprobación.

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
  'Neteo auditable claim↔credit del mismo transporte. No implica que el transporte pagó el pedido.';

COMMENT ON TABLE public.cod_transport_compensation_lines IS
  'Detalle de montos aplicados por compensación. Historial inmutable si status=applied.';

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
  '296 preserva eventos 292 y agrega diferencias/compensación transporte.';

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
  'Saldo operativo por transporte: claim_open − credit_open. Usa remaining, no amount_diff histórico.';

GRANT SELECT ON public.cod_v_transport_difference_balances TO authenticated;

SELECT pg_notify('pgrst', 'reload schema');
