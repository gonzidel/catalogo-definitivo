-- 346_ROLLBACK_fix_customer_cancel_verified_terminal_order.sql
--
-- Revierte únicamente las definiciones introducidas por 346.
-- No modifica datos ni reabre EXECUTE a anon/PUBLIC.

DROP TRIGGER IF EXISTS order_items_reject_cancelled_parent ON public.order_items;
DROP FUNCTION IF EXISTS public.trg_order_items_reject_cancelled_parent();

CREATE OR REPLACE FUNCTION public.trg_order_items_cancelled_try_empty_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF lower(trim(coalesce(NEW.status, ''))) = 'cancelled' THEN
    PERFORM public.maint_try_delete_order_if_eligible(
      NEW.order_id,
      'trigger_order_items_cancelled'
    );
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.trg_order_items_cancelled_try_empty_order() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_order_items_cancelled_try_empty_order() FROM anon;

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
  v_order_deleted boolean := false;
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
       OR NOT coalesce((v_rpc_result->>'applied')::boolean, false)
    THEN
      RAISE EXCEPTION
        'No se pudo cancelar el producto del pedido (item=%)',
        v_item_id;
    END IF;

    IF coalesce((v_rpc_result->>'was_picked')::boolean, false)
       OR v_item_status = 'picked'
    THEN
      v_had_picked := true;
    END IF;

    v_cancelled := v_cancelled + 1;
  END LOOP;

  UPDATE public.orders
  SET status = 'cancelled',
      updated_at = now()
  WHERE id = p_order_id;

  IF NOT EXISTS (
    SELECT 1
    FROM public.order_items oi
    JOIN public.order_item_stock_sources s ON s.order_item_id = oi.id
    WHERE oi.order_id = p_order_id
      AND lower(trim(coalesce(oi.status, ''))) = 'cancelled'
      AND greatest(coalesce(s.qty, 0), 0) > 0
  )
  AND public.order_eligible_for_empty_deletion(p_order_id)
  THEN
    v_order_deleted := coalesce(
      public.maint_try_delete_order_if_eligible(
        p_order_id,
        'rpc_customer_cancel_order'
      ),
      false
    );
  END IF;

  RETURN json_build_object(
    'ok', true,
    'order_id', p_order_id,
    'order_number', v_order.order_number,
    'items_cancelled', v_cancelled,
    'had_picked', v_had_picked,
    'order_status', CASE WHEN v_order_deleted THEN 'deleted' ELSE 'cancelled' END,
    'order_deleted', v_order_deleted
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_customer_cancel_order(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_customer_cancel_order(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.rpc_customer_cancel_order(uuid) TO authenticated;

SELECT pg_notify('pgrst', 'reload schema');
