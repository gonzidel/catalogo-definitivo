-- 39_fix_customers_update_rpc.sql — Función RPC para actualizar clientes (admin)
-- Este script crea una función RPC con SECURITY DEFINER para que los admins puedan
-- actualizar clientes sin problemas de permisos con la restricción de clave foránea

-- Función RPC para actualizar clientes (solo admins)
CREATE OR REPLACE FUNCTION public.rpc_update_admin_customer(
  p_customer_id uuid,
  p_full_name text,
  p_email text default null,
  p_phone text default null,
  p_dni text default null,
  p_address text default null,
  p_city text default null,
  p_province text default null
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_admin_check boolean;
BEGIN
  -- Verificar si es admin
  SELECT EXISTS(SELECT 1 FROM public.admins WHERE user_id = auth.uid()) INTO v_admin_check;
  IF NOT v_admin_check THEN
    RETURN json_build_object('success', false, 'message', 'No autorizado. Solo administradores pueden actualizar clientes.');
  END IF;

  -- Verificar que el cliente existe
  IF NOT EXISTS (SELECT 1 FROM public.customers WHERE id = p_customer_id) THEN
    RETURN json_build_object('success', false, 'message', 'Cliente no encontrado');
  END IF;

  -- Actualizar cliente
  UPDATE public.customers
  SET 
    full_name = p_full_name,
    email = COALESCE(p_email, email),
    phone = p_phone,
    dni = COALESCE(p_dni, dni),
    address = p_address,
    city = p_city,
    province = p_province,
    updated_at = now()
  WHERE id = p_customer_id;

  RETURN json_build_object(
    'success', true, 
    'customer_id', p_customer_id,
    'message', 'Cliente actualizado con éxito'
  );

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('success', false, 'message', SQLERRM);
END;
$$;

-- Otorgar permisos de ejecución
GRANT EXECUTE ON FUNCTION public.rpc_update_admin_customer TO authenticated;

-- Recargar esquema
SELECT pg_notify('pgrst', 'reload schema');

-- Mensaje de confirmación
DO $$
BEGIN
    RAISE NOTICE '✅ Función rpc_update_admin_customer creada correctamente';
    RAISE NOTICE '✅ Los admins ahora pueden actualizar clientes usando esta función RPC';
END $$;

