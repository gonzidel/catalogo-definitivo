-- 339_reopen_retract_unsent_closed_bell.sql
--
-- Bug (A56670, 2026-09-08): la clienta cierra → campana encola customer_closed_*.
-- Si reabre ("Editar pedido") y vuelve a cerrar, el enqueue ve el aviso pendiente
-- (dismissed_at IS NULL) y lo trata como duplicado: no se fabrica otro mensaje.
-- El aviso viejo queda en campana con el total/texto del primer cierre.
--
-- Regla: al reabrir (dashboard clienta), si el mensaje de cierre NUNCA se envió
-- (copied_at IS NULL y dismissed_at IS NULL), se retira de la campana.
-- El próximo rpc_close_order puede encolar un aviso nuevo con el total actual.
-- Si ya se envió (copied_at o dismissed_at), no se toca; el re-cierre igual
-- puede crear uno nuevo porque el chequeo de duplicado solo mira pendientes.
--
-- Aplicada en fyl-core 2026-09-08 (migración reopen_retract_unsent_closed_bell_339).

CREATE OR REPLACE FUNCTION public.fn_retract_unsent_customer_closed_notifications(p_order_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_count integer := 0;
BEGIN
  UPDATE public.admin_order_message_notifications
     SET dismissed_at = now()
   WHERE order_id = p_order_id
     AND kind IN (
       'customer_closed_cod',
       'customer_closed_transfer',
       'customer_closed_correo'
     )
     AND dismissed_at IS NULL
     AND copied_at IS NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF v_count > 0 THEN
    UPDATE public.orders
       SET closed_fulfillment_status = NULL
     WHERE id = p_order_id
       AND closed_fulfillment_status IN (
         'awaiting_customer_message',
         'awaiting_correo_cost'
       );
  END IF;

  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.fn_retract_unsent_customer_closed_notifications(uuid) IS
  'Retira de la campana avisos customer_closed_* no enviados al reabrir el pedido.';

CREATE OR REPLACE FUNCTION public.rpc_customer_reopen_order_for_editing(p_order_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $function$
DECLARE
  v_order record;
  v_notes_obj jsonb;
  v_was_requested_close boolean;
  v_short_dismantle timestamptz;
  v_new_dismantle timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  SELECT id, customer_id, status, notes, dismantle_at
  INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF v_order.id IS NULL THEN
    RAISE EXCEPTION 'Pedido no encontrado';
  END IF;

  IF v_order.customer_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'No tenés permiso para modificar este pedido';
  END IF;

  v_notes_obj := '{}'::jsonb;
  IF v_order.notes IS NOT NULL AND trim(v_order.notes) <> '' THEN
    BEGIN
      v_notes_obj := v_order.notes::jsonb;
      IF jsonb_typeof(v_notes_obj) <> 'object' THEN
        v_notes_obj := '{}'::jsonb;
      END IF;
    EXCEPTION
      WHEN others THEN
        v_notes_obj := '{}'::jsonb;
    END;
  END IF;

  v_was_requested_close := coalesce((v_notes_obj->>'customer_requested_close')::boolean, false);

  IF v_order.status <> 'closed' AND NOT v_was_requested_close THEN
    RAISE EXCEPTION 'Este pedido no está en preparación, no corresponde reabrirlo para editar';
  END IF;

  v_short_dismantle := public.fn_compute_order_deadline(now(), 1);
  IF v_order.dismantle_at IS NOT NULL AND v_order.dismantle_at > v_short_dismantle THEN
    v_new_dismantle := v_order.dismantle_at;
  ELSE
    v_new_dismantle := v_short_dismantle;
  END IF;

  v_notes_obj := v_notes_obj - 'customer_requested_close';

  UPDATE public.orders
  SET
    status = 'active',
    closed_at = NULL,
    dismantle_at = v_new_dismantle,
    notes = v_notes_obj::text,
    updated_at = now()
  WHERE id = p_order_id;

  PERFORM public.fn_retract_unsent_customer_closed_notifications(p_order_id);

  RETURN json_build_object(
    'ok', true,
    'order_id', p_order_id,
    'dismantle_at', v_new_dismantle
  );
END;
$function$;

COMMENT ON FUNCTION public.rpc_customer_reopen_order_for_editing(uuid) IS
  'Reabre pedido closed / customer_requested_close para editar. Conserva plazo largo (323). Retira campana de cierre no enviada (339).';

CREATE OR REPLACE FUNCTION public.rpc_reopen_order(p_order_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_customer_id uuid;
  v_status text;
  v_other_id uuid;
BEGIN
  SELECT customer_id, status
  INTO v_customer_id, v_status
  FROM public.orders
  WHERE id = p_order_id;

  IF v_customer_id IS NULL THEN
    RAISE EXCEPTION 'Pedido no encontrado';
  END IF;

  IF v_customer_id != auth.uid() THEN
    RAISE EXCEPTION 'No tienes permiso para modificar este pedido';
  END IF;

  IF (v_status IS NULL OR trim(lower(v_status)) != 'closed') THEN
    RAISE EXCEPTION 'Solo se puede modificar un pedido que esté en estado "Preparando pedido"';
  END IF;

  SELECT o.id INTO v_other_id
  FROM public.orders o
  WHERE o.customer_id = v_customer_id
    AND o.id <> p_order_id
    AND o.status IN ('active', 'closing_soon')
  ORDER BY o.created_at DESC
  LIMIT 1;

  IF v_other_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
      FROM public.order_items oi
      WHERE oi.order_id = v_other_id
        AND public.order_item_status_is_operacional(oi.status)
    ) THEN
      RAISE EXCEPTION 'Ya tenés un pedido en curso. Cerrá o gestioná ese pedido antes de modificar este.';
    END IF;

    PERFORM public.maint_try_delete_order_if_eligible(v_other_id, 'rpc_reopen_order_cleanup');

    SELECT o.id INTO v_other_id
    FROM public.orders o
    WHERE o.customer_id = v_customer_id
      AND o.id <> p_order_id
      AND o.status IN ('active', 'closing_soon')
    ORDER BY o.created_at DESC
    LIMIT 1;

    IF v_other_id IS NOT NULL THEN
      IF EXISTS (
        SELECT 1
        FROM public.order_items oi
        WHERE oi.order_id = v_other_id
          AND public.order_item_status_is_operacional(oi.status)
      ) THEN
        RAISE EXCEPTION 'Ya tenés un pedido en curso. Cerrá o gestioná ese pedido antes de modificar este.';
      END IF;
      RAISE EXCEPTION 'No se pudo preparar la reapertura: conflicto con otro pedido abierto. Recargá la página e intentá de nuevo.';
    END IF;
  END IF;

  BEGIN
    UPDATE public.orders
    SET status = 'active',
        closed_at = NULL,
        updated_at = now()
    WHERE id = p_order_id;
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'No se pudo reabrir: ya existe otro pedido abierto para tu cuenta. Recargá e intentá de nuevo.';
  END;

  IF NOT EXISTS (
    SELECT 1 FROM public.orders o
    WHERE o.id = p_order_id AND trim(lower(o.status)) = 'active'
  ) THEN
    RAISE EXCEPTION 'No se pudo reabrir el pedido.';
  END IF;

  PERFORM public.fn_retract_unsent_customer_closed_notifications(p_order_id);
END;
$$;

COMMENT ON FUNCTION public.rpc_reopen_order(uuid) IS
  'Reabre pedido closed; un solo pedido abierto. Retira campana de cierre no enviada (339).';

GRANT EXECUTE ON FUNCTION public.rpc_customer_reopen_order_for_editing(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_reopen_order(uuid) TO authenticated;

SELECT pg_notify('pgrst', 'reload schema');
