-- 131_rpc_delete_admin_customer.sql — Eliminar cliente (solo admins, SECURITY DEFINER)
-- Elimina notificaciones de pedido ligadas al cliente (FK sin ON DELETE) y luego el registro;
-- pedidos, carritos e ítems asociados se eliminan en cascada según el esquema vigente.

CREATE OR REPLACE FUNCTION public.rpc_delete_admin_customer(p_customer_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_admin_check boolean;
BEGIN
  SELECT EXISTS(SELECT 1 FROM public.admins WHERE user_id = auth.uid()) INTO v_admin_check;
  IF NOT v_admin_check THEN
    RETURN json_build_object('success', false, 'message', 'No autorizado. Solo administradores pueden eliminar clientes.');
  END IF;

  IF p_customer_id IS NULL THEN
    RETURN json_build_object('success', false, 'message', 'Cliente no válido');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.customers WHERE id = p_customer_id) THEN
    RETURN json_build_object('success', false, 'message', 'Cliente no encontrado');
  END IF;

  IF to_regclass('public.order_notifications') IS NOT NULL THEN
    DELETE FROM public.order_notifications WHERE customer_id = p_customer_id;
  END IF;

  DELETE FROM public.customers WHERE id = p_customer_id;

  RETURN json_build_object('success', true, 'message', 'Cliente eliminado correctamente');
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('success', false, 'message', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_delete_admin_customer(uuid) TO authenticated;

SELECT pg_notify('pgrst', 'reload schema');
