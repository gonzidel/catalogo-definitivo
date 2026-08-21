-- 281_cod_transport_customer_aliases_schema.sql
--
-- Alias de cliente por transporte (COD).
-- Concepto: "Cuando el transporte X informa este texto, se refiere a customer_id Y".
-- NO es additional_names / sub-nombre.
--
-- UNIQUE (transport_id, normalized_alias): una fila por par; reactivar/reasignar = UPDATE.
-- Soft-delete: is_active=false. Sin hard delete.
--
-- También amplía event_type de cod_reconciliation_events (preservando valores previos)
-- y permite remittance_id NULL para eventos de alias sin rendición de origen.

-- =============================================================================
-- 1) Tabla
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.cod_transport_customer_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transport_id uuid NOT NULL REFERENCES public.transports(id) ON DELETE RESTRICT,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  raw_alias text NOT NULL,
  normalized_alias text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  source_remittance_row_id uuid REFERENCES public.cod_remittance_rows(id) ON DELETE SET NULL,
  notes text,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cod_transport_customer_aliases_raw_nonempty
    CHECK (length(trim(raw_alias)) > 0),
  CONSTRAINT cod_transport_customer_aliases_norm_nonempty
    CHECK (length(trim(normalized_alias)) > 0),
  CONSTRAINT cod_transport_customer_aliases_transport_norm_unique
    UNIQUE (transport_id, normalized_alias)
);

CREATE INDEX IF NOT EXISTS idx_cod_tca_lookup_active
  ON public.cod_transport_customer_aliases (transport_id, normalized_alias)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_cod_tca_customer
  ON public.cod_transport_customer_aliases (customer_id);

CREATE INDEX IF NOT EXISTS idx_cod_tca_transport_active
  ON public.cod_transport_customer_aliases (transport_id, is_active);

CREATE INDEX IF NOT EXISTS idx_cod_tca_source_row
  ON public.cod_transport_customer_aliases (source_remittance_row_id)
  WHERE source_remittance_row_id IS NOT NULL;

COMMENT ON TABLE public.cod_transport_customer_aliases IS
  'Alias externo por transporte → customer_id. No mezclar con additional_names. Soft-delete vía is_active.';

COMMENT ON COLUMN public.cod_transport_customer_aliases.normalized_alias IS
  'Clave de lookup = public._cod_normalize_match_name(raw_alias). Debe coincidir con TS normalizeCodAliasName.';

COMMENT ON COLUMN public.cod_transport_customer_aliases.raw_alias IS
  'Texto tal como vino en planilla (auditoría).';

-- =============================================================================
-- 2) Eventos: ampliar CHECK + permitir remittance_id NULL (alias admin)
-- =============================================================================

ALTER TABLE public.cod_reconciliation_events
  ALTER COLUMN remittance_id DROP NOT NULL;

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
      'irregularity_resolved',
      'remittance_voided',
      'alias_created',
      'alias_reactivated',
      'alias_deactivated',
      'alias_reassigned'
    ));
END $$;

COMMENT ON COLUMN public.cod_reconciliation_events.remittance_id IS
  'Nullable desde 281: eventos de alias admin pueden no tener rendición de origen.';
