-- 235_fix_rpc_customer_cancel_order.sql
-- Amplía orders_status_check para admitir 'cancelled' y actualiza el RPC
-- para usar 'cancelled' en lugar del workaround previo con 'closed'.

ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_status_check;

ALTER TABLE public.orders
  ADD CONSTRAINT orders_status_check
  CHECK (status IN ('active','closing_soon','closed','sent','expired','devolución','cancelled'));

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

  UPDATE public.orders
  SET status = 'cancelled', updated_at = now()
  WHERE id = p_order_id;

  RETURN json_build_object(
    'ok', true,
    'order_id', p_order_id,
    'order_number', v_order.order_number,
    'items_cancelled', v_cancelled,
    'had_picked', v_had_picked,
    'order_status', 'cancelled'
  );
END;
$$;

COMMENT ON FUNCTION public.rpc_customer_cancel_order(uuid) IS
  'Cliente: cancela todos los ítems operativos y marca el pedido como cancelled.';

GRANT EXECUTE ON FUNCTION public.rpc_customer_cancel_order(uuid) TO authenticated;

SELECT pg_notify('pgrst', 'reload schema');
