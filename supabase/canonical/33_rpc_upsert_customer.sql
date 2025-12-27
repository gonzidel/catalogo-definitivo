-- 33_rpc_upsert_customer.sql — Función RPC para upsert seguro de customer
-- Esta función permite a los usuarios autenticados actualizar su propio perfil
-- sin problemas de RLS, ya que se ejecuta con SECURITY DEFINER

CREATE OR REPLACE FUNCTION public.rpc_upsert_customer(
  p_full_name text,
  p_address text,
  p_city text,
  p_province text,
  p_phone text,
  p_dni text,
  p_email text,
  p_customer_number text DEFAULT NULL,
  p_qr_code uuid DEFAULT NULL,
  p_public_sales_customer_id uuid DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_user_id uuid;
  v_existing_record record;
BEGIN
  -- Obtener el ID del usuario autenticado
  v_user_id := auth.uid();
  
  IF v_user_id IS NULL THEN
    RETURN json_build_object(
      'success', false,
      'error', 'Usuario no autenticado'
    );
  END IF;

  -- Usar INSERT ... ON CONFLICT para hacer upsert de forma segura
  INSERT INTO public.customers (
    id,
    full_name,
    address,
    city,
    province,
    phone,
    dni,
    email,
    customer_number,
    qr_code,
    public_sales_customer_id,
    created_at,
    updated_at
  ) VALUES (
    v_user_id,
    p_full_name,
    p_address,
    p_city,
    p_province,
    p_phone,
    p_dni,
    p_email,
    p_customer_number,
    p_qr_code,
    p_public_sales_customer_id,
    now(),
    now()
  )
  ON CONFLICT (id) DO UPDATE SET
    full_name = EXCLUDED.full_name,
    address = EXCLUDED.address,
    city = EXCLUDED.city,
    province = EXCLUDED.province,
    phone = EXCLUDED.phone,
    dni = EXCLUDED.dni,
    email = EXCLUDED.email,
    -- Preservar customer_number, qr_code y public_sales_customer_id si no se proporcionan
    customer_number = COALESCE(NULLIF(EXCLUDED.customer_number, NULL), customers.customer_number),
    qr_code = COALESCE(NULLIF(EXCLUDED.qr_code, NULL), customers.qr_code),
    public_sales_customer_id = COALESCE(NULLIF(EXCLUDED.public_sales_customer_id, NULL), customers.public_sales_customer_id),
    updated_at = now();

  -- Verificar si fue INSERT o UPDATE
  SELECT * INTO v_existing_record
  FROM public.customers
  WHERE id = v_user_id;

  IF v_existing_record.created_at = v_existing_record.updated_at THEN
    RETURN json_build_object(
      'success', true,
      'action', 'inserted',
      'customer_id', v_user_id
    );
  ELSE
    RETURN json_build_object(
      'success', true,
      'action', 'updated',
      'customer_id', v_user_id
    );
  END IF;

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object(
    'success', false,
    'error', SQLERRM
  );
END;
$$;

-- Otorgar permisos de ejecución a usuarios autenticados
GRANT EXECUTE ON FUNCTION public.rpc_upsert_customer TO authenticated;

-- Recargar esquema
SELECT pg_notify('pgrst', 'reload schema');

