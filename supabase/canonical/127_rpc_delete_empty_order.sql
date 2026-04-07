-- 127_rpc_delete_empty_order.sql
-- Permite al cliente eliminar su pedido cuando ya no tiene ítems operacionales
-- (solo cancelled/expired u sin filas). Sin esta RPC, el cliente no puede hacer DELETE en orders por RLS.
-- Delega el borrado en maint_try_delete_order_if_eligible (mismo núcleo que el trigger).

CREATE OR REPLACE FUNCTION public.rpc_delete_empty_order(p_order_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_customer_id uuid;
BEGIN
  SELECT customer_id INTO v_customer_id
  FROM public.orders
  WHERE id = p_order_id;

  IF v_customer_id IS NULL THEN
    RAISE EXCEPTION 'Pedido no encontrado';
  END IF;

  IF v_customer_id != auth.uid() THEN
    IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()) THEN
      RAISE EXCEPTION 'No tienes permiso para eliminar este pedido';
    END IF;
  END IF;

  IF NOT public.order_eligible_for_empty_deletion(p_order_id) THEN
    RAISE EXCEPTION 'El pedido aún tiene productos operativos. Solo se puede eliminar cuando no queden ítems reservados, en espera, apartados, sin stock (missing) o estados desconocidos.';
  END IF;

  PERFORM public.maint_try_delete_order_if_eligible(p_order_id, 'rpc_delete_empty_order');
END;
$$;

COMMENT ON FUNCTION public.rpc_delete_empty_order(uuid) IS
  'Elimina un pedido sin ítems operacionales (order_eligible_for_empty_deletion). Dueño o admin.';

GRANT EXECUTE ON FUNCTION public.rpc_delete_empty_order(uuid) TO authenticated;

SELECT pg_notify('pgrst', 'reload schema');
