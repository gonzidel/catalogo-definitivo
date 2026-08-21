-- 284_cod_irregularity_review_event_type.sql
--
-- Fase 6A — Amplía event_type para irregularidades (preserva todos los valores actuales).
-- NO muta datos. NO aplica políticas DML nuevas.
--
-- Campos de resolución (resolved_by / resolved_at / resolution_note) YA existen en 272.
-- Solo se agrega: irregularity_review_started

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
      'alias_reassigned'
    ));
END $$;

COMMENT ON CONSTRAINT cod_reconciliation_events_event_type_check
  ON public.cod_reconciliation_events IS
  'Fase 6A: agrega irregularity_review_started. Preserva valores 272/281.';
