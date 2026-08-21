-- 275_rpc_cod_create_remittance.sql
--
-- Fase 3 — Crear rendición COD en estado draft + filas batch.
-- Escritura SOLO vía esta RPC (sin policies INSERT en tablas cod_*).
--
-- HISTÓRICA / INMUTABLE en producción (aplicada 2026-08-20).
-- Esta versión ORIGINAL confiaba en parsed_* del cliente.
-- El parche de seguridad vive en 276_rpc_cod_create_remittance_security_fix.sql.
--
-- Firma:
--   public.rpc_cod_create_remittance(
--     p_transport_id uuid,
--     p_remittance_date date,
--     p_reported_total numeric,
--     p_content_hash text,
--     p_rows jsonb,
--     p_notes text DEFAULT NULL
--   ) RETURNS jsonb
--
-- p_rows: array de objetos
--   {
--     "row_index": int,
--     "raw_line": text,
--     "raw_transport_date_text": text,
--     "raw_customer_name_text": text,
--     "raw_amount_text": text,
--     "parsed_transport_date": "YYYY-MM-DD",
--     "parsed_amount": number
--   }
--
-- Retorno: { "ok": true, "remittance_id": uuid, "row_count": int, "calculated_total": numeric }
-- o RAISE EXCEPTION ante error (transacción completa revertida).

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
  v_calc_total numeric(12,2) := 0;
  v_row_count int := 0;
  v_seen_indexes int[] := ARRAY[]::int[];
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

  -- Validar todas las filas antes de insertar cabecera (fail-fast, sin huérfanos).
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
      v_parsed_date := (v_row ->> 'parsed_transport_date')::date;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'Fila %: fecha parseada inválida', v_idx;
    END;

    IF v_parsed_date IS NULL THEN
      RAISE EXCEPTION 'Fila %: fecha parseada requerida', v_idx;
    END IF;

    BEGIN
      v_parsed_amount := round((v_row ->> 'parsed_amount')::numeric, 2);
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'Fila %: monto parseado inválido', v_idx;
    END;

    IF v_parsed_amount IS NULL OR v_parsed_amount < 0 THEN
      RAISE EXCEPTION 'Fila %: monto parseado inválido', v_idx;
    END IF;

    v_calc_total := v_calc_total + v_parsed_amount;
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
    v_row := p_rows -> v_idx;

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
      COALESCE((v_row ->> 'row_index')::int, v_idx),
      nullif(v_row ->> 'raw_line', ''),
      trim(v_row ->> 'raw_transport_date_text'),
      trim(v_row ->> 'raw_customer_name_text'),
      trim(v_row ->> 'raw_amount_text'),
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
GRANT EXECUTE ON FUNCTION public.rpc_cod_create_remittance(uuid, date, numeric, text, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cod_create_remittance(uuid, date, numeric, text, jsonb, text) TO service_role;

COMMENT ON FUNCTION public.rpc_cod_create_remittance(uuid, date, numeric, text, jsonb, text) IS
  'Crea rendición COD draft + filas en una transacción. Requiere has_permission(conciliacion-reembolso, edit).';
