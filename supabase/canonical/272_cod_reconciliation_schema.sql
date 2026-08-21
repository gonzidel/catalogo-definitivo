-- 272_cod_reconciliation_schema.sql
--
-- Fase 1 — Módulo Conciliación Contra Reembolso
-- Crea las 4 tablas nuevas (vacías) + constraints + índices.
-- NO toca tablas existentes (orders, transports, etc.) salvo FKs nuevas.
-- NO modifica rpc_mark_order_as_sent.
-- NO toca migraciones 142/165/167/173.
-- NO inserta filas en admin_permissions (grant a colaboradores requiere aprobación aparte).
--
-- Idempotente: CREATE TABLE IF NOT EXISTS + índices con IF NOT EXISTS.

-- =============================================================================
-- 1) cod_remittances — cabecera de cada planilla de transporte
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.cod_remittances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transport_id uuid NOT NULL REFERENCES public.transports(id) ON DELETE RESTRICT,
  remittance_date date NOT NULL,
  reported_total numeric(12,2) NOT NULL CHECK (reported_total >= 0),
  calculated_total numeric(12,2),
  row_count int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','analyzed','confirmed','voided')),
  content_hash text,
  notes text,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  analyzed_at timestamptz,
  confirmed_by uuid REFERENCES auth.users(id),
  confirmed_at timestamptz,
  voided_by uuid REFERENCES auth.users(id),
  voided_at timestamptz,
  void_reason text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cod_remittances_transport_date
  ON public.cod_remittances (transport_id, remittance_date DESC);

CREATE INDEX IF NOT EXISTS idx_cod_remittances_status
  ON public.cod_remittances (status);

COMMENT ON TABLE public.cod_remittances IS
  'Cabecera de rendición COD (planilla de transporte). Nunca se borra: status=voided.';

-- =============================================================================
-- 2) cod_remittance_rows — filas pegadas + matching + snapshots
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.cod_remittance_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  remittance_id uuid NOT NULL REFERENCES public.cod_remittances(id) ON DELETE CASCADE,
  row_index int NOT NULL,

  -- Datos originales del transporte (INMUTABLES)
  raw_line text,
  raw_transport_date_text text NOT NULL,
  raw_customer_name_text text NOT NULL,
  raw_amount_text text NOT NULL,

  -- Datos parseados (derivados)
  parsed_transport_date date,
  parsed_amount numeric(12,2),
  parse_errors jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Matching y ciclo decisión → confirmación financiera
  row_status text NOT NULL DEFAULT 'pending_analysis'
    CHECK (row_status IN (
      'pending_analysis','auto_matched','needs_review',
      'approved_pending_confirmation',
      'confirmed_matched','confirmed_with_irregularity',
      'unassigned','void'
    )),
  matched_order_id uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  assignment_method text CHECK (assignment_method IN ('auto','manual')),
  match_score numeric(5,2),
  match_breakdown jsonb,
  match_candidates jsonb,
  matched_via_broadened_search boolean NOT NULL DEFAULT false,
  transport_mismatch boolean NOT NULL DEFAULT false,
  -- Flag informativo: NO crea fila en cod_irregularities por sí solo
  will_create_irregularity boolean NOT NULL DEFAULT false,

  -- Snapshots (solo cambian vía rpc_cod_correct_assignment en fases posteriores)
  order_number_snapshot text,
  matched_name_snapshot text,
  matched_name_source text CHECK (matched_name_source IN ('label','titular','sub_name')),
  transport_name_snapshot text,
  order_sent_date_snapshot date,
  order_sent_date_origin text CHECK (order_sent_date_origin IN ('sent_at','closed_at_fallback')),
  expected_amount_snapshot numeric(12,2),

  assigned_by uuid REFERENCES auth.users(id),
  assigned_at timestamptz,
  corrected_by uuid REFERENCES auth.users(id),
  corrected_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (remittance_id, row_index)
);

CREATE INDEX IF NOT EXISTS idx_cod_rows_remittance
  ON public.cod_remittance_rows (remittance_id);

CREATE INDEX IF NOT EXISTS idx_cod_rows_matched_order
  ON public.cod_remittance_rows (matched_order_id);

CREATE INDEX IF NOT EXISTS idx_cod_rows_status
  ON public.cod_remittance_rows (row_status);

CREATE INDEX IF NOT EXISTS idx_cod_rows_parsed_date
  ON public.cod_remittance_rows (parsed_transport_date);

-- Invariante financiero: un pedido no puede tener dos conciliaciones CONFIRMADAS activas.
-- approved_pending_confirmation NO participa (draft/analyzed abandonado no bloquea deuda).
CREATE UNIQUE INDEX IF NOT EXISTS uq_cod_rows_matched_order_active
  ON public.cod_remittance_rows (matched_order_id)
  WHERE row_status IN ('confirmed_matched','confirmed_with_irregularity');

COMMENT ON TABLE public.cod_remittance_rows IS
  'Filas de planilla COD. raw_* inmutables. Confirmación financiera solo en confirmed_*.';

-- =============================================================================
-- 3) cod_irregularities — reclamos por diferencia de monto
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.cod_irregularities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  remittance_row_id uuid NOT NULL REFERENCES public.cod_remittance_rows(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  remittance_id uuid NOT NULL REFERENCES public.cod_remittances(id) ON DELETE RESTRICT,
  transport_id uuid NOT NULL REFERENCES public.transports(id) ON DELETE RESTRICT,

  order_sent_date_snapshot date,
  remittance_date_snapshot date,
  expected_amount numeric(12,2) NOT NULL,
  reported_amount numeric(12,2) NOT NULL,
  -- amount_diff = reported_amount - expected_amount
  amount_diff numeric(12,2) NOT NULL,
  amount_diff_pct numeric(6,3),

  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','in_review','resolved','superseded')),
  observation text,

  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_by uuid REFERENCES auth.users(id),
  resolved_at timestamptz,
  resolution_note text,

  -- superseded != resolved: invalidación por corrección/anulación, no gestión admin
  superseded_reason text
    CHECK (superseded_reason IN ('assignment_corrected','remittance_voided')),
  superseded_at timestamptz,
  superseded_by uuid REFERENCES auth.users(id),

  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cod_irregularities_status
  ON public.cod_irregularities (status);

CREATE INDEX IF NOT EXISTS idx_cod_irregularities_transport
  ON public.cod_irregularities (transport_id);

CREATE INDEX IF NOT EXISTS idx_cod_irregularities_order
  ON public.cod_irregularities (order_id);

COMMENT ON TABLE public.cod_irregularities IS
  'Reclamos COD. resolved=gestionado por admin; superseded=invalidado por corrección/anulación.';

-- =============================================================================
-- 4) cod_reconciliation_events — auditoría append-only
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.cod_reconciliation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  remittance_id uuid NOT NULL REFERENCES public.cod_remittances(id) ON DELETE RESTRICT,
  remittance_row_id uuid REFERENCES public.cod_remittance_rows(id) ON DELETE RESTRICT,
  irregularity_id uuid REFERENCES public.cod_irregularities(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN (
    'remittance_created','remittance_analyzed','candidate_approved',
    'remittance_confirmed','manual_assignment','assignment_corrected',
    'irregularity_created','irregularity_resolved','remittance_voided'
  )),
  actor_id uuid NOT NULL REFERENCES auth.users(id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  previous_state jsonb,
  new_state jsonb,
  reason text
);

CREATE INDEX IF NOT EXISTS idx_cod_events_remittance
  ON public.cod_reconciliation_events (remittance_id);

CREATE INDEX IF NOT EXISTS idx_cod_events_row
  ON public.cod_reconciliation_events (remittance_row_id);

CREATE INDEX IF NOT EXISTS idx_cod_events_type
  ON public.cod_reconciliation_events (event_type);

COMMENT ON TABLE public.cod_reconciliation_events IS
  'Eventos de auditoría COD. Append-only: sin UPDATE/DELETE desde la app (solo SELECT + insert vía RPC).';
