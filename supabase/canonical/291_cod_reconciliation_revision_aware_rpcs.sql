-- 291_cod_reconciliation_revision_aware_rpcs.sql
--
-- Adaptación revision-aware de RPCs COD ya aplicadas (278/279/280/286/287/288).
-- Las migraciones 278–288 quedan HISTÓRICAS e inmutables en el repo.
-- Este archivo es el ÚNICO lugar que debe aplicarse para actualizar esas funciones.
--
-- Secuencia de producción (intervención controlada, sin usar el módulo entre pasos):
--   289 → 290 → 291
-- Si 291 falla: DETENERSE. No editar rendiciones con schema 289 y RPCs viejas.
--
-- Requisito: 289 aplicado (columnas sheet_revision + UNIQUE compuesto).
--
-- Funciones CREATE OR REPLACE en este archivo:
--   1) public._cod_normalize_match_name(text)                 [helper 278]
--   2) public.rpc_cod_save_analysis(...)                     [278]
--   3) public._cod_load_order_financial_snapshots(uuid)      [helper 279]
--   4) public.rpc_cod_approve_auto_matched(uuid)             [279]
--   5) public.rpc_cod_assign_row(...)                        [279]
--   6) public.rpc_cod_mark_row_unassigned(uuid, uuid)        [279]
--   7) public.rpc_cod_confirm_remittance(uuid, boolean)      [280]
--   8) public.rpc_cod_assign_confirmed_unassigned(...)       [286]
--   9) public.rpc_cod_correct_confirmed_assignment(...)      [287]
--  10) public.rpc_cod_void_confirmed_remittance(uuid, text)  [288]
--  11) public._cod_remittance_current_revision(uuid)         [helper]
--
-- Predicado operativo: row.sheet_revision = remittance.sheet_revision
-- NO DELETE de filas históricas. NO null de remittance_row_id en events.
--
-- NO APLICAR en producción sin autorización explícita.

CREATE OR REPLACE FUNCTION public._cod_remittance_current_revision(p_remittance_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_catalog'
AS $$
  SELECT COALESCE(sheet_revision, 1)
  FROM public.cod_remittances
  WHERE id = p_remittance_id;
$$;

REVOKE ALL ON FUNCTION public._cod_remittance_current_revision(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._cod_remittance_current_revision(uuid) FROM anon;
REVOKE ALL ON FUNCTION public._cod_remittance_current_revision(uuid) FROM authenticated;
-- Helper interno: sin EXECUTE para PUBLIC/anon/authenticated.

COMMENT ON FUNCTION public._cod_remittance_current_revision(uuid) IS
  '291 helper interno: sheet_revision operativa. Sin GRANT a PUBLIC/anon/authenticated.';


-- =============================================================================
-- 278 save_analysis + normalize helper
-- =============================================================================

CREATE OR REPLACE FUNCTION public._cod_normalize_match_name(p_raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_catalog'
AS $fn$
  SELECT NULLIF(
    trim(
      regexp_replace(
        regexp_replace(
          translate(
            lower(trim(COALESCE(p_raw, ''))),
            'áàäâãéèëêíìïîóòöôõúùüûñçÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇ',
            'aaaaaeeeeiiiiooooouuuuncaaaaaeeeeiiiiooooouuuunc'
          ),
          '[.,;:/\\|_\+\-]+',
          ' ',
          'g'
        ),
        '\s+',
        ' ',
        'g'
      )
    ),
    ''
  );
$fn$;

REVOKE ALL ON FUNCTION public._cod_normalize_match_name(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._cod_normalize_match_name(text) FROM anon;
REVOKE ALL ON FUNCTION public._cod_normalize_match_name(text) FROM authenticated;

CREATE OR REPLACE FUNCTION public.rpc_cod_save_analysis(
  p_remittance_id uuid,
  p_rows jsonb,
  p_summary jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_status text;
  v_sheet_revision int;
  v_row jsonb;
  v_row_id uuid;
  v_row_status text;
  v_matched_order_id uuid;
  v_name_source text;
  v_matched_name_snapshot text;
  v_db_order_number text;
  v_db_expected_amount numeric(12,2);
  v_db_sent_date date;
  v_db_sent_origin text;
  v_db_transport_name text;
  v_db_label_name text;
  v_db_titular_name text;
  v_db_additional_names jsonb;
  v_name_ok boolean;
  v_count_auto int := 0;
  v_count_review int := 0;
  v_count_unassigned int := 0;
  v_updated int := 0;
  v_expected_rows int;
  v_payload_rows int;
  v_distinct_ids int;
  v_analyzed_at timestamptz := now();
  v_forbidden_keys text[] := ARRAY[
    'raw_line',
    'raw_transport_date_text',
    'raw_customer_name_text',
    'raw_amount_text',
    'parsed_transport_date',
    'parsed_amount',
    'remittance_id',
    'created_at',
    'assigned_by',
    'assigned_at',
    'corrected_by',
    'corrected_at'
  ];
  v_k text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF NOT public.has_permission(v_uid, 'conciliacion-reembolso', 'edit') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_remittance_id IS NULL THEN
    RAISE EXCEPTION 'remittance_id_required';
  END IF;

  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'rows_required';
  END IF;

  SELECT r.status, COALESCE(r.sheet_revision, 1)
  INTO v_status, v_sheet_revision
  FROM public.cod_remittances r
  WHERE r.id = p_remittance_id
  FOR UPDATE;

  IF NOT FOUND OR v_status IS NULL THEN
    RAISE EXCEPTION 'remittance_not_found';
  END IF;

  IF v_status IN ('confirmed', 'voided') THEN
    RAISE EXCEPTION 'remittance_not_analyzable status=%', v_status;
  END IF;

  IF v_status NOT IN ('draft', 'analyzed') THEN
    RAISE EXCEPTION 'remittance_invalid_status status=%', v_status;
  END IF;

  -- No reanalizar si el admin ya aprobó filas (Fase 5 prep) o hay estados no analíticos.
  -- Solo revisión operativa actual (filas históricas no bloquean / no cuentan)
  IF EXISTS (
    SELECT 1
    FROM public.cod_remittance_rows r
    WHERE r.remittance_id = p_remittance_id
      AND r.sheet_revision = v_sheet_revision
      AND r.row_status = 'approved_pending_confirmation'
  ) THEN
    RAISE EXCEPTION 'remittance_has_approved_rows';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.cod_remittance_rows r
    WHERE r.remittance_id = p_remittance_id
      AND r.sheet_revision = v_sheet_revision
      AND r.row_status IN ('confirmed_matched', 'confirmed_with_irregularity', 'void')
  ) THEN
    RAISE EXCEPTION 'remittance_has_non_analyzable_rows';
  END IF;

  -- Defensa: solo estados de análisis en filas de la revisión actual
  IF EXISTS (
    SELECT 1
    FROM public.cod_remittance_rows r
    WHERE r.remittance_id = p_remittance_id
      AND r.sheet_revision = v_sheet_revision
      AND r.row_status NOT IN (
        'pending_analysis', 'auto_matched', 'needs_review', 'unassigned'
      )
  ) THEN
    RAISE EXCEPTION 'remittance_rows_not_reanalyzable';
  END IF;

  v_payload_rows := jsonb_array_length(p_rows);

  SELECT count(*)::int INTO v_expected_rows
  FROM public.cod_remittance_rows
  WHERE remittance_id = p_remittance_id
    AND sheet_revision = v_sheet_revision;

  IF v_expected_rows = 0 THEN
    RAISE EXCEPTION 'remittance_has_no_rows';
  END IF;

  IF v_payload_rows <> v_expected_rows THEN
    RAISE EXCEPTION 'row_count_mismatch expected=% got=%', v_expected_rows, v_payload_rows;
  END IF;

  -- Sin IDs duplicados en el payload
  SELECT count(DISTINCT NULLIF(trim(e.value->>'row_id'), ''))::int
  INTO v_distinct_ids
  FROM jsonb_array_elements(p_rows) AS e;

  IF v_distinct_ids <> v_payload_rows THEN
    RAISE EXCEPTION 'duplicate_row_id_in_payload';
  END IF;

  -- Cobertura 1:1: todo row_id del payload pertenece a la remesa (revisión actual)
  -- y toda fila real de la revisión actual aparece en el payload.
  -- UUID inválido / vacío → row_not_in_remittance_or_invalid_id
  -- Fila histórica de la misma remesa → row_not_in_current_sheet_revision
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_rows) AS e
    WHERE NULLIF(trim(e.value->>'row_id'), '') IS NULL
       OR (e.value->>'row_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) THEN
    RAISE EXCEPTION 'row_not_in_remittance_or_invalid_id';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_rows) AS e
    WHERE EXISTS (
            SELECT 1
            FROM public.cod_remittance_rows r
            WHERE r.id = (e.value->>'row_id')::uuid
              AND r.remittance_id = p_remittance_id
              AND r.sheet_revision IS DISTINCT FROM v_sheet_revision
          )
  ) THEN
    RAISE EXCEPTION 'row_not_in_current_sheet_revision';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_rows) AS e
    WHERE NOT EXISTS (
            SELECT 1
            FROM public.cod_remittance_rows r
            WHERE r.id = (e.value->>'row_id')::uuid
              AND r.remittance_id = p_remittance_id
              AND r.sheet_revision = v_sheet_revision
          )
  ) THEN
    RAISE EXCEPTION 'row_not_in_remittance_or_invalid_id';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.cod_remittance_rows r
    WHERE r.remittance_id = p_remittance_id
      AND r.sheet_revision = v_sheet_revision
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(p_rows) AS e
        WHERE (e.value->>'row_id')::uuid = r.id
      )
  ) THEN
    RAISE EXCEPTION 'incomplete_row_coverage';
  END IF;

  FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows)
  LOOP
    -- Rechazar intento de tocar campos inmutables / de confirmación vía JSON
    FOREACH v_k IN ARRAY v_forbidden_keys
    LOOP
      IF v_row ? v_k THEN
        RAISE EXCEPTION 'immutable_or_forbidden_field %', v_k;
      END IF;
    END LOOP;

    BEGIN
      v_row_id := (v_row->>'row_id')::uuid;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'invalid_row_id';
    END;

    IF v_row_id IS NULL THEN
      RAISE EXCEPTION 'row_id_required';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.cod_remittance_rows
      WHERE id = v_row_id
        AND remittance_id = p_remittance_id
        AND sheet_revision = v_sheet_revision
    ) THEN
      RAISE EXCEPTION 'row_not_in_remittance row_id=%', v_row_id;
    END IF;

    v_row_status := trim(COALESCE(v_row->>'row_status', ''));
    IF v_row_status NOT IN ('auto_matched', 'needs_review', 'unassigned') THEN
      RAISE EXCEPTION 'invalid_row_status %', v_row_status;
    END IF;

    v_matched_order_id := NULL;
    v_db_order_number := NULL;
    v_db_expected_amount := NULL;
    v_db_sent_date := NULL;
    v_db_sent_origin := NULL;
    v_db_transport_name := NULL;
    v_db_label_name := NULL;
    v_db_titular_name := NULL;
    v_db_additional_names := NULL;
    v_name_source := NULL;
    v_matched_name_snapshot := NULL;

    IF v_row_status = 'unassigned' THEN
      v_matched_order_id := NULL;
    ELSE
      IF v_row ? 'matched_order_id' AND v_row->>'matched_order_id' IS NOT NULL
         AND trim(v_row->>'matched_order_id') <> '' THEN
        BEGIN
          v_matched_order_id := (v_row->>'matched_order_id')::uuid;
        EXCEPTION WHEN others THEN
          RAISE EXCEPTION 'invalid_matched_order_id';
        END;
      END IF;

      IF v_matched_order_id IS NULL THEN
        RAISE EXCEPTION 'matched_order_id_required_for_status %', v_row_status;
      END IF;

      -- Universo COD + snapshots derivados (fuente de verdad = DB)
      SELECT
        o.order_number,
        round(COALESCE(o.total_amount, 0)::numeric, 2),
        (COALESCE(o.sent_at, o.closed_at))::date,
        CASE
          WHEN o.sent_at IS NOT NULL THEN 'sent_at'
          ELSE 'closed_at_fallback'
        END,
        t.name,
        o.label_customer_name,
        c.full_name,
        COALESCE(c.additional_names, '[]'::jsonb)
      INTO
        v_db_order_number,
        v_db_expected_amount,
        v_db_sent_date,
        v_db_sent_origin,
        v_db_transport_name,
        v_db_label_name,
        v_db_titular_name,
        v_db_additional_names
      FROM public.orders o
      INNER JOIN public.customers c ON c.id = o.customer_id
      LEFT JOIN public.transports t
        ON t.id = COALESCE(o.transport_id, c.transport_id)
      WHERE o.id = v_matched_order_id
        AND o.status = 'sent'
        AND o.payment_method = 'Contra Reembolso'
        AND COALESCE(o.sent_at, o.closed_at)::date >= DATE '2026-05-01'
        AND NOT EXISTS (
          SELECT 1
          FROM public.local_orders lo
          WHERE lo.source_order_id = o.id
        );

      IF NOT FOUND THEN
        RAISE EXCEPTION 'matched_order_not_in_cod_universe order_id=%', v_matched_order_id;
      END IF;

      IF v_db_sent_date IS NULL THEN
        RAISE EXCEPTION 'matched_order_missing_sent_date order_id=%', v_matched_order_id;
      END IF;

      -- No permitir proponer un pedido ya confirmado financieramente en otra fila
      IF EXISTS (
        SELECT 1
        FROM public.cod_remittance_rows r
        WHERE r.matched_order_id = v_matched_order_id
          AND r.row_status IN ('confirmed_matched', 'confirmed_with_irregularity')
      ) THEN
        RAISE EXCEPTION 'matched_order_already_confirmed order_id=%', v_matched_order_id;
      END IF;

      -- Metadata explicativa (NO financiera). Validación razonable.
      v_name_source := NULLIF(trim(COALESCE(v_row->>'matched_name_source', '')), '');
      v_matched_name_snapshot := NULLIF(trim(COALESCE(v_row->>'matched_name_snapshot', '')), '');

      IF v_name_source IS NOT NULL AND v_name_source NOT IN ('label', 'titular', 'sub_name') THEN
        RAISE EXCEPTION 'invalid_matched_name_source %', v_name_source;
      END IF;

      IF (v_name_source IS NULL) <> (v_matched_name_snapshot IS NULL) THEN
        RAISE EXCEPTION 'matched_name_source_snapshot_mismatch';
      END IF;

      IF v_name_source IS NOT NULL THEN
        v_name_ok := false;
        IF v_name_source = 'label' THEN
          v_name_ok := public._cod_normalize_match_name(v_matched_name_snapshot)
                    = public._cod_normalize_match_name(v_db_label_name);
        ELSIF v_name_source = 'titular' THEN
          v_name_ok := public._cod_normalize_match_name(v_matched_name_snapshot)
                    = public._cod_normalize_match_name(v_db_titular_name);
        ELSIF v_name_source = 'sub_name' THEN
          SELECT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(v_db_additional_names, '[]'::jsonb)) AS e
            WHERE public._cod_normalize_match_name(v_matched_name_snapshot)
                = public._cod_normalize_match_name(
                    COALESCE(
                      NULLIF(trim(e.value->>'full_name'), ''),
                      NULLIF(
                        trim(
                          COALESCE(e.value->>'first_name', '') || ' ' ||
                          COALESCE(e.value->>'last_name', '')
                        ),
                        ''
                      ),
                      NULLIF(trim(e.value->>'name'), '')
                    )
                  )
          ) INTO v_name_ok;
        END IF;

        IF NOT COALESCE(v_name_ok, false) THEN
          RAISE EXCEPTION 'matched_name_not_in_order_identities source=%', v_name_source;
        END IF;
      END IF;

      -- Nota: order_number_snapshot / expected_amount_snapshot / fecha / transporte
      -- del JSON del cliente se IGNORAN. Siempre se persisten v_db_*.
    END IF;

    -- UPDATE solo columnas de análisis / snapshots.
    -- Snapshots de pedido/monto/fecha/transporte = derivados DB.
    -- matched_name_* = metadata explicativa validada (no financiera).
    -- raw_*, parsed_*, remittance_id, created_at, corrected_* NO aparecen en SET.
    UPDATE public.cod_remittance_rows SET
      row_status = v_row_status,
      matched_order_id = v_matched_order_id,
      assignment_method = CASE
        WHEN v_row_status IN ('auto_matched', 'needs_review') THEN 'auto'
        ELSE NULL
      END,
      match_score = CASE
        WHEN v_row_status = 'unassigned' THEN NULL
        WHEN v_row ? 'match_score' AND v_row->>'match_score' IS NOT NULL
          THEN (v_row->>'match_score')::numeric
        ELSE NULL
      END,
      match_breakdown = CASE
        WHEN v_row ? 'match_breakdown' THEN v_row->'match_breakdown'
        ELSE NULL
      END,
      match_candidates = CASE
        WHEN v_row ? 'match_candidates' THEN v_row->'match_candidates'
        ELSE NULL
      END,
      matched_via_broadened_search = COALESCE((v_row->>'matched_via_broadened_search')::boolean, false),
      transport_mismatch = COALESCE((v_row->>'transport_mismatch')::boolean, false),
      will_create_irregularity = CASE
        WHEN v_row_status = 'unassigned' THEN false
        ELSE COALESCE((v_row->>'will_create_irregularity')::boolean, false)
      END,
      order_number_snapshot = CASE
        WHEN v_row_status = 'unassigned' THEN NULL
        ELSE v_db_order_number
      END,
      matched_name_snapshot = CASE
        WHEN v_row_status = 'unassigned' THEN NULL
        ELSE v_matched_name_snapshot
      END,
      matched_name_source = CASE
        WHEN v_row_status = 'unassigned' THEN NULL
        ELSE v_name_source
      END,
      transport_name_snapshot = CASE
        WHEN v_row_status = 'unassigned' THEN NULL
        ELSE v_db_transport_name
      END,
      order_sent_date_snapshot = CASE
        WHEN v_row_status = 'unassigned' THEN NULL
        ELSE v_db_sent_date
      END,
      order_sent_date_origin = CASE
        WHEN v_row_status = 'unassigned' THEN NULL
        ELSE v_db_sent_origin
      END,
      expected_amount_snapshot = CASE
        WHEN v_row_status = 'unassigned' THEN NULL
        ELSE v_db_expected_amount
      END,
      assigned_by = NULL,
      assigned_at = NULL,
      updated_at = now()
    WHERE id = v_row_id
      AND remittance_id = p_remittance_id
      AND sheet_revision = v_sheet_revision;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'row_update_failed %', v_row_id;
    END IF;

    v_updated := v_updated + 1;
    IF v_row_status = 'auto_matched' THEN
      v_count_auto := v_count_auto + 1;
    ELSIF v_row_status = 'needs_review' THEN
      v_count_review := v_count_review + 1;
    ELSE
      v_count_unassigned := v_count_unassigned + 1;
    END IF;
  END LOOP;

  IF v_updated <> v_expected_rows THEN
    RAISE EXCEPTION 'update_count_mismatch expected=% got=%', v_expected_rows, v_updated;
  END IF;

  UPDATE public.cod_remittances SET
    status = 'analyzed',
    analyzed_at = v_analyzed_at,
    updated_at = now()
  WHERE id = p_remittance_id;

  -- p_summary: solo metadata de auditoría del evento. NO es fuente de verdad financiera.
  INSERT INTO public.cod_reconciliation_events (
    remittance_id,
    event_type,
    actor_id,
    new_state,
    reason
  ) VALUES (
    p_remittance_id,
    'remittance_analyzed',
    v_uid,
    jsonb_build_object(
      'status', 'analyzed',
      'analyzed_at', v_analyzed_at,
      'auto_matched', v_count_auto,
      'needs_review', v_count_review,
      'unassigned', v_count_unassigned,
      'rows_updated', v_updated,
      'client_summary_meta', COALESCE(p_summary, '{}'::jsonb),
      'snapshots_source', 'server_orders'
    ),
    'Análisis automático de matching (sin efecto financiero)'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'remittance_id', p_remittance_id,
    'analyzed_at', v_analyzed_at,
    'counts', jsonb_build_object(
      'auto_matched', v_count_auto,
      'needs_review', v_count_review,
      'unassigned', v_count_unassigned
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.rpc_cod_save_analysis(uuid, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_cod_save_analysis(uuid, jsonb, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.rpc_cod_save_analysis(uuid, jsonb, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cod_save_analysis(uuid, jsonb, jsonb) TO service_role;

COMMENT ON FUNCTION public.rpc_cod_save_analysis(uuid, jsonb, jsonb) IS
  'Fase 4: análisis matching batch. Snapshots monto/fecha/transporte/order_number desde orders. matched_name_* solo metadata explicativa (no financiera).';

COMMENT ON FUNCTION public._cod_normalize_match_name(text) IS
  'Helper interno COD: normalización básica para validar matched_name_* (no GRANT a clients).';

-- =============================================================================
-- 279 approve/assign/unassigned + snapshot helper
-- =============================================================================

CREATE OR REPLACE FUNCTION public._cod_load_order_financial_snapshots(p_order_id uuid)
RETURNS TABLE (
  order_number text,
  expected_amount numeric,
  sent_date date,
  sent_origin text,
  transport_id uuid,
  transport_name text,
  label_name text,
  titular_name text,
  additional_names jsonb
)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_catalog'
AS $fn$
BEGIN
  RETURN QUERY
  SELECT
    o.order_number,
    round(COALESCE(o.total_amount, 0)::numeric, 2),
    (COALESCE(o.sent_at, o.closed_at))::date,
    CASE WHEN o.sent_at IS NOT NULL THEN 'sent_at' ELSE 'closed_at_fallback' END,
    COALESCE(o.transport_id, c.transport_id),
    t.name,
    o.label_customer_name,
    c.full_name,
    COALESCE(c.additional_names, '[]'::jsonb)
  FROM public.orders o
  INNER JOIN public.customers c ON c.id = o.customer_id
  LEFT JOIN public.transports t ON t.id = COALESCE(o.transport_id, c.transport_id)
  WHERE o.id = p_order_id
    AND o.status = 'sent'
    AND o.payment_method = 'Contra Reembolso'
    AND COALESCE(o.sent_at, o.closed_at)::date >= DATE '2026-05-01'
    AND NOT EXISTS (
      SELECT 1 FROM public.local_orders lo WHERE lo.source_order_id = o.id
    );
END;
$fn$;

REVOKE ALL ON FUNCTION public._cod_load_order_financial_snapshots(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._cod_load_order_financial_snapshots(uuid) FROM anon;
REVOKE ALL ON FUNCTION public._cod_load_order_financial_snapshots(uuid) FROM authenticated;

-- ---------------------------------------------------------------------------
-- 1) Aprobar seguras en bloque
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_cod_approve_auto_matched(
  p_remittance_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_status text;
  v_sheet_revision int;
  v_transport_id uuid;
  v_row record;
  v_snap record;
  v_count int := 0;
  v_will_irreg boolean;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.has_permission(v_uid, 'conciliacion-reembolso', 'edit') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_remittance_id IS NULL THEN RAISE EXCEPTION 'remittance_id_required'; END IF;

  SELECT r.status, r.transport_id, COALESCE(r.sheet_revision, 1)
  INTO v_status, v_transport_id, v_sheet_revision
  FROM public.cod_remittances r
  WHERE r.id = p_remittance_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'remittance_not_found'; END IF;
  IF v_status IN ('confirmed', 'voided') THEN
    RAISE EXCEPTION 'remittance_not_editable status=%', v_status;
  END IF;
  IF v_status <> 'analyzed' THEN
    RAISE EXCEPTION 'remittance_not_analyzed status=%', v_status;
  END IF;

  FOR v_row IN
    SELECT *
    FROM public.cod_remittance_rows
    WHERE remittance_id = p_remittance_id
      AND sheet_revision = v_sheet_revision
      AND row_status = 'auto_matched'
    ORDER BY row_index
    FOR UPDATE
  LOOP
    IF v_row.parsed_amount IS NULL THEN
      RAISE EXCEPTION 'row_missing_parsed_amount row_id=%', v_row.id;
    END IF;

    IF v_row.matched_order_id IS NULL THEN
      RAISE EXCEPTION 'auto_matched_missing_order row_id=%', v_row.id;
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.cod_remittance_rows r
      WHERE r.matched_order_id = v_row.matched_order_id
        AND r.row_status IN ('confirmed_matched', 'confirmed_with_irregularity')
    ) THEN
      RAISE EXCEPTION 'matched_order_already_confirmed order_id=%', v_row.matched_order_id;
    END IF;

    SELECT * INTO v_snap
    FROM public._cod_load_order_financial_snapshots(v_row.matched_order_id);

    IF NOT FOUND OR v_snap.sent_date IS NULL THEN
      RAISE EXCEPTION 'matched_order_not_in_cod_universe order_id=%', v_row.matched_order_id;
    END IF;

    v_will_irreg := (
      abs(v_row.parsed_amount - v_snap.expected_amount) >= 0.005
    );

    UPDATE public.cod_remittance_rows SET
      row_status = 'approved_pending_confirmation',
      assignment_method = 'auto',
      order_number_snapshot = v_snap.order_number,
      expected_amount_snapshot = v_snap.expected_amount,
      order_sent_date_snapshot = v_snap.sent_date,
      order_sent_date_origin = v_snap.sent_origin,
      transport_name_snapshot = v_snap.transport_name,
      transport_mismatch = (v_snap.transport_id IS DISTINCT FROM v_transport_id),
      will_create_irregularity = v_will_irreg,
      assigned_by = v_uid,
      assigned_at = now(),
      updated_at = now()
    WHERE id = v_row.id
      AND remittance_id = p_remittance_id;

    INSERT INTO public.cod_reconciliation_events (
      remittance_id, remittance_row_id, event_type, actor_id, previous_state, new_state, reason
    ) VALUES (
      p_remittance_id,
      v_row.id,
      'candidate_approved',
      v_uid,
      jsonb_build_object('row_status', 'auto_matched', 'matched_order_id', v_row.matched_order_id),
      jsonb_build_object(
        'row_status', 'approved_pending_confirmation',
        'matched_order_id', v_row.matched_order_id,
        'assignment_method', 'auto',
        'expected_amount_snapshot', v_snap.expected_amount,
        'will_create_irregularity', v_will_irreg
      ),
      'Aprobación en bloque de coincidencia segura (sin efecto financiero)'
    );

    v_count := v_count + 1;
  END LOOP;

  UPDATE public.cod_remittances SET updated_at = now() WHERE id = p_remittance_id;

  RETURN jsonb_build_object(
    'ok', true,
    'remittance_id', p_remittance_id,
    'approved_count', v_count
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.rpc_cod_approve_auto_matched(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_cod_approve_auto_matched(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.rpc_cod_approve_auto_matched(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cod_approve_auto_matched(uuid) TO service_role;

COMMENT ON FUNCTION public.rpc_cod_approve_auto_matched(uuid) IS
  'Fase 5: aprueba auto_matched → approved_pending_confirmation. Sin efecto financiero.';

-- ---------------------------------------------------------------------------
-- 2) Asignar / aprobar pedido a una fila
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_cod_assign_row(
  p_remittance_id uuid,
  p_row_id uuid,
  p_order_id uuid,
  p_force boolean DEFAULT false,
  p_matched_name_snapshot text DEFAULT NULL,
  p_matched_name_source text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_status text;
  v_sheet_revision int;
  v_transport_id uuid;
  v_row public.cod_remittance_rows%ROWTYPE;
  v_snap record;
  v_warnings jsonb := '[]'::jsonb;
  v_day_diff int;
  v_amt_diff numeric;
  v_name_source text;
  v_matched_name text;
  v_name_ok boolean;
  v_method text;
  v_will_irreg boolean;
  v_prev_status text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.has_permission(v_uid, 'conciliacion-reembolso', 'edit') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_remittance_id IS NULL OR p_row_id IS NULL OR p_order_id IS NULL THEN
    RAISE EXCEPTION 'params_required';
  END IF;

  SELECT r.status, r.transport_id, COALESCE(r.sheet_revision, 1)
  INTO v_status, v_transport_id, v_sheet_revision
  FROM public.cod_remittances r
  WHERE r.id = p_remittance_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'remittance_not_found'; END IF;
  IF v_status IN ('confirmed', 'voided') THEN
    RAISE EXCEPTION 'remittance_not_editable status=%', v_status;
  END IF;
  IF v_status <> 'analyzed' THEN
    RAISE EXCEPTION 'remittance_not_analyzed status=%', v_status;
  END IF;

  SELECT * INTO v_row
  FROM public.cod_remittance_rows
  WHERE id = p_row_id
    AND remittance_id = p_remittance_id
    AND sheet_revision = v_sheet_revision
  FOR UPDATE;

  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1 FROM public.cod_remittance_rows
      WHERE id = p_row_id AND remittance_id = p_remittance_id
    ) THEN
      RAISE EXCEPTION 'row_not_in_current_sheet_revision';
    END IF;
    RAISE EXCEPTION 'row_not_in_remittance';
  END IF;

  IF v_row.row_status NOT IN (
    'auto_matched', 'needs_review', 'unassigned', 'approved_pending_confirmation'
  ) THEN
    RAISE EXCEPTION 'row_not_assignable status=%', v_row.row_status;
  END IF;

  -- Hard: sin monto informado no hay aprobación (p_force no lo salta)
  IF v_row.parsed_amount IS NULL THEN
    RAISE EXCEPTION 'row_missing_parsed_amount row_id=%', v_row.id;
  END IF;

  v_prev_status := v_row.row_status;

  IF EXISTS (
    SELECT 1 FROM public.cod_remittance_rows r
    WHERE r.matched_order_id = p_order_id
      AND r.row_status IN ('confirmed_matched', 'confirmed_with_irregularity')
  ) THEN
    RAISE EXCEPTION 'matched_order_already_confirmed order_id=%', p_order_id;
  END IF;

  SELECT * INTO v_snap FROM public._cod_load_order_financial_snapshots(p_order_id);
  IF NOT FOUND OR v_snap.sent_date IS NULL THEN
    RAISE EXCEPTION 'matched_order_not_in_cod_universe order_id=%', p_order_id;
  END IF;

  -- Warnings (solo discrepancias; p_force las puede aceptar)
  IF v_snap.transport_id IS DISTINCT FROM v_transport_id THEN
    v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
      'code', 'transport_mismatch',
      'message', 'Transporte efectivo distinto al de la rendición'
    ));
  END IF;

  IF v_row.parsed_transport_date IS NOT NULL THEN
    v_day_diff := abs(v_row.parsed_transport_date - v_snap.sent_date);
    IF v_day_diff > 3 THEN
      v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
        'code', 'date_far',
        'message', format('Fecha alejada (%s días)', v_day_diff),
        'day_diff', v_day_diff
      ));
    END IF;
  END IF;

  v_amt_diff := round((v_row.parsed_amount - v_snap.expected_amount)::numeric, 2);
  IF abs(v_amt_diff) >= 0.005 THEN
    v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
      'code', 'amount_diff',
      'message', 'Monto informado distinto al esperado del pedido',
      'amount_diff', v_amt_diff
    ));
  END IF;

  -- Validar matched_name_* si vienen (metadata explicativa)
  v_name_source := NULLIF(trim(COALESCE(p_matched_name_source, '')), '');
  v_matched_name := NULLIF(trim(COALESCE(p_matched_name_snapshot, '')), '');
  IF (v_name_source IS NULL) <> (v_matched_name IS NULL) THEN
    RAISE EXCEPTION 'matched_name_source_snapshot_mismatch';
  END IF;
  IF v_name_source IS NOT NULL THEN
    IF v_name_source NOT IN ('label', 'titular', 'sub_name') THEN
      RAISE EXCEPTION 'invalid_matched_name_source';
    END IF;
    v_name_ok := false;
    IF v_name_source = 'label' THEN
      v_name_ok := public._cod_normalize_match_name(v_matched_name)
                = public._cod_normalize_match_name(v_snap.label_name);
    ELSIF v_name_source = 'titular' THEN
      v_name_ok := public._cod_normalize_match_name(v_matched_name)
                = public._cod_normalize_match_name(v_snap.titular_name);
    ELSE
      SELECT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(v_snap.additional_names, '[]'::jsonb)) e
        WHERE public._cod_normalize_match_name(v_matched_name)
            = public._cod_normalize_match_name(
                COALESCE(
                  NULLIF(trim(e.value->>'full_name'), ''),
                  NULLIF(trim(COALESCE(e.value->>'first_name','') || ' ' || COALESCE(e.value->>'last_name','')), ''),
                  NULLIF(trim(e.value->>'name'), '')
                )
              )
      ) INTO v_name_ok;
    END IF;
    IF NOT COALESCE(v_name_ok, false) THEN
      v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
        'code', 'name_weak',
        'message', 'Nombre informado no coincide con la identidad declarada del pedido'
      ));
    END IF;
  ELSE
    -- Sin metadata de nombre: advertencia suave
    v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
      'code', 'name_unverified',
      'message', 'Asignación sin validación explícita de nombre'
    ));
  END IF;

  IF jsonb_array_length(v_warnings) > 0 AND NOT COALESCE(p_force, false) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'needs_force',
      'warnings', v_warnings,
      'order_id', p_order_id,
      'expected_amount', v_snap.expected_amount,
      'order_number', v_snap.order_number
    );
  END IF;

  v_method := CASE
    WHEN v_prev_status = 'auto_matched'
         AND v_row.matched_order_id IS NOT DISTINCT FROM p_order_id
      THEN 'auto'
    ELSE 'manual'
  END;

  v_will_irreg := (
    abs(v_row.parsed_amount - v_snap.expected_amount) >= 0.005
  );

  UPDATE public.cod_remittance_rows SET
    row_status = 'approved_pending_confirmation',
    matched_order_id = p_order_id,
    assignment_method = v_method,
    order_number_snapshot = v_snap.order_number,
    expected_amount_snapshot = v_snap.expected_amount,
    order_sent_date_snapshot = v_snap.sent_date,
    order_sent_date_origin = v_snap.sent_origin,
    transport_name_snapshot = v_snap.transport_name,
    matched_name_snapshot = v_matched_name,
    matched_name_source = v_name_source,
    transport_mismatch = (v_snap.transport_id IS DISTINCT FROM v_transport_id),
    will_create_irregularity = v_will_irreg,
    matched_via_broadened_search = COALESCE(matched_via_broadened_search, false)
      OR (v_snap.transport_id IS DISTINCT FROM v_transport_id),
    assigned_by = v_uid,
    assigned_at = now(),
    updated_at = now()
  WHERE id = p_row_id AND remittance_id = p_remittance_id;

  INSERT INTO public.cod_reconciliation_events (
    remittance_id, remittance_row_id, event_type, actor_id, previous_state, new_state, reason
  ) VALUES (
    p_remittance_id,
    p_row_id,
    CASE WHEN v_method = 'manual' THEN 'manual_assignment' ELSE 'candidate_approved' END,
    v_uid,
    jsonb_build_object('row_status', v_prev_status, 'matched_order_id', v_row.matched_order_id),
    jsonb_build_object(
      'row_status', 'approved_pending_confirmation',
      'matched_order_id', p_order_id,
      'assignment_method', v_method,
      'expected_amount_snapshot', v_snap.expected_amount,
      'will_create_irregularity', v_will_irreg,
      'forced', COALESCE(p_force, false),
      'warnings', v_warnings
    ),
    CASE
      WHEN v_method = 'manual' THEN 'Asignación/aprobación manual (sin efecto financiero)'
      ELSE 'Aprobación de candidato (sin efecto financiero)'
    END
  );

  UPDATE public.cod_remittances SET updated_at = now() WHERE id = p_remittance_id;

  RETURN jsonb_build_object(
    'ok', true,
    'remittance_id', p_remittance_id,
    'row_id', p_row_id,
    'matched_order_id', p_order_id,
    'assignment_method', v_method,
    'expected_amount_snapshot', v_snap.expected_amount,
    'will_create_irregularity', v_will_irreg,
    'warnings', v_warnings
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.rpc_cod_assign_row(uuid, uuid, uuid, boolean, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_cod_assign_row(uuid, uuid, uuid, boolean, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.rpc_cod_assign_row(uuid, uuid, uuid, boolean, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cod_assign_row(uuid, uuid, uuid, boolean, text, text) TO service_role;

COMMENT ON FUNCTION public.rpc_cod_assign_row(uuid, uuid, uuid, boolean, text, text) IS
  'Fase 5: aprueba/asigna pedido a fila → approved_pending_confirmation. Snapshots desde DB. Sin efecto financiero.';

-- ---------------------------------------------------------------------------
-- 3) Dejar sin identificar
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_cod_mark_row_unassigned(
  p_remittance_id uuid,
  p_row_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_status text;
  v_sheet_revision int;
  v_row public.cod_remittance_rows%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.has_permission(v_uid, 'conciliacion-reembolso', 'edit') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT r.status, COALESCE(r.sheet_revision, 1)
  INTO v_status, v_sheet_revision
  FROM public.cod_remittances r
  WHERE r.id = p_remittance_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'remittance_not_found'; END IF;
  IF v_status IN ('confirmed', 'voided') THEN
    RAISE EXCEPTION 'remittance_not_editable status=%', v_status;
  END IF;
  IF v_status <> 'analyzed' THEN
    RAISE EXCEPTION 'remittance_not_analyzed status=%', v_status;
  END IF;

  SELECT * INTO v_row
  FROM public.cod_remittance_rows
  WHERE id = p_row_id
    AND remittance_id = p_remittance_id
    AND sheet_revision = v_sheet_revision
  FOR UPDATE;

  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1 FROM public.cod_remittance_rows
      WHERE id = p_row_id AND remittance_id = p_remittance_id
    ) THEN
      RAISE EXCEPTION 'row_not_in_current_sheet_revision';
    END IF;
    RAISE EXCEPTION 'row_not_in_remittance';
  END IF;
  IF v_row.row_status NOT IN (
    'auto_matched', 'needs_review', 'unassigned', 'approved_pending_confirmation'
  ) THEN
    RAISE EXCEPTION 'row_not_assignable status=%', v_row.row_status;
  END IF;

  UPDATE public.cod_remittance_rows SET
    row_status = 'unassigned',
    matched_order_id = NULL,
    assignment_method = NULL,
    match_score = NULL,
    order_number_snapshot = NULL,
    matched_name_snapshot = NULL,
    matched_name_source = NULL,
    transport_name_snapshot = NULL,
    order_sent_date_snapshot = NULL,
    order_sent_date_origin = NULL,
    expected_amount_snapshot = NULL,
    transport_mismatch = false,
    will_create_irregularity = false,
    matched_via_broadened_search = false,
    assigned_by = NULL,
    assigned_at = NULL,
    updated_at = now()
  WHERE id = p_row_id AND remittance_id = p_remittance_id;

  INSERT INTO public.cod_reconciliation_events (
    remittance_id, remittance_row_id, event_type, actor_id, previous_state, new_state, reason
  ) VALUES (
    p_remittance_id,
    p_row_id,
    'manual_assignment',
    v_uid,
    jsonb_build_object('row_status', v_row.row_status, 'matched_order_id', v_row.matched_order_id),
    jsonb_build_object('row_status', 'unassigned', 'matched_order_id', NULL),
    'Fila marcada sin identificar (sin efecto financiero)'
  );

  UPDATE public.cod_remittances SET updated_at = now() WHERE id = p_remittance_id;

  RETURN jsonb_build_object('ok', true, 'remittance_id', p_remittance_id, 'row_id', p_row_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.rpc_cod_mark_row_unassigned(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_cod_mark_row_unassigned(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.rpc_cod_mark_row_unassigned(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cod_mark_row_unassigned(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.rpc_cod_mark_row_unassigned(uuid, uuid) IS
  'Fase 5: deja fila unassigned. Sin efecto financiero.';

-- =============================================================================
-- 280 confirm
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_cod_confirm_remittance(
  p_remittance_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_rem public.cod_remittances%ROWTYPE;
  v_row public.cod_remittance_rows%ROWTYPE;
  v_live_amount numeric(12,2);
  v_reported numeric(12,2);
  v_expected numeric(12,2);
  v_diff numeric(12,2);
  v_diff_pct numeric(6,3);
  v_new_status text;
  v_irreg_id uuid;
  v_count_exact int := 0;
  v_count_irreg int := 0;
  v_count_unassigned int := 0;
  v_count_approved int := 0;
  v_bad_status text;
  v_conflicting_order text;
  v_confirmed_at timestamptz := now();
  v_ord_id uuid;
  v_ord_number text;
  v_ord_status text;
  v_ord_payment_method text;
  v_ord_sent_at timestamptz;
  v_ord_closed_at timestamptz;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.has_permission(v_uid, 'conciliacion-reembolso', 'edit') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_remittance_id IS NULL THEN RAISE EXCEPTION 'remittance_id_required'; END IF;

  SELECT * INTO v_rem
  FROM public.cod_remittances
  WHERE id = p_remittance_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'remittance_not_found'; END IF;

  IF v_rem.status = 'confirmed' THEN
    RAISE EXCEPTION 'remittance_already_confirmed';
  END IF;
  IF v_rem.status = 'voided' THEN
    RAISE EXCEPTION 'remittance_voided';
  END IF;
  IF v_rem.status <> 'analyzed' THEN
    RAISE EXCEPTION 'remittance_not_confirmable status=%', v_rem.status;
  END IF;

  -- Todas las filas de la revisión operativa deben estar decididas
  SELECT r.row_status INTO v_bad_status
  FROM public.cod_remittance_rows r
  WHERE r.remittance_id = p_remittance_id
    AND r.sheet_revision = COALESCE(v_rem.sheet_revision, 1)
    AND r.row_status NOT IN ('approved_pending_confirmation', 'unassigned')
  LIMIT 1;

  IF v_bad_status IS NOT NULL THEN
    RAISE EXCEPTION 'rows_not_ready_for_confirm status=%', v_bad_status;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.cod_remittance_rows
    WHERE remittance_id = p_remittance_id
      AND sheet_revision = COALESCE(v_rem.sheet_revision, 1)
  ) THEN
    RAISE EXCEPTION 'remittance_has_no_rows';
  END IF;

  FOR v_row IN
    SELECT *
    FROM public.cod_remittance_rows
    WHERE remittance_id = p_remittance_id
      AND sheet_revision = COALESCE(v_rem.sheet_revision, 1)
    ORDER BY row_index
    FOR UPDATE
  LOOP
    IF v_row.row_status = 'unassigned' THEN
      v_count_unassigned := v_count_unassigned + 1;
      CONTINUE;
    END IF;

    -- approved_pending_confirmation
    v_count_approved := v_count_approved + 1;

    IF v_row.matched_order_id IS NULL THEN
      RAISE EXCEPTION 'approved_row_missing_order row_id=%', v_row.id;
    END IF;

    IF v_row.expected_amount_snapshot IS NULL THEN
      RAISE EXCEPTION 'approved_row_missing_expected_snapshot row_id=%', v_row.id;
    END IF;

    IF v_row.parsed_amount IS NULL THEN
      RAISE EXCEPTION 'approved_row_missing_parsed_amount row_id=%', v_row.id;
    END IF;

    -- 1) Lock orders: serializa confirmaciones concurrentes del mismo pedido
    SELECT
      o.id,
      o.order_number,
      round(COALESCE(o.total_amount, 0)::numeric, 2),
      o.status,
      o.payment_method,
      o.sent_at,
      o.closed_at
    INTO
      v_ord_id,
      v_ord_number,
      v_live_amount,
      v_ord_status,
      v_ord_payment_method,
      v_ord_sent_at,
      v_ord_closed_at
    FROM public.orders o
    WHERE o.id = v_row.matched_order_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'matched_order_not_found order_id=%', v_row.matched_order_id;
    END IF;

    -- 2) Universo COD (sobre la fila ya bloqueada)
    IF v_ord_status <> 'sent'
       OR v_ord_payment_method <> 'Contra Reembolso'
       OR COALESCE(v_ord_sent_at, v_ord_closed_at)::date < DATE '2026-05-01'
       OR EXISTS (
         SELECT 1 FROM public.local_orders lo
         WHERE lo.source_order_id = v_row.matched_order_id
       )
    THEN
      RAISE EXCEPTION 'matched_order_not_in_cod_universe order_id=%', v_row.matched_order_id;
    END IF;

    -- 3) Pedido ya conciliado por otra rendición (post-lock)
    IF EXISTS (
      SELECT 1
      FROM public.cod_remittance_rows r
      WHERE r.matched_order_id = v_row.matched_order_id
        AND r.id <> v_row.id
        AND r.row_status IN ('confirmed_matched', 'confirmed_with_irregularity')
    ) THEN
      v_conflicting_order := COALESCE(v_ord_number, v_row.matched_order_id::text);
      RAISE EXCEPTION
        'order_confirmed_elsewhere order=% msg=%',
        v_conflicting_order,
        format(
          'El pedido %s fue conciliado por otra rendición mientras esta estaba en revisión. Revisá la fila y volvé a intentar.',
          v_conflicting_order
        );
    END IF;

    -- 4) Monto vivo vs snapshot aprobado
    IF abs(v_live_amount - v_row.expected_amount_snapshot) >= 0.005 THEN
      RAISE EXCEPTION
        'order_amount_changed_since_approval row_id=% snapshot=% live=%',
        v_row.id, v_row.expected_amount_snapshot, v_live_amount;
    END IF;

    -- 5) Confirmar fila
    v_expected := v_row.expected_amount_snapshot;
    v_reported := round(v_row.parsed_amount::numeric, 2);
    v_diff := round((v_reported - v_expected)::numeric, 2);

    IF abs(v_diff) < 0.005 THEN
      v_new_status := 'confirmed_matched';
      v_count_exact := v_count_exact + 1;

      UPDATE public.cod_remittance_rows SET
        row_status = 'confirmed_matched',
        will_create_irregularity = false,
        updated_at = now()
      WHERE id = v_row.id;
    ELSE
      v_new_status := 'confirmed_with_irregularity';
      v_count_irreg := v_count_irreg + 1;
      v_diff_pct := CASE
        WHEN abs(v_expected) < 0.005 THEN NULL
        ELSE round((v_diff / abs(v_expected) * 100)::numeric, 3)
      END;

      UPDATE public.cod_remittance_rows SET
        row_status = 'confirmed_with_irregularity',
        will_create_irregularity = true,
        updated_at = now()
      WHERE id = v_row.id;

      INSERT INTO public.cod_irregularities (
        remittance_row_id,
        order_id,
        remittance_id,
        transport_id,
        order_sent_date_snapshot,
        remittance_date_snapshot,
        expected_amount,
        reported_amount,
        amount_diff,
        amount_diff_pct,
        status,
        created_by
      ) VALUES (
        v_row.id,
        v_row.matched_order_id,
        p_remittance_id,
        v_rem.transport_id,
        v_row.order_sent_date_snapshot,
        v_rem.remittance_date,
        v_expected,
        v_reported,
        v_diff,
        v_diff_pct,
        'open',
        v_uid
      )
      RETURNING id INTO v_irreg_id;

      INSERT INTO public.cod_reconciliation_events (
        remittance_id, remittance_row_id, irregularity_id, event_type, actor_id, new_state, reason
      ) VALUES (
        p_remittance_id,
        v_row.id,
        v_irreg_id,
        'irregularity_created',
        v_uid,
        jsonb_build_object(
          'amount_diff', v_diff,
          'expected_amount', v_expected,
          'reported_amount', v_reported,
          'order_id', v_row.matched_order_id
        ),
        'Irregularidad creada en confirmación financiera'
      );
    END IF;
  END LOOP;

  UPDATE public.cod_remittances SET
    status = 'confirmed',
    confirmed_by = v_uid,
    confirmed_at = v_confirmed_at,
    updated_at = now()
  WHERE id = p_remittance_id;

  INSERT INTO public.cod_reconciliation_events (
    remittance_id, event_type, actor_id, new_state, reason
  ) VALUES (
    p_remittance_id,
    'remittance_confirmed',
    v_uid,
    jsonb_build_object(
      'status', 'confirmed',
      'confirmed_at', v_confirmed_at,
      'approved_confirmed', v_count_approved,
      'exact', v_count_exact,
      'with_irregularity', v_count_irreg,
      'unassigned', v_count_unassigned
    ),
    'Confirmación financiera atómica de rendición COD'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'remittance_id', p_remittance_id,
    'confirmed_at', v_confirmed_at,
    'counts', jsonb_build_object(
      'confirmed_matched', v_count_exact,
      'confirmed_with_irregularity', v_count_irreg,
      'unassigned', v_count_unassigned,
      'total_confirmed_payments', v_count_approved
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.rpc_cod_confirm_remittance(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_cod_confirm_remittance(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.rpc_cod_confirm_remittance(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cod_confirm_remittance(uuid) TO service_role;

COMMENT ON FUNCTION public.rpc_cod_confirm_remittance(uuid) IS
  'Fase 5: confirmación financiera atómica. Crea irregularidades solo aquí. No muta orders.';

-- =============================================================================
-- 286 assign confirmed unassigned
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_cod_assign_confirmed_unassigned_row(
  p_remittance_id uuid,
  p_row_id uuid,
  p_order_id uuid,
  p_force boolean DEFAULT false,
  p_matched_name_snapshot text DEFAULT NULL,
  p_matched_name_source text DEFAULT NULL
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
  v_snap record;
  v_warnings jsonb := '[]'::jsonb;
  v_day_diff int;
  v_amt_diff numeric;
  v_name_source text;
  v_matched_name text;
  v_name_ok boolean;
  v_reported numeric(12,2);
  v_expected numeric(12,2);
  v_diff numeric(12,2);
  v_diff_pct numeric(6,3);
  v_new_status text;
  v_irreg_id uuid;
  v_ord_id uuid;
  v_ord_number text;
  v_ord_status text;
  v_ord_payment text;
  v_ord_sent_at timestamptz;
  v_ord_closed_at timestamptz;
  v_live_amount numeric(12,2);
  v_conflicting text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.has_permission(v_uid, 'conciliacion-reembolso', 'edit') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_remittance_id IS NULL OR p_row_id IS NULL OR p_order_id IS NULL THEN
    RAISE EXCEPTION 'params_required';
  END IF;

  SELECT * INTO v_rem
  FROM public.cod_remittances
  WHERE id = p_remittance_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'remittance_not_found'; END IF;
  IF v_rem.status <> 'confirmed' THEN
    RAISE EXCEPTION 'remittance_not_confirmed status=%', v_rem.status;
  END IF;

  SELECT * INTO v_row
  FROM public.cod_remittance_rows
  WHERE id = p_row_id
    AND remittance_id = p_remittance_id
    AND sheet_revision = COALESCE(v_rem.sheet_revision, 1)
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'row_not_in_remittance'; END IF;
  IF v_row.row_status <> 'unassigned' THEN
    RAISE EXCEPTION 'row_not_unassigned status=%', v_row.row_status;
  END IF;
  IF v_row.parsed_amount IS NULL THEN
    RAISE EXCEPTION 'row_missing_parsed_amount row_id=%', v_row.id;
  END IF;

  -- 1) Lock pedido ANTES de validar doble conciliación / universo
  SELECT
    o.id,
    o.order_number,
    round(COALESCE(o.total_amount, 0)::numeric, 2),
    o.status,
    o.payment_method,
    o.sent_at,
    o.closed_at
  INTO
    v_ord_id,
    v_ord_number,
    v_live_amount,
    v_ord_status,
    v_ord_payment,
    v_ord_sent_at,
    v_ord_closed_at
  FROM public.orders o
  WHERE o.id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'matched_order_not_found order_id=%', p_order_id;
  END IF;

  -- 2) Universo COD (hard — no forceable)
  IF v_ord_status <> 'sent'
     OR v_ord_payment <> 'Contra Reembolso'
     OR COALESCE(v_ord_sent_at, v_ord_closed_at)::date < DATE '2026-05-01'
     OR EXISTS (SELECT 1 FROM public.local_orders lo WHERE lo.source_order_id = p_order_id)
  THEN
    RAISE EXCEPTION 'matched_order_not_in_cod_universe order_id=%', p_order_id;
  END IF;

  -- 3) Ya conciliado confirmed_* (post-lock)
  IF EXISTS (
    SELECT 1 FROM public.cod_remittance_rows r
    WHERE r.matched_order_id = p_order_id
      AND r.row_status IN ('confirmed_matched', 'confirmed_with_irregularity')
  ) THEN
    v_conflicting := COALESCE(v_ord_number, p_order_id::text);
    RAISE EXCEPTION
      'order_confirmed_elsewhere order=% msg=%',
      v_conflicting,
      format('El pedido %s ya está conciliado.', v_conflicting);
  END IF;

  -- Snapshots auxiliares (nombres / transporte) vía helper existente
  SELECT * INTO v_snap FROM public._cod_load_order_financial_snapshots(p_order_id);
  IF NOT FOUND OR v_snap.sent_date IS NULL THEN
    RAISE EXCEPTION 'matched_order_not_in_cod_universe order_id=%', p_order_id;
  END IF;

  -- Monto esperado LIVE (paridad con lock)
  v_expected := v_live_amount;
  v_reported := round(v_row.parsed_amount::numeric, 2);
  v_diff := round((v_reported - v_expected)::numeric, 2);

  -- Warnings (forceables)
  IF v_snap.transport_id IS DISTINCT FROM v_rem.transport_id THEN
    v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
      'code', 'transport_mismatch',
      'message', 'Transporte efectivo distinto al de la rendición'
    ));
  END IF;

  IF v_row.parsed_transport_date IS NOT NULL THEN
    v_day_diff := abs(v_row.parsed_transport_date - v_snap.sent_date);
    IF v_day_diff > 3 THEN
      v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
        'code', 'date_far',
        'message', format('Fecha alejada (%s días)', v_day_diff),
        'day_diff', v_day_diff
      ));
    END IF;
  END IF;

  IF abs(v_diff) >= 0.005 THEN
    v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
      'code', 'amount_diff',
      'message', 'Monto informado distinto al esperado del pedido',
      'amount_diff', v_diff
    ));
  END IF;

  v_name_source := NULLIF(trim(COALESCE(p_matched_name_source, '')), '');
  v_matched_name := NULLIF(trim(COALESCE(p_matched_name_snapshot, '')), '');
  IF (v_name_source IS NULL) <> (v_matched_name IS NULL) THEN
    RAISE EXCEPTION 'matched_name_source_snapshot_mismatch';
  END IF;
  IF v_name_source IS NOT NULL THEN
    IF v_name_source NOT IN ('label', 'titular', 'sub_name') THEN
      RAISE EXCEPTION 'invalid_matched_name_source';
    END IF;
    v_name_ok := false;
    IF v_name_source = 'label' THEN
      v_name_ok := public._cod_normalize_match_name(v_matched_name)
                = public._cod_normalize_match_name(v_snap.label_name);
    ELSIF v_name_source = 'titular' THEN
      v_name_ok := public._cod_normalize_match_name(v_matched_name)
                = public._cod_normalize_match_name(v_snap.titular_name);
    ELSE
      SELECT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(v_snap.additional_names, '[]'::jsonb)) e
        WHERE public._cod_normalize_match_name(v_matched_name)
            = public._cod_normalize_match_name(
                COALESCE(
                  NULLIF(trim(e.value->>'full_name'), ''),
                  NULLIF(trim(COALESCE(e.value->>'first_name','') || ' ' || COALESCE(e.value->>'last_name','')), ''),
                  NULLIF(trim(e.value->>'name'), '')
                )
              )
      ) INTO v_name_ok;
    END IF;
    IF NOT COALESCE(v_name_ok, false) THEN
      v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
        'code', 'name_weak',
        'message', 'Nombre informado no coincide con la identidad declarada del pedido'
      ));
    END IF;
  ELSE
    v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
      'code', 'name_unverified',
      'message', 'Asignación sin validación explícita de nombre'
    ));
  END IF;

  IF jsonb_array_length(v_warnings) > 0 AND NOT COALESCE(p_force, false) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'needs_force',
      'warnings', v_warnings,
      'order_id', p_order_id,
      'expected_amount', v_expected,
      'reported_amount', v_reported,
      'amount_diff', v_diff,
      'order_number', v_snap.order_number,
      'will_create_irregularity', abs(v_diff) >= 0.005
    );
  END IF;

  IF abs(v_diff) < 0.005 THEN
    v_new_status := 'confirmed_matched';

    UPDATE public.cod_remittance_rows SET
      row_status = 'confirmed_matched',
      matched_order_id = p_order_id,
      assignment_method = 'manual',
      order_number_snapshot = v_snap.order_number,
      expected_amount_snapshot = v_expected,
      order_sent_date_snapshot = v_snap.sent_date,
      order_sent_date_origin = v_snap.sent_origin,
      transport_name_snapshot = v_snap.transport_name,
      matched_name_snapshot = v_matched_name,
      matched_name_source = v_name_source,
      transport_mismatch = (v_snap.transport_id IS DISTINCT FROM v_rem.transport_id),
      will_create_irregularity = false,
      matched_via_broadened_search = COALESCE(matched_via_broadened_search, false)
        OR (v_snap.transport_id IS DISTINCT FROM v_rem.transport_id),
      assigned_by = v_uid,
      assigned_at = now(),
      updated_at = now()
    WHERE id = p_row_id AND remittance_id = p_remittance_id;
  ELSE
    v_new_status := 'confirmed_with_irregularity';
    v_diff_pct := CASE
      WHEN abs(v_expected) < 0.005 THEN NULL
      ELSE round((v_diff / abs(v_expected) * 100)::numeric, 3)
    END;

    UPDATE public.cod_remittance_rows SET
      row_status = 'confirmed_with_irregularity',
      matched_order_id = p_order_id,
      assignment_method = 'manual',
      order_number_snapshot = v_snap.order_number,
      expected_amount_snapshot = v_expected,
      order_sent_date_snapshot = v_snap.sent_date,
      order_sent_date_origin = v_snap.sent_origin,
      transport_name_snapshot = v_snap.transport_name,
      matched_name_snapshot = v_matched_name,
      matched_name_source = v_name_source,
      transport_mismatch = (v_snap.transport_id IS DISTINCT FROM v_rem.transport_id),
      will_create_irregularity = true,
      matched_via_broadened_search = COALESCE(matched_via_broadened_search, false)
        OR (v_snap.transport_id IS DISTINCT FROM v_rem.transport_id),
      assigned_by = v_uid,
      assigned_at = now(),
      updated_at = now()
    WHERE id = p_row_id AND remittance_id = p_remittance_id;

    INSERT INTO public.cod_irregularities (
      remittance_row_id,
      order_id,
      remittance_id,
      transport_id,
      order_sent_date_snapshot,
      remittance_date_snapshot,
      expected_amount,
      reported_amount,
      amount_diff,
      amount_diff_pct,
      status,
      created_by
    ) VALUES (
      p_row_id,
      p_order_id,
      p_remittance_id,
      v_rem.transport_id,
      v_snap.sent_date,
      v_rem.remittance_date,
      v_expected,
      v_reported,
      v_diff,
      v_diff_pct,
      'open',
      v_uid
    )
    RETURNING id INTO v_irreg_id;

    INSERT INTO public.cod_reconciliation_events (
      remittance_id, remittance_row_id, irregularity_id, event_type, actor_id, new_state, reason
    ) VALUES (
      p_remittance_id,
      p_row_id,
      v_irreg_id,
      'irregularity_created',
      v_uid,
      jsonb_build_object(
        'amount_diff', v_diff,
        'expected_amount', v_expected,
        'reported_amount', v_reported,
        'order_id', p_order_id,
        'phase', '6b'
      ),
      'Irregularidad creada al asignar pago sin identificar (post-confirmación)'
    );
  END IF;

  INSERT INTO public.cod_reconciliation_events (
    remittance_id, remittance_row_id, irregularity_id, event_type, actor_id,
    previous_state, new_state, reason
  ) VALUES (
    p_remittance_id,
    p_row_id,
    v_irreg_id,
    'manual_assignment',
    v_uid,
    jsonb_build_object('row_status', 'unassigned', 'matched_order_id', NULL),
    jsonb_build_object(
      'row_status', v_new_status,
      'matched_order_id', p_order_id,
      'assignment_method', 'manual',
      'expected_amount_snapshot', v_expected,
      'reported_amount', v_reported,
      'amount_diff', v_diff,
      'financial_effect', true,
      'phase', '6b',
      'forced', COALESCE(p_force, false),
      'warnings', v_warnings,
      'irregularity_id', v_irreg_id
    ),
    'Asignación de pago sin identificar en rendición confirmada (efecto financiero)'
  );

  -- Cabecera: solo touch updated_at; status sigue confirmed
  UPDATE public.cod_remittances SET updated_at = now() WHERE id = p_remittance_id;

  RETURN jsonb_build_object(
    'ok', true,
    'remittance_id', p_remittance_id,
    'row_id', p_row_id,
    'matched_order_id', p_order_id,
    'row_status', v_new_status,
    'expected_amount', v_expected,
    'reported_amount', v_reported,
    'amount_diff', v_diff,
    'irregularity_id', v_irreg_id,
    'warnings', v_warnings
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.rpc_cod_assign_confirmed_unassigned_row(uuid, uuid, uuid, boolean, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_cod_assign_confirmed_unassigned_row(uuid, uuid, uuid, boolean, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.rpc_cod_assign_confirmed_unassigned_row(uuid, uuid, uuid, boolean, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cod_assign_confirmed_unassigned_row(uuid, uuid, uuid, boolean, text, text) TO service_role;

COMMENT ON FUNCTION public.rpc_cod_assign_confirmed_unassigned_row(uuid, uuid, uuid, boolean, text, text) IS
  'Fase 6B: asigna fila unassigned de rendición confirmed → confirmed_* (+ irreg si diff). FOR UPDATE orders. No reabre cabecera. No muta orders.';

-- =============================================================================
-- 287 correct assignment
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_cod_correct_confirmed_assignment(
  p_remittance_id uuid,
  p_row_id uuid,
  p_new_order_id uuid,
  p_reason text,
  p_force boolean DEFAULT false,
  p_matched_name_snapshot text DEFAULT NULL,
  p_matched_name_source text DEFAULT NULL
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
  v_snap record;
  v_warnings jsonb := '[]'::jsonb;
  v_day_diff int;
  v_name_source text;
  v_matched_name text;
  v_name_ok boolean;
  v_reported numeric(12,2);
  v_expected_new numeric(12,2);
  v_diff numeric(12,2);
  v_diff_pct numeric(6,3);
  v_new_status text;
  v_new_irreg_id uuid;
  v_old_order_id uuid;
  v_lock_id uuid;
  v_ord_id uuid;
  v_ord_number text;
  v_ord_status text;
  v_ord_payment text;
  v_ord_sent_at timestamptz;
  v_ord_closed_at timestamptz;
  v_live_amount numeric(12,2);
  v_conflicting text;
  v_reason text;
  v_old_irreg public.cod_irregularities%ROWTYPE;
  v_resolved_irreg_id uuid;
  v_resolved_irreg_status text;
  v_prev_state jsonb;
  v_new_state jsonb;
  v_superseded_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.has_permission(v_uid, 'conciliacion-reembolso', 'edit') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_remittance_id IS NULL OR p_row_id IS NULL OR p_new_order_id IS NULL THEN
    RAISE EXCEPTION 'params_required';
  END IF;

  v_reason := NULLIF(trim(COALESCE(p_reason, '')), '');
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'reason_required';
  END IF;

  SELECT * INTO v_rem
  FROM public.cod_remittances
  WHERE id = p_remittance_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'remittance_not_found'; END IF;
  IF v_rem.status <> 'confirmed' THEN
    RAISE EXCEPTION 'remittance_not_confirmed status=%', v_rem.status;
  END IF;

  SELECT * INTO v_row
  FROM public.cod_remittance_rows
  WHERE id = p_row_id
    AND remittance_id = p_remittance_id
    AND sheet_revision = COALESCE(v_rem.sheet_revision, 1)
  FOR UPDATE;

  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1 FROM public.cod_remittance_rows
      WHERE id = p_row_id AND remittance_id = p_remittance_id
    ) THEN
      RAISE EXCEPTION 'row_not_in_current_sheet_revision';
    END IF;
    RAISE EXCEPTION 'row_not_in_remittance';
  END IF;
  IF v_row.row_status NOT IN ('confirmed_matched', 'confirmed_with_irregularity') THEN
    RAISE EXCEPTION 'row_not_confirmed_assignment status=%', v_row.row_status;
  END IF;
  IF v_row.matched_order_id IS NULL THEN
    RAISE EXCEPTION 'row_missing_matched_order';
  END IF;
  IF v_row.parsed_amount IS NULL THEN
    RAISE EXCEPTION 'row_missing_parsed_amount row_id=%', v_row.id;
  END IF;

  v_old_order_id := v_row.matched_order_id;
  IF p_new_order_id = v_old_order_id THEN
    RAISE EXCEPTION 'same_order order_id=%', p_new_order_id;
  END IF;

  -- Capturar previous_state ANTES de mutar (historial obligatorio)
  v_prev_state := jsonb_build_object(
    'row_status', v_row.row_status,
    'old_order_id', v_old_order_id,
    'old_order_number', v_row.order_number_snapshot,
    'old_expected_amount', v_row.expected_amount_snapshot,
    'old_order_sent_date', v_row.order_sent_date_snapshot,
    'old_order_sent_date_origin', v_row.order_sent_date_origin,
    'old_transport_name', v_row.transport_name_snapshot,
    'old_matched_name_snapshot', v_row.matched_name_snapshot,
    'old_matched_name_source', v_row.matched_name_source,
    'old_assignment_method', v_row.assignment_method,
    'reported_amount', round(v_row.parsed_amount::numeric, 2)
  );

  -- Irregularidades previas del pedido A (active → supersede; resolved → solo audit)
  SELECT id, status INTO v_resolved_irreg_id, v_resolved_irreg_status
  FROM public.cod_irregularities
  WHERE remittance_row_id = p_row_id
    AND order_id = v_old_order_id
    AND status = 'resolved'
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_resolved_irreg_id IS NOT NULL THEN
    v_prev_state := v_prev_state || jsonb_build_object(
      'old_resolved_irregularity_id', v_resolved_irreg_id,
      'old_resolved_irregularity_status', v_resolved_irreg_status,
      'resolved_kept_intact', true
    );
  END IF;

  -- Locks determinísticos de A y B (UUID asc) ANTES de revalidar disponibilidad
  FOR v_lock_id IN
    SELECT x FROM unnest(ARRAY[v_old_order_id, p_new_order_id]) AS t(x) ORDER BY 1
  LOOP
    SELECT o.id INTO v_ord_id
    FROM public.orders o
    WHERE o.id = v_lock_id
    FOR UPDATE;
    IF NOT FOUND THEN
      IF v_lock_id = p_new_order_id THEN
        RAISE EXCEPTION 'matched_order_not_found order_id=%', p_new_order_id;
      ELSE
        RAISE EXCEPTION 'old_order_not_found order_id=%', v_old_order_id;
      END IF;
    END IF;
  END LOOP;

  -- Releer fila post-lock (asociación actual intacta)
  SELECT * INTO v_row
  FROM public.cod_remittance_rows
  WHERE id = p_row_id AND remittance_id = p_remittance_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_row.matched_order_id IS DISTINCT FROM v_old_order_id
     OR v_row.row_status NOT IN ('confirmed_matched', 'confirmed_with_irregularity') THEN
    RAISE EXCEPTION 'row_assignment_changed_concurrently';
  END IF;

  -- Datos LIVE del pedido B
  SELECT
    o.id,
    o.order_number,
    round(COALESCE(o.total_amount, 0)::numeric, 2),
    o.status,
    o.payment_method,
    o.sent_at,
    o.closed_at
  INTO
    v_ord_id,
    v_ord_number,
    v_live_amount,
    v_ord_status,
    v_ord_payment,
    v_ord_sent_at,
    v_ord_closed_at
  FROM public.orders o
  WHERE o.id = p_new_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'matched_order_not_found order_id=%', p_new_order_id;
  END IF;

  -- Universo COD (hard — NO forceable)
  IF v_ord_status <> 'sent'
     OR v_ord_payment <> 'Contra Reembolso'
     OR COALESCE(v_ord_sent_at, v_ord_closed_at)::date < DATE '2026-05-01'
     OR EXISTS (SELECT 1 FROM public.local_orders lo WHERE lo.source_order_id = p_new_order_id)
  THEN
    RAISE EXCEPTION 'matched_order_not_in_cod_universe order_id=%', p_new_order_id;
  END IF;

  -- Pedido B ya conciliado confirmed_* (post-lock)
  IF EXISTS (
    SELECT 1 FROM public.cod_remittance_rows r
    WHERE r.matched_order_id = p_new_order_id
      AND r.row_status IN ('confirmed_matched', 'confirmed_with_irregularity')
      AND r.id IS DISTINCT FROM p_row_id
  ) THEN
    v_conflicting := COALESCE(v_ord_number, p_new_order_id::text);
    RAISE EXCEPTION
      'order_confirmed_elsewhere order=% msg=%',
      v_conflicting,
      format('El pedido %s ya está conciliado.', v_conflicting);
  END IF;

  SELECT * INTO v_snap FROM public._cod_load_order_financial_snapshots(p_new_order_id);
  IF NOT FOUND OR v_snap.sent_date IS NULL THEN
    RAISE EXCEPTION 'matched_order_not_in_cod_universe order_id=%', p_new_order_id;
  END IF;

  v_expected_new := v_live_amount;
  v_reported := round(v_row.parsed_amount::numeric, 2);
  v_diff := round((v_reported - v_expected_new)::numeric, 2);

  -- Warnings forceables (paridad 286)
  IF v_snap.transport_id IS DISTINCT FROM v_rem.transport_id THEN
    v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
      'code', 'transport_mismatch',
      'message', 'Transporte efectivo distinto al de la rendición'
    ));
  END IF;

  IF v_row.parsed_transport_date IS NOT NULL THEN
    v_day_diff := abs(v_row.parsed_transport_date - v_snap.sent_date);
    IF v_day_diff > 3 THEN
      v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
        'code', 'date_far',
        'message', format('Fecha alejada (%s días)', v_day_diff),
        'day_diff', v_day_diff
      ));
    END IF;
  END IF;

  IF abs(v_diff) >= 0.005 THEN
    v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
      'code', 'amount_diff',
      'message', 'Monto informado distinto al esperado del pedido',
      'amount_diff', v_diff
    ));
  END IF;

  v_name_source := NULLIF(trim(COALESCE(p_matched_name_source, '')), '');
  v_matched_name := NULLIF(trim(COALESCE(p_matched_name_snapshot, '')), '');
  IF (v_name_source IS NULL) <> (v_matched_name IS NULL) THEN
    RAISE EXCEPTION 'matched_name_source_snapshot_mismatch';
  END IF;
  IF v_name_source IS NOT NULL THEN
    IF v_name_source NOT IN ('label', 'titular', 'sub_name') THEN
      RAISE EXCEPTION 'invalid_matched_name_source';
    END IF;
    v_name_ok := false;
    IF v_name_source = 'label' THEN
      v_name_ok := public._cod_normalize_match_name(v_matched_name)
                = public._cod_normalize_match_name(v_snap.label_name);
    ELSIF v_name_source = 'titular' THEN
      v_name_ok := public._cod_normalize_match_name(v_matched_name)
                = public._cod_normalize_match_name(v_snap.titular_name);
    ELSE
      SELECT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(v_snap.additional_names, '[]'::jsonb)) e
        WHERE public._cod_normalize_match_name(v_matched_name)
            = public._cod_normalize_match_name(
                COALESCE(
                  NULLIF(trim(e.value->>'full_name'), ''),
                  NULLIF(trim(COALESCE(e.value->>'first_name','') || ' ' || COALESCE(e.value->>'last_name','')), ''),
                  NULLIF(trim(e.value->>'name'), '')
                )
              )
      ) INTO v_name_ok;
    END IF;
    IF NOT COALESCE(v_name_ok, false) THEN
      v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
        'code', 'name_weak',
        'message', 'Nombre informado no coincide con la identidad declarada del pedido'
      ));
    END IF;
  ELSE
    v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
      'code', 'name_unverified',
      'message', 'Corrección sin validación explícita de nombre'
    ));
  END IF;

  IF jsonb_array_length(v_warnings) > 0 AND NOT COALESCE(p_force, false) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'needs_force',
      'warnings', v_warnings,
      'old_order_id', v_old_order_id,
      'new_order_id', p_new_order_id,
      'expected_amount', v_expected_new,
      'reported_amount', v_reported,
      'amount_diff', v_diff,
      'order_number', v_snap.order_number,
      'will_create_irregularity', abs(v_diff) >= 0.005
    );
  END IF;

  -- Superseder irregularidades activas del pedido A (open / in_review)
  FOR v_old_irreg IN
    SELECT *
    FROM public.cod_irregularities
    WHERE remittance_row_id = p_row_id
      AND order_id = v_old_order_id
      AND status IN ('open', 'in_review')
    FOR UPDATE
  LOOP
    UPDATE public.cod_irregularities SET
      status = 'superseded',
      superseded_reason = 'assignment_corrected',
      superseded_at = now(),
      superseded_by = v_uid,
      updated_at = now()
    WHERE id = v_old_irreg.id;

    v_superseded_ids := array_append(v_superseded_ids, v_old_irreg.id);
  END LOOP;

  IF cardinality(v_superseded_ids) > 0 THEN
    v_prev_state := v_prev_state || jsonb_build_object(
      'superseded_irregularity_ids', to_jsonb(v_superseded_ids),
      'superseded_reason', 'assignment_corrected'
    );
  END IF;

  IF abs(v_diff) < 0.005 THEN
    v_new_status := 'confirmed_matched';

    UPDATE public.cod_remittance_rows SET
      row_status = 'confirmed_matched',
      matched_order_id = p_new_order_id,
      assignment_method = 'manual',
      order_number_snapshot = v_snap.order_number,
      expected_amount_snapshot = v_expected_new,
      order_sent_date_snapshot = v_snap.sent_date,
      order_sent_date_origin = v_snap.sent_origin,
      transport_name_snapshot = v_snap.transport_name,
      matched_name_snapshot = v_matched_name,
      matched_name_source = v_name_source,
      transport_mismatch = (v_snap.transport_id IS DISTINCT FROM v_rem.transport_id),
      will_create_irregularity = false,
      matched_via_broadened_search = COALESCE(matched_via_broadened_search, false)
        OR (v_snap.transport_id IS DISTINCT FROM v_rem.transport_id),
      assigned_by = v_uid,
      assigned_at = now(),
      corrected_by = v_uid,
      corrected_at = now(),
      updated_at = now()
    WHERE id = p_row_id
      AND remittance_id = p_remittance_id
      AND matched_order_id = v_old_order_id
      AND row_status IN ('confirmed_matched', 'confirmed_with_irregularity');

    IF NOT FOUND THEN
      RAISE EXCEPTION 'row_update_failed_concurrently';
    END IF;
  ELSE
    v_new_status := 'confirmed_with_irregularity';
    v_diff_pct := CASE
      WHEN abs(v_expected_new) < 0.005 THEN NULL
      ELSE round((v_diff / abs(v_expected_new) * 100)::numeric, 3)
    END;

    UPDATE public.cod_remittance_rows SET
      row_status = 'confirmed_with_irregularity',
      matched_order_id = p_new_order_id,
      assignment_method = 'manual',
      order_number_snapshot = v_snap.order_number,
      expected_amount_snapshot = v_expected_new,
      order_sent_date_snapshot = v_snap.sent_date,
      order_sent_date_origin = v_snap.sent_origin,
      transport_name_snapshot = v_snap.transport_name,
      matched_name_snapshot = v_matched_name,
      matched_name_source = v_name_source,
      transport_mismatch = (v_snap.transport_id IS DISTINCT FROM v_rem.transport_id),
      will_create_irregularity = true,
      matched_via_broadened_search = COALESCE(matched_via_broadened_search, false)
        OR (v_snap.transport_id IS DISTINCT FROM v_rem.transport_id),
      assigned_by = v_uid,
      assigned_at = now(),
      corrected_by = v_uid,
      corrected_at = now(),
      updated_at = now()
    WHERE id = p_row_id
      AND remittance_id = p_remittance_id
      AND matched_order_id = v_old_order_id
      AND row_status IN ('confirmed_matched', 'confirmed_with_irregularity');

    IF NOT FOUND THEN
      RAISE EXCEPTION 'row_update_failed_concurrently';
    END IF;

    INSERT INTO public.cod_irregularities (
      remittance_row_id,
      order_id,
      remittance_id,
      transport_id,
      order_sent_date_snapshot,
      remittance_date_snapshot,
      expected_amount,
      reported_amount,
      amount_diff,
      amount_diff_pct,
      status,
      created_by
    ) VALUES (
      p_row_id,
      p_new_order_id,
      p_remittance_id,
      v_rem.transport_id,
      v_snap.sent_date,
      v_rem.remittance_date,
      v_expected_new,
      v_reported,
      v_diff,
      v_diff_pct,
      'open',
      v_uid
    )
    RETURNING id INTO v_new_irreg_id;

    INSERT INTO public.cod_reconciliation_events (
      remittance_id, remittance_row_id, irregularity_id, event_type, actor_id, new_state, reason
    ) VALUES (
      p_remittance_id,
      p_row_id,
      v_new_irreg_id,
      'irregularity_created',
      v_uid,
      jsonb_build_object(
        'amount_diff', v_diff,
        'expected_amount', v_expected_new,
        'reported_amount', v_reported,
        'order_id', p_new_order_id,
        'phase', '6c',
        'from_correction', true
      ),
      'Irregularidad creada al corregir asignación post-confirmación'
    );
  END IF;

  v_new_state := jsonb_build_object(
    'row_status', v_new_status,
    'new_order_id', p_new_order_id,
    'new_order_number', v_snap.order_number,
    'new_expected_amount', v_expected_new,
    'reported_amount', v_reported,
    'amount_diff', v_diff,
    'new_irregularity_id', v_new_irreg_id,
    'superseded_irregularity_ids', to_jsonb(v_superseded_ids),
    'financial_effect', true,
    'phase', '6c',
    'forced', COALESCE(p_force, false),
    'warnings', v_warnings
  );

  INSERT INTO public.cod_reconciliation_events (
    remittance_id, remittance_row_id, irregularity_id, event_type, actor_id,
    previous_state, new_state, reason
  ) VALUES (
    p_remittance_id,
    p_row_id,
    v_new_irreg_id,
    'assignment_corrected',
    v_uid,
    v_prev_state,
    v_new_state,
    v_reason
  );

  -- Cabecera: solo touch updated_at; status sigue confirmed
  UPDATE public.cod_remittances SET updated_at = now() WHERE id = p_remittance_id;

  RETURN jsonb_build_object(
    'ok', true,
    'remittance_id', p_remittance_id,
    'row_id', p_row_id,
    'old_order_id', v_old_order_id,
    'new_order_id', p_new_order_id,
    'row_status', v_new_status,
    'expected_amount', v_expected_new,
    'reported_amount', v_reported,
    'amount_diff', v_diff,
    'irregularity_id', v_new_irreg_id,
    'superseded_irregularity_ids', to_jsonb(v_superseded_ids),
    'warnings', v_warnings
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.rpc_cod_correct_confirmed_assignment(uuid, uuid, uuid, text, boolean, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_cod_correct_confirmed_assignment(uuid, uuid, uuid, text, boolean, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.rpc_cod_correct_confirmed_assignment(uuid, uuid, uuid, text, boolean, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cod_correct_confirmed_assignment(uuid, uuid, uuid, text, boolean, text, text) TO service_role;

COMMENT ON FUNCTION public.rpc_cod_correct_confirmed_assignment(uuid, uuid, uuid, text, boolean, text, text) IS
  'Fase 6C: corrige asignación confirmed A→B. Locks UUID-ordered + relectura post-lock. UPDATE defensivo FOUND. Supersede irreg open/in_review. Resolved intacta. No reabre cabecera. No muta orders.';

-- =============================================================================
-- 288 void remittance
-- =============================================================================

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
  v_reason text;
  v_lock_id uuid;
  v_order_ids uuid[] := ARRAY[]::uuid[];
  v_cnt_exact int := 0;
  v_cnt_irreg int := 0;
  v_cnt_unassigned int := 0;
  v_cnt_other int := 0;
  v_amt_reconciled numeric(14,2) := 0;
  v_irreg_open int := 0;
  v_irreg_review int := 0;
  v_irreg_resolved int := 0;
  v_irreg_superseded_prev int := 0;
  v_rows_voided int := 0;
  v_irregs_superseded int := 0;
  v_prev jsonb;
  v_new jsonb;
  v_row public.cod_remittance_rows%ROWTYPE;
  v_order_lock int;
  v_null_order_rows int := 0;
  v_expected_voided int := 0;
  v_rev int;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.has_permission(v_uid, 'conciliacion-reembolso', 'edit') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_remittance_id IS NULL THEN
    RAISE EXCEPTION 'params_required';
  END IF;

  v_reason := NULLIF(trim(COALESCE(p_reason, '')), '');
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'reason_required';
  END IF;

  -- 1) Lock cabecera
  SELECT * INTO v_rem
  FROM public.cod_remittances
  WHERE id = p_remittance_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'remittance_not_found'; END IF;
  IF v_rem.status = 'voided' THEN
    RAISE EXCEPTION 'remittance_already_voided';
  END IF;
  IF v_rem.status <> 'confirmed' THEN
    RAISE EXCEPTION 'remittance_not_confirmed status=%', v_rem.status;
  END IF;

  v_rev := COALESCE(v_rem.sheet_revision, 1);

  -- 2) Lock todas las filas (orden estable); mutaciones solo revisión actual
  PERFORM 1
  FROM public.cod_remittance_rows
  WHERE remittance_id = p_remittance_id
  ORDER BY id
  FOR UPDATE;

  -- Conteos / montos pre-void (para evento)
  SELECT
    count(*) FILTER (WHERE row_status = 'confirmed_matched'),
    count(*) FILTER (WHERE row_status = 'confirmed_with_irregularity'),
    count(*) FILTER (WHERE row_status = 'unassigned'),
    count(*) FILTER (
      WHERE row_status NOT IN (
        'confirmed_matched', 'confirmed_with_irregularity', 'unassigned'
      )
    ),
    coalesce(sum(COALESCE(expected_amount_snapshot, parsed_amount, 0)) FILTER (
      WHERE row_status IN ('confirmed_matched', 'confirmed_with_irregularity')
    ), 0)
  INTO
    v_cnt_exact,
    v_cnt_irreg,
    v_cnt_unassigned,
    v_cnt_other,
    v_amt_reconciled
  FROM public.cod_remittance_rows
  WHERE remittance_id = p_remittance_id
    AND sheet_revision = v_rev;

  -- Solo confirmed_* + unassigned son estados válidos en una remittance confirmed.
  IF v_cnt_other > 0 THEN
    RAISE EXCEPTION 'remittance_has_unexpected_row_states other_count=%', v_cnt_other;
  END IF;

  -- confirmed_* sin pedido = corrupción / estado inválido → abortar
  SELECT count(*)
  INTO v_null_order_rows
  FROM public.cod_remittance_rows
  WHERE remittance_id = p_remittance_id
    AND sheet_revision = v_rev
    AND row_status IN ('confirmed_matched', 'confirmed_with_irregularity')
    AND matched_order_id IS NULL;

  IF v_null_order_rows > 0 THEN
    RAISE EXCEPTION 'confirmed_row_missing_order count=%', v_null_order_rows;
  END IF;

  -- Pedidos a liberar (confirmed_*)
  SELECT coalesce(array_agg(x ORDER BY x), ARRAY[]::uuid[])
  INTO v_order_ids
  FROM (
    SELECT DISTINCT matched_order_id AS x
    FROM public.cod_remittance_rows
    WHERE remittance_id = p_remittance_id
      AND sheet_revision = v_rev
      AND row_status IN ('confirmed_matched', 'confirmed_with_irregularity')
      AND matched_order_id IS NOT NULL
  ) s;

  -- 3) Lock orders en UUID ASC (anti-deadlock); order faltante → rollback
  FOR v_lock_id IN
    SELECT x FROM unnest(v_order_ids) AS t(x) ORDER BY 1
  LOOP
    SELECT 1 INTO v_order_lock
    FROM public.orders
    WHERE id = v_lock_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'matched_order_missing order_id=%', v_lock_id;
    END IF;
  END LOOP;

  -- Revalidar cabecera post-lock
  SELECT * INTO v_rem
  FROM public.cod_remittances
  WHERE id = p_remittance_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'remittance_not_found'; END IF;
  IF v_rem.status = 'voided' THEN
    RAISE EXCEPTION 'remittance_already_voided';
  END IF;
  IF v_rem.status <> 'confirmed' THEN
    RAISE EXCEPTION 'remittance_state_changed_concurrently status=%', v_rem.status;
  END IF;

  v_rev := COALESCE(v_rem.sheet_revision, 1);

  -- Revalidar filas a liberar: únicamente confirmed_* (void ya no es aceptable)
  FOR v_row IN
    SELECT *
    FROM public.cod_remittance_rows
    WHERE remittance_id = p_remittance_id
      AND sheet_revision = v_rev
      AND matched_order_id = ANY (v_order_ids)
    FOR UPDATE
  LOOP
    IF v_row.row_status NOT IN ('confirmed_matched', 'confirmed_with_irregularity') THEN
      RAISE EXCEPTION 'row_state_changed_concurrently row_id=% status=%', v_row.id, v_row.row_status;
    END IF;
  END LOOP;

  -- Irregularidades: conteos prev + supersede activas
  SELECT
    count(*) FILTER (WHERE status = 'open'),
    count(*) FILTER (WHERE status = 'in_review'),
    count(*) FILTER (WHERE status = 'resolved'),
    count(*) FILTER (WHERE status = 'superseded')
  INTO
    v_irreg_open,
    v_irreg_review,
    v_irreg_resolved,
    v_irreg_superseded_prev
  FROM public.cod_irregularities
  WHERE remittance_id = p_remittance_id;

  UPDATE public.cod_irregularities SET
    status = 'superseded',
    superseded_reason = 'remittance_voided',
    superseded_at = now(),
    superseded_by = v_uid,
    updated_at = now()
  WHERE remittance_id = p_remittance_id
    AND status IN ('open', 'in_review');

  GET DIAGNOSTICS v_irregs_superseded = ROW_COUNT;

  -- Filas confirmed_* → void (conserva matched_order_id + snapshots)
  UPDATE public.cod_remittance_rows SET
    row_status = 'void',
    updated_at = now()
  WHERE remittance_id = p_remittance_id
    AND sheet_revision = v_rev
    AND row_status IN ('confirmed_matched', 'confirmed_with_irregularity');

  GET DIAGNOSTICS v_rows_voided = ROW_COUNT;

  v_expected_voided := v_cnt_exact + v_cnt_irreg;
  IF v_rows_voided <> v_expected_voided THEN
    RAISE EXCEPTION 'row_void_count_mismatch expected=% got=%',
      v_expected_voided, v_rows_voided;
  END IF;

  -- Cabecera → voided
  UPDATE public.cod_remittances SET
    status = 'voided',
    voided_by = v_uid,
    voided_at = now(),
    void_reason = v_reason,
    updated_at = now()
  WHERE id = p_remittance_id
    AND status = 'confirmed';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'remittance_void_failed_concurrently';
  END IF;

  v_prev := jsonb_build_object(
    'status', 'confirmed',
    'confirmed_at', v_rem.confirmed_at,
    'confirmed_by', v_rem.confirmed_by,
    'confirmed_matched_count', v_cnt_exact,
    'confirmed_with_irregularity_count', v_cnt_irreg,
    'unassigned_count', v_cnt_unassigned,
    'other_row_count', v_cnt_other,
    'reconciled_amount_snapshot_sum', v_amt_reconciled,
    'irregularities_open', v_irreg_open,
    'irregularities_in_review', v_irreg_review,
    'irregularities_resolved', v_irreg_resolved,
    'irregularities_superseded_already', v_irreg_superseded_prev,
    'orders_to_release_count', coalesce(cardinality(v_order_ids), 0)
  );

  v_new := jsonb_build_object(
    'status', 'voided',
    'voided_at', now(),
    'voided_by', v_uid,
    'rows_voided', v_rows_voided,
    'irregularities_superseded', v_irregs_superseded,
    'orders_returned_to_pending', coalesce(cardinality(v_order_ids), 0),
    'unassigned_left_as_is', v_cnt_unassigned,
    'resolved_kept_intact', v_irreg_resolved,
    'phase', '6d',
    'financial_effect', true
  );

  INSERT INTO public.cod_reconciliation_events (
    remittance_id, event_type, actor_id, previous_state, new_state, reason
  ) VALUES (
    p_remittance_id,
    'remittance_voided',
    v_uid,
    v_prev,
    v_new,
    v_reason
  );

  RETURN jsonb_build_object(
    'ok', true,
    'remittance_id', p_remittance_id,
    'status', 'voided',
    'rows_voided', v_rows_voided,
    'irregularities_superseded', v_irregs_superseded,
    'orders_returned_to_pending', coalesce(cardinality(v_order_ids), 0),
    'unassigned_left_as_is', v_cnt_unassigned,
    'resolved_kept_intact', v_irreg_resolved
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.rpc_cod_void_confirmed_remittance(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_cod_void_confirmed_remittance(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.rpc_cod_void_confirmed_remittance(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cod_void_confirmed_remittance(uuid, text) TO service_role;

COMMENT ON FUNCTION public.rpc_cod_void_confirmed_remittance(uuid, text) IS
  'Fase 6D: anula rendición confirmed → voided. Filas confirmed_* → void (snapshots intactos). Irreg open/in_review → superseded remittance_voided. Resolved intactas. Locks UUID-ordered. No DELETE. No muta orders/aliases.';
