-- 348_rpc_customer_request_close_auto_close_when_ready.sql
--
-- Bug A56955 (2026-09-18): clienta SEDE con TODO picked tocó "Cerrar pedido"
-- y solo quedó notes.customer_requested_close=true (status=active) → Apartados
-- para siempre. El auto-cierre solo corre si admin dispara refreshAndMaybeAutoClose.
--
-- Causa: rpc_customer_request_close solo seteaba el flag. Si el front (estado
-- stale) creía que aún había reserved, o cualquier path usaba esta RPC con el
-- pedido ya listo, nadie cerraba.
--
-- Fix: tras marcar el flag, si NO quedan ítems reserved/waiting/awaiting_apartado
-- y el transporte NO es retiro local (Retira Local / Retiro de Local), cerrar
-- vía rpc_close_order('Pendiente') — misma ruta que el CTA "listo".
-- Retiro local sigue solo con el flag (cobro en admin Apartados).

CREATE OR REPLACE FUNCTION public.rpc_customer_request_close(p_order_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_order record;
  v_notes jsonb;
  v_pending_count int;
  v_transport_name text := '';
  v_is_local_pickup boolean := false;
  v_closed boolean := false;
BEGIN
  SELECT o.id, o.customer_id, o.status, o.notes, o.dismantle_at, o.transport_id
  INTO v_order
  FROM public.orders o
  WHERE o.id = p_order_id
  FOR UPDATE;

  IF v_order.id IS NULL THEN
    RAISE EXCEPTION 'Pedido no encontrado';
  END IF;

  IF v_order.customer_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'No tenés permiso para modificar este pedido';
  END IF;

  IF lower(trim(coalesce(v_order.status, ''))) NOT IN ('active', 'closing_soon') THEN
    RAISE EXCEPTION 'El pedido no está en un estado que permita solicitar cierre';
  END IF;

  IF v_order.dismantle_at IS NOT NULL AND now() >= v_order.dismantle_at THEN
    RAISE EXCEPTION 'Pedido vencido';
  END IF;

  v_notes := coalesce(v_order.notes::jsonb, '{}'::jsonb);
  v_notes := jsonb_set(v_notes, '{customer_requested_close}', 'true'::jsonb);

  UPDATE public.orders
  SET notes = v_notes::text,
      updated_at = now()
  WHERE id = p_order_id;

  SELECT count(*)::int
  INTO v_pending_count
  FROM public.order_items
  WHERE order_id = p_order_id
    AND status IN ('reserved', 'waiting', 'awaiting_apartado');

  SELECT coalesce(nullif(trim(t.name), ''), '')
  INTO v_transport_name
  FROM public.transports t
  WHERE t.id = v_order.transport_id;

  v_transport_name := coalesce(v_transport_name, '');
  -- Match isLocalPickupTransport (DB: "Retira Local", "Retiro de Local")
  v_is_local_pickup :=
    lower(v_transport_name) IN ('retira local', 'retiro de local');

  IF coalesce(v_pending_count, 0) = 0 AND NOT v_is_local_pickup THEN
    -- Misma semántica que el CTA "listo para envío" del cliente.
    PERFORM public.rpc_close_order(p_order_id, 'Pendiente');
    v_closed := true;
  END IF;

  RETURN json_build_object(
    'ok', true,
    'order_id', p_order_id,
    'closed', v_closed,
    'pending_items', coalesce(v_pending_count, 0),
    'local_pickup', v_is_local_pickup
  );
END;
$function$;

COMMENT ON FUNCTION public.rpc_customer_request_close(uuid) IS
  'Cliente: marca customer_requested_close. Si ya no hay reserved/waiting/awaiting_apartado y el transporte no es retiro local, cierra vía rpc_close_order(Pendiente). Retiro local solo deja el flag para cobro en Apartados.';

GRANT EXECUTE ON FUNCTION public.rpc_customer_request_close(uuid) TO authenticated;
