-- 289_cod_remittance_sheet_revisions_schema.sql
--
-- Edición PRE-confirmación por REVISIONES (sin DELETE de filas).
-- Revisión 1 = carga original. Edit → incrementa sheet_revision e INSERTA filas nuevas.
-- Filas de revisiones anteriores quedan históricas (eventos siguen apuntando a ellas).
--
-- Operativo = row.sheet_revision = remittance.sheet_revision
-- NO corrected_*. NO effective_*. NO soft-delete.
--
-- Secuencia apply: 289 → 290 → 291 (sin usar el módulo entre pasos).
-- NO APLICAR en producción sin aprobación explícita.

-- =============================================================================
-- 1) Cabecera
-- =============================================================================

ALTER TABLE public.cod_remittances
  ADD COLUMN IF NOT EXISTS sheet_revision integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS sheet_edited_by uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS sheet_edited_at timestamptz,
  ADD COLUMN IF NOT EXISTS sheet_edit_reason text,
  ADD COLUMN IF NOT EXISTS sheet_edit_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.cod_remittances
  DROP CONSTRAINT IF EXISTS cod_remittances_sheet_revision_positive;
ALTER TABLE public.cod_remittances
  ADD CONSTRAINT cod_remittances_sheet_revision_positive
  CHECK (sheet_revision >= 1);

COMMENT ON COLUMN public.cod_remittances.sheet_revision IS
  'Revisión operativa actual de la planilla. Empieza en 1 (carga original).';
COMMENT ON COLUMN public.cod_remittances.sheet_edited_by IS
  'Último actor que reemplazó la planilla pre-confirmación.';
COMMENT ON COLUMN public.cod_remittances.sheet_edited_at IS
  'Timestamp de la última edición de planilla.';
COMMENT ON COLUMN public.cod_remittances.sheet_edit_reason IS
  'Motivo obligatorio de la última edición.';
COMMENT ON COLUMN public.cod_remittances.sheet_edit_count IS
  'Cantidad de veces que se reemplazó la planilla (sheet_revision - 1).';

-- =============================================================================
-- 2) Filas — sheet_revision + UNIQUE compuesto
-- =============================================================================

ALTER TABLE public.cod_remittance_rows
  ADD COLUMN IF NOT EXISTS sheet_revision integer NOT NULL DEFAULT 1;

ALTER TABLE public.cod_remittance_rows
  DROP CONSTRAINT IF EXISTS cod_remittance_rows_sheet_revision_positive;
ALTER TABLE public.cod_remittance_rows
  ADD CONSTRAINT cod_remittance_rows_sheet_revision_positive
  CHECK (sheet_revision >= 1);

-- Permite mismo row_index en revisiones distintas (sin DELETE).
ALTER TABLE public.cod_remittance_rows
  DROP CONSTRAINT IF EXISTS cod_remittance_rows_remittance_id_row_index_key;

ALTER TABLE public.cod_remittance_rows
  DROP CONSTRAINT IF EXISTS cod_remittance_rows_remittance_revision_row_index_key;
ALTER TABLE public.cod_remittance_rows
  ADD CONSTRAINT cod_remittance_rows_remittance_revision_row_index_key
  UNIQUE (remittance_id, sheet_revision, row_index);

CREATE INDEX IF NOT EXISTS idx_cod_rows_remittance_revision
  ON public.cod_remittance_rows (remittance_id, sheet_revision);

COMMENT ON COLUMN public.cod_remittance_rows.sheet_revision IS
  'Revisión de planilla a la que pertenece esta fila. Histórica si <> remittance.sheet_revision.';

-- uq_cod_rows_matched_order_active: solo confirmed_* (nunca en edit pre-confirm).
-- Filas históricas approved/auto no participan del UNIQUE. Sin cambio.

-- =============================================================================
-- 3) Vista operativa (lecturas PostgREST / claridad)
-- =============================================================================

CREATE OR REPLACE VIEW public.cod_remittance_rows_current
WITH (security_invoker = true)
AS
SELECT r.*
FROM public.cod_remittance_rows r
INNER JOIN public.cod_remittances m
  ON m.id = r.remittance_id
 AND m.sheet_revision = r.sheet_revision;

COMMENT ON VIEW public.cod_remittance_rows_current IS
  'Solo filas de la revisión operativa actual (sheet_revision = cabecera).';

GRANT SELECT ON public.cod_remittance_rows_current TO authenticated;
GRANT SELECT ON public.cod_remittance_rows_current TO service_role;

-- =============================================================================
-- 4) event_type remittance_edited
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
      'remittance_edited'
    ));
END $$;

COMMENT ON CONSTRAINT cod_reconciliation_events_event_type_check
  ON public.cod_reconciliation_events IS
  '289 revisiones: agrega remittance_edited. Preserva 272/281/284.';
