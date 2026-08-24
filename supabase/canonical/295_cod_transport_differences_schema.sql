-- 295_cod_transport_differences_schema.sql
--
-- Diferencias del transporte V1 (repo only — NO APPLY hasta aprobación).
--
-- 1) remaining_amount en cod_irregularities (amount_diff histórico intacto)
-- 2) row_status classified_adjustment
-- 3) cod_transport_adjustments (créditos a favor del transporte)
-- 4) trigger: remaining en INSERT; remaining=0 al pasar a resolved/superseded
--
-- Criterio amount_diff > 0 (sobrantes COD):
--   Participan como "A favor del transporte" vía remaining_amount.
--   NO se duplican en cod_transport_adjustments.
--
-- Complementary 292–294:
--   No se modifica 294 aquí. La coherencia remaining=0 al resolver/supersede
--   la garantiza el trigger. INSERT de nueva faltante parcial toma remaining vía trigger.
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

-- resolved implica remaining = 0 (write-off o compensación). Sin excepciones V1.
ALTER TABLE public.cod_irregularities
  DROP CONSTRAINT IF EXISTS cod_irregularities_resolved_remaining_zero;

ALTER TABLE public.cod_irregularities
  ADD CONSTRAINT cod_irregularities_resolved_remaining_zero
  CHECK (status <> 'resolved' OR remaining_amount <= 0.005);

COMMENT ON COLUMN public.cod_irregularities.remaining_amount IS
  'Saldo operativo pendiente de compensar/cerrar. amount_diff permanece histórico. '
  'Al pasar a resolved/superseded el trigger fuerza 0. '
  'resolved vía 285 = write-off del remaining; vía compensación = neteo con crédito transporte.';

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
  '295 agrega classified_adjustment: fila clasificada como diferencia/crédito transporte (no es pago COD).';

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
  'V1: créditos a favor del transporte que NO son COD esperado. '
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
