-- 234_rpc_customer_order_lifecycle.sql
-- Prórroga única de 24h (cliente) y cancelación completa de pedido (cliente).
-- notes JSON: customer_enable_24h_uses = 1 tras la prórroga (admin usa admin_enable_24h_uses).

CREATE OR REPLACE FUNCTION public.rpc_customer_request_order_extension_24h(p_order_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_uid uuid;
  v_order record;
  v_notes_obj jsonb;
  v_customer_uses int;
  v_new_dismantle timestamptz;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  SELECT id, customer_id, status, dismantle_at, notes
  INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF v_order.id IS NULL THEN
    RAISE EXCEPTION 'Pedido no encontrado';
  END IF;

  IF v_order.customer_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'No tenés permiso para modificar este pedido';
  END IF;

  IF lower(trim(coalesce(v_order.status, ''))) NOT IN ('active', 'closing_soon') THEN
    RAISE EXCEPTION 'Este pedido no admite prórroga';
  END IF;

  IF v_order.dismantle_at IS NULL OR now() < v_order.dismantle_at THEN
    RAISE EXCEPTION 'El pedido aún no venció';
  END IF;

  v_notes_obj := '{}'::jsonb;
  IF v_order.notes IS NOT NULL AND trim(v_order.notes) <> '' THEN
    BEGIN
      v_notes_obj := v_order.notes::jsonb;
      IF jsonb_typeof(v_notes_obj) <> 'object' THEN
        RAISE EXCEPTION 'Estado del pedido inválido (notes)';
      END IF;
    EXCEPTION
      WHEN others THEN
        RAISE EXCEPTION 'Estado del pedido inválido (notes)';
    END;
  END IF;

  v_customer_uses := COALESCE((v_notes_obj->>'customer_enable_24h_uses')::int, 0);
  IF v_customer_uses >= 1 THEN
    RAISE EXCEPTION 'Ya usaste la prórroga de 24 horas para este pedido';
  END IF;

  v_new_dismantle := now() + interval '24 hours';

  UPDATE public.orders
  SET
    dismantle_at = v_new_dismantle,
    notes = (v_notes_obj || jsonb_build_object('customer_enable_24h_uses', 1))::text,
    status = CASE
      WHEN lower(trim(coalesce(status, ''))) = 'closing_soon' THEN 'active'
      ELSE status
    END,
    updated_at = now()
  WHERE id = p_order_id;

  RETURN json_build_object(
    'ok', true,
    'order_id', p_order_id,
    'dismantle_at', v_new_dismantle
  );
END;
$$;

COMMENT ON FUNCTION public.rpc_customer_request_order_extension_24h(uuid) IS
  'Cliente: una prórroga de 24h tras vencer dismantle_at. Registra customer_enable_24h_uses en orders.notes.';

GRANT EXECUTE ON FUNCTION public.rpc_customer_request_order_extension_24h(uuid) TO authenticated;


CREATE OR REPLACE FUNCTION public.rpc_customer_cancel_order(p_order_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_uid uuid;
  v_order record;
  v_item_id uuid;
  v_item_status text;
  v_rpc_result json;
  v_cancelled int := 0;
  v_had_picked boolean := false;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  SELECT id, customer_id, status, order_number
  INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF v_order.id IS NULL THEN
    RAISE EXCEPTION 'Pedido no encontrado';
  END IF;

  IF v_order.customer_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'No tenés permiso para cancelar este pedido';
  END IF;

  IF lower(trim(coalesce(v_order.status, ''))) NOT IN ('active', 'closing_soon') THEN
    RAISE EXCEPTION 'No se puede cancelar un pedido en este estado';
  END IF;

  PERFORM 1
  FROM public.order_items oi
  WHERE oi.order_id = p_order_id
  FOR UPDATE;

  FOR v_item_id, v_item_status IN
    SELECT oi.id, lower(trim(coalesce(oi.status, '')))
    FROM public.order_items oi
    WHERE oi.order_id = p_order_id
      AND lower(trim(coalesce(oi.status, ''))) <> 'cancelled'
    ORDER BY oi.created_at, oi.id
  LOOP
    v_rpc_result := public.rpc_cancel_order_item(v_item_id);

    IF v_rpc_result IS NULL
       OR NOT COALESCE((v_rpc_result->>'applied')::boolean, false)
    THEN
      RAISE EXCEPTION
        'No se pudo cancelar el producto del pedido (item=%)',
        v_item_id;
    END IF;

    IF COALESCE((v_rpc_result->>'was_picked')::boolean, false)
       OR v_item_status = 'picked'
    THEN
      v_had_picked := true;
    END IF;

    v_cancelled := v_cancelled + 1;
  END LOOP;

  IF v_had_picked THEN
    UPDATE public.orders
    SET status = 'closed', updated_at = now()
    WHERE id = p_order_id;
  ELSE
    UPDATE public.orders
    SET updated_at = now()
    WHERE id = p_order_id;
  END IF;

  RETURN json_build_object(
    'ok', true,
    'order_id', p_order_id,
    'order_number', v_order.order_number,
    'items_cancelled', v_cancelled,
    'had_picked', v_had_picked,
    'order_status', CASE WHEN v_had_picked THEN 'closed' ELSE v_order.status END
  );
END;
$$;

COMMENT ON FUNCTION public.rpc_customer_cancel_order(uuid) IS
  'Cliente: cancela ítems operativos (rpc_cancel_order_item). Si hubo picked → closed; si no, pedido queda con ítems cancelled para admin.';

GRANT EXECUTE ON FUNCTION public.rpc_customer_cancel_order(uuid) TO authenticated;

SELECT pg_notify('pgrst', 'reload schema');
