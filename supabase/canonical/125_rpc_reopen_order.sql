-- 125_rpc_reopen_order.sql
-- Permite al cliente volver a abrir un pedido en estado "closed" (Preparando pedido)
-- para poder agregar o quitar productos. El pedido vuelve a estado "active" (apartado).

CREATE OR REPLACE FUNCTION public.rpc_reopen_order(p_order_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_customer_id uuid;
  v_status text;
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

  UPDATE public.orders
  SET status = 'active',
      closed_at = NULL,
      updated_at = now()
  WHERE id = p_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No se pudo reabrir el pedido.';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.rpc_reopen_order(uuid) IS
  'Reabre un pedido cerrado (Preparando pedido) para que el cliente pueda agregar o quitar productos. Solo el dueño del pedido.';

SELECT pg_notify('pgrst', 'reload schema');
