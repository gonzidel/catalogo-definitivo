-- 292_cod_complementary_payments_schema.sql
-- Soporte de pagos complementarios COD. MIGRACIÓN DE REPO: NO APLICADA.
-- Aplicar 292 -> 293 -> 294 como una única ventana, sin usar el módulo entre pasos.

ALTER TABLE public.cod_remittance_rows
  ADD COLUMN IF NOT EXISTS assignment_role text NOT NULL DEFAULT 'primary';

ALTER TABLE public.cod_remittance_rows
  DROP CONSTRAINT IF EXISTS cod_remittance_rows_assignment_role_check;
ALTER TABLE public.cod_remittance_rows
  ADD CONSTRAINT cod_remittance_rows_assignment_role_check
  CHECK (assignment_role IN ('primary', 'supplementary'));

COMMENT ON COLUMN public.cod_remittance_rows.assignment_role IS
  'primary=conciliación inicial; supplementary=pago complementario de saldo. En V1 primary y supplementary en la misma remesa es imposible: supplementary exige primary ya confirmado y una remesa confirmada no es editable.';

DROP INDEX IF EXISTS public.uq_cod_rows_matched_order_active;

CREATE UNIQUE INDEX IF NOT EXISTS uq_cod_rows_matched_order_primary
  ON public.cod_remittance_rows (matched_order_id)
  WHERE row_status IN ('confirmed_matched', 'confirmed_with_irregularity')
    AND assignment_role = 'primary';

CREATE INDEX IF NOT EXISTS idx_cod_rows_matched_order_confirmed
  ON public.cod_remittance_rows (matched_order_id)
  WHERE row_status IN ('confirmed_matched', 'confirmed_with_irregularity');

-- La restricción original de 272 tiene nombre estable, pero se descubre
-- dinámicamente para tolerar instalaciones restauradas con nombres distintos.
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
      AND t.relname = 'cod_irregularities'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%superseded_reason%'
  LOOP
    EXECUTE format('ALTER TABLE public.cod_irregularities DROP CONSTRAINT %I', r.conname);
  END LOOP;

  ALTER TABLE public.cod_irregularities
    ADD CONSTRAINT cod_irregularities_superseded_reason_check
    CHECK (
      superseded_reason IS NULL OR superseded_reason IN (
        'assignment_corrected',
        'remittance_voided',
        'complementary_payment_partial'
      )
    );
END $$;

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
      'remittance_voided',
      'alias_created',
      'alias_reactivated',
      'alias_deactivated',
      'alias_reassigned',
      'remittance_edited',
      'complementary_payment_approved',
      'complementary_payment_applied',
      'complementary_balance_reopened'
    ));
END $$;

COMMENT ON CONSTRAINT cod_reconciliation_events_event_type_check
  ON public.cod_reconciliation_events IS
  '292 preserva eventos 289 y agrega ciclo de pago complementario.';

COMMENT ON INDEX public.uq_cod_rows_matched_order_primary IS
  'Una sola conciliación primary activa por pedido; supplementary puede acumular pagos.';

COMMENT ON INDEX public.idx_cod_rows_matched_order_confirmed IS
  'Lectura de todos los pagos COD confirmados, primary y supplementary.';

COMMENT ON TABLE public.cod_remittance_rows IS
  'Filas COD. En V1 una misma remesa no puede contener primary y supplementary del mismo pedido: supplementary requiere una primary de una remesa ya confirmada, que ya no es editable.';
