-- 276_rpc_cod_create_remittance_security_fix.sql
--
-- Parche de seguridad sobre rpc_cod_create_remittance (migración 275).
-- NO reescribe 272–275. Solo:
--   - helpers privados de parsing DD/MM/YYYY y monto AR
--   - CREATE OR REPLACE de rpc_cod_create_remittance (reparse desde raw_*)
--   - coherencia obligatoria raw vs parsed_* del cliente
--   - REVOKE EXECUTE FROM anon / PUBLIC
--   - void auditable de drafts de prueba cohA–D
--
-- Autorizado para producción 2026-08-20.

-- ---------------------------------------------------------------------------
-- Helpers internos (no GRANT a clients)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._cod_parse_remittance_date(p_raw text)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v text := trim(COALESCE(p_raw, ''));
  v_day int;
  v_month int;
  v_year int;
  v_date date;
BEGIN
  IF v = '' THEN
    RAISE EXCEPTION 'Fecha vacía';
  END IF;

  -- Rechazar ISO / guiones / formatos ambiguos estilo US.
  IF v ~ '^\d{4}-\d{2}-\d{2}' OR position('-' in v) > 0 THEN
    RAISE EXCEPTION 'Usar DD/MM/YYYY (no ISO ni guiones)';
  END IF;

  IF v !~ '^\d{1,2}/\d{1,2}/\d{4}$' THEN
    RAISE EXCEPTION 'Fecha inválida (usar DD/MM/YYYY)';
  END IF;

  v_day := split_part(v, '/', 1)::int;
  v_month := split_part(v, '/', 2)::int;
  v_year := split_part(v, '/', 3)::int;

  IF v_month < 1 OR v_month > 12 OR v_day < 1 OR v_day > 31 OR v_year < 2000 OR v_year > 2100 THEN
    RAISE EXCEPTION 'Fecha fuera de rango';
  END IF;

  BEGIN
    v_date := make_date(v_year, v_month, v_day);
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'Fecha inexistente';
  END;

  RETURN v_date;
END;
$fn$;

CREATE OR REPLACE FUNCTION public._cod_parse_remittance_amount(p_raw text)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v text := trim(COALESCE(p_raw, ''));
  v_int text;
  v_dec text;
  v_parts text[];
  n numeric;
BEGIN
  IF v = '' THEN
    RAISE EXCEPTION 'Monto vacío';
  END IF;

  v := regexp_replace(v, '\s+', '', 'g');
  IF left(v, 1) = '$' THEN
    v := substr(v, 2);
  END IF;

  IF v = '' THEN
    RAISE EXCEPTION 'Monto vacío';
  END IF;

  IF v ~ '[^0-9.,]' THEN
    RAISE EXCEPTION 'Monto inválido';
  END IF;

  IF position(',' in v) > 0 THEN
    v_parts := string_to_array(v, ',');
    IF array_length(v_parts, 1) <> 2 THEN
      RAISE EXCEPTION 'Monto inválido';
    END IF;
    v_int := replace(v_parts[1], '.', '');
    v_dec := v_parts[2];
    IF v_int !~ '^\d+$' OR v_dec !~ '^\d{1,2}$' THEN
      RAISE EXCEPTION 'Monto inválido';
    END IF;
    n := (v_int || '.' || v_dec)::numeric;
  ELSIF position('.' in v) > 0 THEN
    v_parts := string_to_array(v, '.');
    -- miles AR: 152.000 / 1.152.000
    IF array_length(v_parts, 1) >= 2
       AND v_parts[1] ~ '^\d{1,3}$'
       AND (
         SELECT bool_and(p ~ '^\d{3}$')
         FROM unnest(v_parts[2:array_length(v_parts, 1)]) AS p
       )
    THEN
      n := replace(v, '.', '')::numeric;
    ELSIF array_length(v_parts, 1) = 2
          AND v_parts[1] ~ '^\d+$'
          AND v_parts[2] ~ '^\d{1,2}$'
    THEN
      n := (v_parts[1] || '.' || v_parts[2])::numeric;
    ELSE
      RAISE EXCEPTION 'Monto inválido';
    END IF;
  ELSE
    IF v !~ '^\d+$' THEN
      RAISE EXCEPTION 'Monto inválido';
    END IF;
    n := v::numeric;
  END IF;

  IF n IS NULL OR n < 0 THEN
    RAISE EXCEPTION 'Monto inválido';
  END IF;

  RETURN round(n, 2);
END;
$fn$;

REVOKE ALL ON FUNCTION public._cod_parse_remittance_date(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._cod_parse_remittance_date(text) FROM anon;
REVOKE ALL ON FUNCTION public._cod_parse_remittance_date(text) FROM authenticated;
REVOKE ALL ON FUNCTION public._cod_parse_remittance_amount(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._cod_parse_remittance_amount(text) FROM anon;
REVOKE ALL ON FUNCTION public._cod_parse_remittance_amount(text) FROM authenticated;

-- ---------------------------------------------------------------------------
-- RPC corregida: raw_* = fuente de verdad; parsed_* solo coherencia
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rpc_cod_create_remittance(
  p_transport_id uuid,
  p_remittance_date date,
  p_reported_total numeric,
  p_content_hash text,
  p_rows jsonb,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_remittance_id uuid;
  v_row jsonb;
  v_idx int;
  v_raw_line text;
  v_raw_date text;
  v_raw_name text;
  v_raw_amount text;
  v_parsed_date date;
  v_parsed_amount numeric(12,2);
  v_client_date date;
  v_client_amount numeric(12,2);
  v_calc_total numeric(12,2) := 0;
  v_row_count int := 0;
  v_seen_indexes int[] := ARRAY[]::int[];
  v_norm jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  IF NOT public.has_permission(v_uid, 'conciliacion-reembolso', 'edit') THEN
    RAISE EXCEPTION 'No tenés permiso para crear rendiciones';
  END IF;

  IF p_transport_id IS NULL THEN
    RAISE EXCEPTION 'Transporte requerido';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.transports t WHERE t.id = p_transport_id) THEN
    RAISE EXCEPTION 'Transporte inexistente';
  END IF;

  IF p_remittance_date IS NULL THEN
    RAISE EXCEPTION 'Fecha de rendición requerida';
  END IF;

  IF p_reported_total IS NULL OR p_reported_total < 0 THEN
    RAISE EXCEPTION 'Total informado inválido';
  END IF;

  IF p_content_hash IS NULL OR length(trim(p_content_hash)) < 16 THEN
    RAISE EXCEPTION 'content_hash inválido';
  END IF;

  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'Filas inválidas';
  END IF;

  v_row_count := jsonb_array_length(p_rows);
  IF v_row_count < 1 THEN
    RAISE EXCEPTION 'La rendición no puede estar vacía';
  END IF;

  IF v_row_count > 2000 THEN
    RAISE EXCEPTION 'Demasiadas filas (máximo 2000)';
  END IF;

  FOR v_idx IN 0 .. v_row_count - 1 LOOP
    v_row := p_rows -> v_idx;

    IF v_row IS NULL OR jsonb_typeof(v_row) <> 'object' THEN
      RAISE EXCEPTION 'Fila % inválida', v_idx;
    END IF;

    IF (v_row ? 'row_index') THEN
      IF (v_row ->> 'row_index')::int = ANY (v_seen_indexes) THEN
        RAISE EXCEPTION 'row_index duplicado: %', v_row ->> 'row_index';
      END IF;
      v_seen_indexes := array_append(v_seen_indexes, (v_row ->> 'row_index')::int);
    END IF;

    v_raw_date := nullif(trim(COALESCE(v_row ->> 'raw_transport_date_text', '')), '');
    v_raw_name := nullif(trim(COALESCE(v_row ->> 'raw_customer_name_text', '')), '');
    v_raw_amount := nullif(trim(COALESCE(v_row ->> 'raw_amount_text', '')), '');
    v_raw_line := nullif(v_row ->> 'raw_line', '');

    IF v_raw_date IS NULL OR v_raw_name IS NULL OR v_raw_amount IS NULL THEN
      RAISE EXCEPTION 'Fila %: faltan campos raw obligatorios', v_idx;
    END IF;

    BEGIN
      v_parsed_date := public._cod_parse_remittance_date(v_raw_date);
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'Fila %: fecha raw inválida (%)', v_idx, SQLERRM;
    END;

    BEGIN
      v_parsed_amount := public._cod_parse_remittance_amount(v_raw_amount);
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'Fila %: monto raw inválido (%)', v_idx, SQLERRM;
    END;

    -- Coherencia adicional: si el cliente envió parsed_*, deben coincidir.
    IF nullif(trim(COALESCE(v_row ->> 'parsed_transport_date', '')), '') IS NOT NULL THEN
      BEGIN
        v_client_date := (v_row ->> 'parsed_transport_date')::date;
      EXCEPTION WHEN others THEN
        RAISE EXCEPTION 'Fila %: fecha parseada inválida', v_idx;
      END;
      IF v_client_date IS DISTINCT FROM v_parsed_date THEN
        RAISE EXCEPTION 'Fila %: parsed_transport_date no coincide con raw', v_idx;
      END IF;
    END IF;

    IF v_row ? 'parsed_amount' AND v_row ->> 'parsed_amount' IS NOT NULL THEN
      BEGIN
        v_client_amount := round((v_row ->> 'parsed_amount')::numeric, 2);
      EXCEPTION WHEN others THEN
        RAISE EXCEPTION 'Fila %: monto parseado inválido', v_idx;
      END;
      IF v_client_amount IS DISTINCT FROM v_parsed_amount THEN
        RAISE EXCEPTION 'Fila %: parsed_amount no coincide con raw', v_idx;
      END IF;
    END IF;

    v_calc_total := v_calc_total + v_parsed_amount;

    v_norm := v_norm || jsonb_build_array(jsonb_build_object(
      'row_index', COALESCE((v_row ->> 'row_index')::int, v_idx),
      'raw_line', v_raw_line,
      'raw_transport_date_text', v_raw_date,
      'raw_customer_name_text', v_raw_name,
      'raw_amount_text', v_raw_amount,
      'parsed_transport_date', to_char(v_parsed_date, 'YYYY-MM-DD'),
      'parsed_amount', v_parsed_amount
    ));
  END LOOP;

  v_calc_total := round(v_calc_total, 2);

  INSERT INTO public.cod_remittances (
    transport_id,
    remittance_date,
    reported_total,
    calculated_total,
    row_count,
    status,
    content_hash,
    notes,
    created_by
  ) VALUES (
    p_transport_id,
    p_remittance_date,
    round(p_reported_total, 2),
    v_calc_total,
    v_row_count,
    'draft',
    trim(p_content_hash),
    nullif(trim(COALESCE(p_notes, '')), ''),
    v_uid
  )
  RETURNING id INTO v_remittance_id;

  FOR v_idx IN 0 .. v_row_count - 1 LOOP
    v_row := v_norm -> v_idx;

    INSERT INTO public.cod_remittance_rows (
      remittance_id,
      row_index,
      raw_line,
      raw_transport_date_text,
      raw_customer_name_text,
      raw_amount_text,
      parsed_transport_date,
      parsed_amount,
      parse_errors,
      row_status
    ) VALUES (
      v_remittance_id,
      (v_row ->> 'row_index')::int,
      nullif(v_row ->> 'raw_line', ''),
      v_row ->> 'raw_transport_date_text',
      v_row ->> 'raw_customer_name_text',
      v_row ->> 'raw_amount_text',
      (v_row ->> 'parsed_transport_date')::date,
      round((v_row ->> 'parsed_amount')::numeric, 2),
      '[]'::jsonb,
      'pending_analysis'
    );
  END LOOP;

  INSERT INTO public.cod_reconciliation_events (
    remittance_id,
    event_type,
    actor_id,
    new_state,
    reason
  ) VALUES (
    v_remittance_id,
    'remittance_created',
    v_uid,
    jsonb_build_object(
      'status', 'draft',
      'row_count', v_row_count,
      'reported_total', round(p_reported_total, 2),
      'calculated_total', v_calc_total,
      'content_hash', trim(p_content_hash)
    ),
    'Creación de rendición en borrador'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'remittance_id', v_remittance_id,
    'row_count', v_row_count,
    'calculated_total', v_calc_total
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.rpc_cod_create_remittance(uuid, date, numeric, text, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_cod_create_remittance(uuid, date, numeric, text, jsonb, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.rpc_cod_create_remittance(uuid, date, numeric, text, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cod_create_remittance(uuid, date, numeric, text, jsonb, text) TO service_role;

COMMENT ON FUNCTION public.rpc_cod_create_remittance(uuid, date, numeric, text, jsonb, text) IS
  'Crea rendición COD draft + filas. Reparsea fecha/monto desde raw_*. Requiere has_permission(conciliacion-reembolso, edit).';

-- ---------------------------------------------------------------------------
-- Limpieza auditable drafts cohA–D (sin DELETE; conserva raw_*)
-- ---------------------------------------------------------------------------

DO $cleanup$
DECLARE
  v_ids uuid[] := ARRAY[
    'd9fcbc9f-6c32-43d3-8b0f-0669fa724d66'::uuid,
    'c5396e3b-9d7a-4c6f-b0cb-d1e8436b0774'::uuid,
    'db6611f9-89d1-4d03-a357-2c360aa75bfa'::uuid,
    'a3aaa733-ebf9-4644-94f1-7c5f4f17e2fd'::uuid
  ];
  v_reason text := 'Security test draft created during RPC validation';
  r record;
BEGIN
  FOR r IN
    SELECT id, status, created_by, notes
    FROM public.cod_remittances
    WHERE id = ANY (v_ids)
  LOOP
    IF r.status = 'voided' THEN
      CONTINUE;
    END IF;

    UPDATE public.cod_remittances
    SET
      status = 'voided',
      void_reason = v_reason,
      voided_at = now(),
      voided_by = r.created_by,
      notes = CASE
        WHEN nullif(trim(COALESCE(r.notes, '')), '') IS NULL THEN v_reason
        WHEN position(v_reason in r.notes) > 0 THEN r.notes
        ELSE r.notes || E'\n' || v_reason
      END,
      updated_at = now()
    WHERE id = r.id;

    INSERT INTO public.cod_reconciliation_events (
      remittance_id,
      event_type,
      actor_id,
      previous_state,
      new_state,
      reason
    ) VALUES (
      r.id,
      'remittance_voided',
      r.created_by,
      jsonb_build_object('status', r.status),
      jsonb_build_object('status', 'voided', 'void_reason', v_reason),
      v_reason
    );
  END LOOP;
END;
$cleanup$;
