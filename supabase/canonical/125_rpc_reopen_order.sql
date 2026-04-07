-- 125_rpc_reopen_order.sql
-- Reabre un pedido closed. Si ya hay otro active/closing_soon del mismo cliente:
-- - con ítems operacionales -> error;
-- - sin ítems operacionales (elegible) -> maint_try_delete_order_if_eligible sobre ese pedido;
-- - si sigue el conflicto de índice único -> error explícito.

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
END;
$$;

COMMENT ON FUNCTION public.rpc_reopen_order(uuid) IS
  'Reabre pedido closed; política de un solo pedido abierto (active/closing_soon) y limpieza de huérfanos elegibles.';

GRANT EXECUTE ON FUNCTION public.rpc_reopen_order(uuid) TO authenticated;

SELECT pg_notify('pgrst', 'reload schema');
