-- 283_rpc_cod_transport_customer_aliases.sql
--
-- RPCs SECURITY DEFINER para aliases por transporte.
-- NO mutan orders ni estados financieros COD (confirmed_*/irregularities).
-- NO modifican 279/280.
--
-- Normalización: public._cod_normalize_match_name (278) — paridad con TS normalizeCodAliasName.

-- ---------------------------------------------------------------------------
-- Helper: insertar evento de alias (remittance_id puede ser NULL)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._cod_insert_alias_event(
  p_event_type text,
  p_actor_id uuid,
  p_remittance_id uuid,
  p_remittance_row_id uuid,
  p_previous_state jsonb,
  p_new_state jsonb,
  p_reason text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
BEGIN
  INSERT INTO public.cod_reconciliation_events (
    remittance_id,
    remittance_row_id,
    irregularity_id,
    event_type,
    actor_id,
    occurred_at,
    previous_state,
    new_state,
    reason
  ) VALUES (
    p_remittance_id,
    p_remittance_row_id,
    NULL,
    p_event_type,
    p_actor_id,
    now(),
    p_previous_state,
    p_new_state,
    p_reason
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public._cod_insert_alias_event(text, uuid, uuid, uuid, jsonb, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._cod_insert_alias_event(text, uuid, uuid, uuid, jsonb, jsonb, text) FROM anon;
REVOKE ALL ON FUNCTION public._cod_insert_alias_event(text, uuid, uuid, uuid, jsonb, jsonb, text) FROM authenticated;

-- ---------------------------------------------------------------------------
-- 1) remember
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_cod_remember_transport_alias(
  p_transport_id uuid,
  p_customer_id uuid,
  p_raw_alias text,
  p_source_remittance_row_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_norm text;
  v_raw text;
  v_row public.cod_transport_customer_aliases%ROWTYPE;
  v_remittance_id uuid;
  v_source_transport uuid;
  v_event text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.has_permission(v_uid, 'conciliacion-reembolso', 'edit') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_transport_id IS NULL OR p_customer_id IS NULL THEN
    RAISE EXCEPTION 'params_required';
  END IF;

  v_raw := trim(COALESCE(p_raw_alias, ''));
  IF v_raw = '' THEN RAISE EXCEPTION 'raw_alias_empty'; END IF;

  v_norm := public._cod_normalize_match_name(v_raw);
  IF v_norm IS NULL OR v_norm = '' THEN
    RAISE EXCEPTION 'normalized_alias_empty';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.transports WHERE id = p_transport_id) THEN
    RAISE EXCEPTION 'transport_not_found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.customers WHERE id = p_customer_id) THEN
    RAISE EXCEPTION 'customer_not_found';
  END IF;

  v_remittance_id := NULL;
  IF p_source_remittance_row_id IS NOT NULL THEN
    SELECT r.remittance_id, rem.transport_id
      INTO v_remittance_id, v_source_transport
    FROM public.cod_remittance_rows r
    JOIN public.cod_remittances rem ON rem.id = r.remittance_id
    WHERE r.id = p_source_remittance_row_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'source_row_not_found';
    END IF;
    IF v_source_transport IS DISTINCT FROM p_transport_id THEN
      RAISE EXCEPTION 'source_row_transport_mismatch';
    END IF;
  END IF;

  SELECT * INTO v_row
  FROM public.cod_transport_customer_aliases
  WHERE transport_id = p_transport_id
    AND normalized_alias = v_norm
  FOR UPDATE;

  IF FOUND THEN
    IF v_row.customer_id IS DISTINCT FROM p_customer_id THEN
      RETURN jsonb_build_object(
        'ok', false,
        'code', 'alias_conflict',
        'message', 'Este nombre ya está vinculado a otro cliente en este transporte.',
        'alias_id', v_row.id,
        'existing_customer_id', v_row.customer_id,
        'requested_customer_id', p_customer_id
      );
    END IF;

    -- Mismo customer: idempotente o reactivar
    IF v_row.is_active THEN
      UPDATE public.cod_transport_customer_aliases SET
        raw_alias = v_raw,
        notes = COALESCE(p_notes, notes),
        source_remittance_row_id = COALESCE(p_source_remittance_row_id, source_remittance_row_id),
        updated_by = v_uid,
        updated_at = now()
      WHERE id = v_row.id
      RETURNING * INTO v_row;

      RETURN jsonb_build_object(
        'ok', true,
        'code', 'idempotent',
        'alias_id', v_row.id,
        'transport_id', v_row.transport_id,
        'customer_id', v_row.customer_id,
        'raw_alias', v_row.raw_alias,
        'normalized_alias', v_row.normalized_alias,
        'is_active', v_row.is_active
      );
    END IF;

    UPDATE public.cod_transport_customer_aliases SET
      is_active = true,
      raw_alias = v_raw,
      notes = COALESCE(p_notes, notes),
      source_remittance_row_id = COALESCE(p_source_remittance_row_id, source_remittance_row_id),
      updated_by = v_uid,
      updated_at = now()
    WHERE id = v_row.id
    RETURNING * INTO v_row;

    v_event := 'alias_reactivated';
    PERFORM public._cod_insert_alias_event(
      v_event,
      v_uid,
      v_remittance_id,
      p_source_remittance_row_id,
      jsonb_build_object(
        'alias_id', v_row.id,
        'transport_id', v_row.transport_id,
        'normalized_alias', v_row.normalized_alias,
        'customer_id', v_row.customer_id,
        'is_active', false
      ),
      jsonb_build_object(
        'alias_id', v_row.id,
        'transport_id', v_row.transport_id,
        'normalized_alias', v_row.normalized_alias,
        'customer_id', v_row.customer_id,
        'raw_alias', v_row.raw_alias,
        'is_active', true
      ),
      'reactivated_same_customer'
    );

    RETURN jsonb_build_object(
      'ok', true,
      'code', 'reactivated',
      'alias_id', v_row.id,
      'transport_id', v_row.transport_id,
      'customer_id', v_row.customer_id,
      'raw_alias', v_row.raw_alias,
      'normalized_alias', v_row.normalized_alias,
      'is_active', true
    );
  END IF;

  INSERT INTO public.cod_transport_customer_aliases (
    transport_id,
    customer_id,
    raw_alias,
    normalized_alias,
    is_active,
    source_remittance_row_id,
    notes,
    created_by,
    updated_by
  ) VALUES (
    p_transport_id,
    p_customer_id,
    v_raw,
    v_norm,
    true,
    p_source_remittance_row_id,
    p_notes,
    v_uid,
    v_uid
  )
  RETURNING * INTO v_row;

  PERFORM public._cod_insert_alias_event(
    'alias_created',
    v_uid,
    v_remittance_id,
    p_source_remittance_row_id,
    NULL,
    jsonb_build_object(
      'alias_id', v_row.id,
      'transport_id', v_row.transport_id,
      'customer_id', v_row.customer_id,
      'raw_alias', v_row.raw_alias,
      'normalized_alias', v_row.normalized_alias,
      'is_active', true
    ),
    NULL
  );

  RETURN jsonb_build_object(
    'ok', true,
    'code', 'created',
    'alias_id', v_row.id,
    'transport_id', v_row.transport_id,
    'customer_id', v_row.customer_id,
    'raw_alias', v_row.raw_alias,
    'normalized_alias', v_row.normalized_alias,
    'is_active', true
  );
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 2) deactivate (soft)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_cod_set_transport_alias_active(
  p_alias_id uuid,
  p_is_active boolean,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.cod_transport_customer_aliases%ROWTYPE;
  v_prev boolean;
  v_event text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.has_permission(v_uid, 'conciliacion-reembolso', 'edit') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_alias_id IS NULL OR p_is_active IS NULL THEN
    RAISE EXCEPTION 'params_required';
  END IF;

  SELECT * INTO v_row
  FROM public.cod_transport_customer_aliases
  WHERE id = p_alias_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'alias_not_found'; END IF;

  v_prev := v_row.is_active;
  IF v_prev = p_is_active THEN
    RETURN jsonb_build_object(
      'ok', true,
      'code', 'idempotent',
      'alias_id', v_row.id,
      'is_active', v_row.is_active
    );
  END IF;

  UPDATE public.cod_transport_customer_aliases SET
    is_active = p_is_active,
    updated_by = v_uid,
    updated_at = now()
  WHERE id = p_alias_id
  RETURNING * INTO v_row;

  v_event := CASE WHEN p_is_active THEN 'alias_reactivated' ELSE 'alias_deactivated' END;

  PERFORM public._cod_insert_alias_event(
    v_event,
    v_uid,
    NULL,
    v_row.source_remittance_row_id,
    jsonb_build_object(
      'alias_id', v_row.id,
      'transport_id', v_row.transport_id,
      'normalized_alias', v_row.normalized_alias,
      'customer_id', v_row.customer_id,
      'is_active', v_prev
    ),
    jsonb_build_object(
      'alias_id', v_row.id,
      'transport_id', v_row.transport_id,
      'normalized_alias', v_row.normalized_alias,
      'customer_id', v_row.customer_id,
      'is_active', v_row.is_active
    ),
    p_reason
  );

  RETURN jsonb_build_object(
    'ok', true,
    'code', CASE WHEN p_is_active THEN 'reactivated' ELSE 'deactivated' END,
    'alias_id', v_row.id,
    'is_active', v_row.is_active
  );
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 3) reassign (explícita, nunca silenciosa)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_cod_reassign_transport_alias(
  p_alias_id uuid,
  p_new_customer_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.cod_transport_customer_aliases%ROWTYPE;
  v_prev_customer uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.has_permission(v_uid, 'conciliacion-reembolso', 'edit') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_alias_id IS NULL OR p_new_customer_id IS NULL THEN
    RAISE EXCEPTION 'params_required';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'reason_required';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.customers WHERE id = p_new_customer_id) THEN
    RAISE EXCEPTION 'customer_not_found';
  END IF;

  SELECT * INTO v_row
  FROM public.cod_transport_customer_aliases
  WHERE id = p_alias_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'alias_not_found'; END IF;

  v_prev_customer := v_row.customer_id;
  IF v_prev_customer = p_new_customer_id THEN
    RETURN jsonb_build_object(
      'ok', true,
      'code', 'idempotent',
      'alias_id', v_row.id,
      'customer_id', v_row.customer_id
    );
  END IF;

  UPDATE public.cod_transport_customer_aliases SET
    customer_id = p_new_customer_id,
    is_active = true,
    updated_by = v_uid,
    updated_at = now()
  WHERE id = p_alias_id
  RETURNING * INTO v_row;

  PERFORM public._cod_insert_alias_event(
    'alias_reassigned',
    v_uid,
    NULL,
    v_row.source_remittance_row_id,
    jsonb_build_object(
      'alias_id', v_row.id,
      'transport_id', v_row.transport_id,
      'normalized_alias', v_row.normalized_alias,
      'previous_customer_id', v_prev_customer,
      'is_active', true
    ),
    jsonb_build_object(
      'alias_id', v_row.id,
      'transport_id', v_row.transport_id,
      'normalized_alias', v_row.normalized_alias,
      'previous_customer_id', v_prev_customer,
      'new_customer_id', p_new_customer_id,
      'customer_id', p_new_customer_id,
      'is_active', true
    ),
    trim(p_reason)
  );

  RETURN jsonb_build_object(
    'ok', true,
    'code', 'reassigned',
    'alias_id', v_row.id,
    'previous_customer_id', v_prev_customer,
    'new_customer_id', p_new_customer_id,
    'is_active', true
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.rpc_cod_remember_transport_alias(uuid, uuid, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_cod_remember_transport_alias(uuid, uuid, text, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.rpc_cod_remember_transport_alias(uuid, uuid, text, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cod_remember_transport_alias(uuid, uuid, text, uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.rpc_cod_set_transport_alias_active(uuid, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_cod_set_transport_alias_active(uuid, boolean, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.rpc_cod_set_transport_alias_active(uuid, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cod_set_transport_alias_active(uuid, boolean, text) TO service_role;

REVOKE ALL ON FUNCTION public.rpc_cod_reassign_transport_alias(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_cod_reassign_transport_alias(uuid, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.rpc_cod_reassign_transport_alias(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cod_reassign_transport_alias(uuid, uuid, text) TO service_role;

COMMENT ON FUNCTION public.rpc_cod_remember_transport_alias(uuid, uuid, text, uuid, text) IS
  'Crea/reactiva alias transport+texto → customer. Conflicto si otro customer. Sin efecto financiero.';

COMMENT ON FUNCTION public.rpc_cod_set_transport_alias_active(uuid, boolean, text) IS
  'Soft activate/deactivate alias. Evento auditable. Sin efecto financiero.';

COMMENT ON FUNCTION public.rpc_cod_reassign_transport_alias(uuid, uuid, text) IS
  'Reasignación explícita de customer_id con reason obligatorio y evento previous/new.';
