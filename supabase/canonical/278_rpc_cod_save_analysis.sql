-- 278_rpc_cod_save_analysis.sql
--
-- Fase 4 — Persistir análisis de matching COD (batch).
-- NO crea irregularidades. NO confirma pagos. NO muta orders.
--
-- ESTADO: preparada localmente. NO aplicar en producción sin autorización explícita.
--
-- Firma:
--   public.rpc_cod_save_analysis(
--     p_remittance_id uuid,
--     p_rows jsonb,
--     p_summary jsonb DEFAULT NULL
--   ) RETURNS jsonb
--
-- Snapshots FINANCIEROS / de pedido (fuente de verdad = DB, NUNCA JSON):
--   order_number_snapshot, expected_amount_snapshot,
--   order_sent_date_snapshot, order_sent_date_origin, transport_name_snapshot
--   → siempre recalculados server-side desde orders (+ customers/transports).
--   Si el cliente envía valores distintos, se IGNORAN (no se confían).
--
-- Metadata explicativa NO financiera (algoritmo TS; Fase 5 NO debe usarlas para $):
--   matched_name_snapshot, matched_name_source
--   → se persisten tras validación razonable (label/titular/sub_name).
--
-- Reanálisis: rechaza si hay filas approved_pending_confirmation o confirmed_*/void.
--
-- Retorno: { ok, remittance_id, analyzed_at, counts }

-- Normalización básica de nombres para validar matched_name_* (no es fuzzy matching).
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

  SELECT r.status INTO v_status
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
  IF EXISTS (
    SELECT 1
    FROM public.cod_remittance_rows r
    WHERE r.remittance_id = p_remittance_id
      AND r.row_status = 'approved_pending_confirmation'
  ) THEN
    RAISE EXCEPTION 'remittance_has_approved_rows';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.cod_remittance_rows r
    WHERE r.remittance_id = p_remittance_id
      AND r.row_status IN ('confirmed_matched', 'confirmed_with_irregularity', 'void')
  ) THEN
    RAISE EXCEPTION 'remittance_has_non_analyzable_rows';
  END IF;

  -- Defensa: solo estados de análisis en todas las filas actuales
  IF EXISTS (
    SELECT 1
    FROM public.cod_remittance_rows r
    WHERE r.remittance_id = p_remittance_id
      AND r.row_status NOT IN (
        'pending_analysis', 'auto_matched', 'needs_review', 'unassigned'
      )
  ) THEN
    RAISE EXCEPTION 'remittance_rows_not_reanalyzable';
  END IF;

  v_payload_rows := jsonb_array_length(p_rows);

  SELECT count(*)::int INTO v_expected_rows
  FROM public.cod_remittance_rows
  WHERE remittance_id = p_remittance_id;

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

  -- Cobertura 1:1: todo row_id del payload pertenece a la remesa
  -- y toda fila real de la remesa aparece en el payload.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_rows) AS e
    WHERE NULLIF(trim(e.value->>'row_id'), '') IS NULL
       OR (e.value->>'row_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR NOT EXISTS (
            SELECT 1
            FROM public.cod_remittance_rows r
            WHERE r.id = (e.value->>'row_id')::uuid
              AND r.remittance_id = p_remittance_id
          )
  ) THEN
    RAISE EXCEPTION 'row_not_in_remittance_or_invalid_id';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.cod_remittance_rows r
    WHERE r.remittance_id = p_remittance_id
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
      WHERE id = v_row_id AND remittance_id = p_remittance_id
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
      AND remittance_id = p_remittance_id;

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
