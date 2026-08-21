-- 285_rpc_cod_update_irregularity_status.sql
--
-- Fase 6A — Gestión de reclamos COD (solo estado de irregularidad).
--
-- Transiciones permitidas:
--   open → in_review
--   open → resolved  (requiere p_resolution_notes no vacío)
--   in_review → resolved (requiere notes)
--
-- Rechaza:
--   resolved → *
--   superseded → *
--   * → superseded (manual)
--   cualquier otra transición
--
-- NO modifica: orders, remittances, remittance_rows, montos, matched_order_id.
-- Mutaciones solo vía esta RPC (sin policies UPDATE en cod_irregularities).

CREATE OR REPLACE FUNCTION public.rpc_cod_update_irregularity_status(
  p_irregularity_id uuid,
  p_new_status text,
  p_resolution_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.cod_irregularities%ROWTYPE;
  v_prev text;
  v_new text;
  v_notes text;
  v_event text;
  v_reason text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF NOT public.has_permission(v_uid, 'conciliacion-reembolso', 'edit') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_irregularity_id IS NULL THEN
    RAISE EXCEPTION 'irregularity_id_required';
  END IF;

  v_new := lower(trim(COALESCE(p_new_status, '')));
  IF v_new NOT IN ('in_review', 'resolved') THEN
    RAISE EXCEPTION 'invalid_new_status';
  END IF;

  -- Bloquear superseded manual de entrada
  IF v_new = 'superseded' THEN
    RAISE EXCEPTION 'superseded_not_allowed_manual';
  END IF;

  SELECT * INTO v_row
  FROM public.cod_irregularities
  WHERE id = p_irregularity_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'irregularity_not_found';
  END IF;

  v_prev := v_row.status;

  IF v_prev = 'superseded' THEN
    RAISE EXCEPTION 'irregularity_superseded';
  END IF;

  IF v_prev = 'resolved' THEN
    RAISE EXCEPTION 'irregularity_already_resolved';
  END IF;

  -- Transiciones
  IF v_prev = 'open' AND v_new = 'in_review' THEN
    v_event := 'irregularity_review_started';
    v_reason := 'Reclamo marcado en revisión';

    UPDATE public.cod_irregularities SET
      status = 'in_review',
      updated_at = now()
    WHERE id = p_irregularity_id;

  ELSIF (v_prev = 'open' OR v_prev = 'in_review') AND v_new = 'resolved' THEN
    v_notes := trim(COALESCE(p_resolution_notes, ''));
    IF v_notes = '' THEN
      RAISE EXCEPTION 'resolution_notes_required';
    END IF;
    IF char_length(v_notes) > 2000 THEN
      RAISE EXCEPTION 'resolution_notes_too_long';
    END IF;

    v_event := 'irregularity_resolved';
    v_reason := 'Reclamo resuelto';

    UPDATE public.cod_irregularities SET
      status = 'resolved',
      resolution_note = v_notes,
      resolved_by = v_uid,
      resolved_at = now(),
      updated_at = now()
    WHERE id = p_irregularity_id;

  ELSE
    RAISE EXCEPTION 'invalid_transition';
  END IF;

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
    v_row.remittance_id,
    v_row.remittance_row_id,
    p_irregularity_id,
    v_event,
    v_uid,
    now(),
    jsonb_build_object('status', v_prev),
    jsonb_build_object(
      'status', v_new,
      'irregularity_id', p_irregularity_id,
      'has_resolution_note', (v_new = 'resolved')
    ),
    v_reason
  );

  RETURN jsonb_build_object(
    'ok', true,
    'irregularity_id', p_irregularity_id,
    'previous_status', v_prev,
    'new_status', v_new,
    'event_type', v_event
  );
EXCEPTION
  WHEN OTHERS THEN
    -- Propagar con rollback implícito de la transacción del caller
    RAISE;
END;
$fn$;

REVOKE ALL ON FUNCTION public.rpc_cod_update_irregularity_status(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_cod_update_irregularity_status(uuid, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.rpc_cod_update_irregularity_status(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cod_update_irregularity_status(uuid, text, text) TO service_role;

COMMENT ON FUNCTION public.rpc_cod_update_irregularity_status(uuid, text, text) IS
  'Fase 6A: open→in_review | open/in_review→resolved (notes obligatorias). No muta orders/remittance_rows. Requiere conciliacion-reembolso/edit.';
