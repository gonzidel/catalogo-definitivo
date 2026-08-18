-- 237_customers_additional_names.sql
-- Nombres y DNI adicionales por cliente (hasta 3) para admin/customers.

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS additional_names jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.customers.additional_names IS
  'Sub-nombres del cliente (máx. 3): [{ "first_name", "last_name", "full_name", "dni" }, ...]. No reemplazan al titular.';

CREATE OR REPLACE FUNCTION public.rpc_update_admin_customer(
  p_customer_id uuid,
  p_full_name text,
  p_email text DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_dni text DEFAULT NULL,
  p_address text DEFAULT NULL,
  p_city text DEFAULT NULL,
  p_province text DEFAULT NULL,
  p_additional_names jsonb DEFAULT '[]'::jsonb
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_admin_check boolean;
  v_additional_names jsonb;
BEGIN
  SELECT EXISTS(SELECT 1 FROM public.admins WHERE user_id = auth.uid()) INTO v_admin_check;
  IF NOT v_admin_check THEN
    RETURN json_build_object('success', false, 'message', 'No autorizado. Solo administradores pueden actualizar clientes.');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.customers WHERE id = p_customer_id) THEN
    RETURN json_build_object('success', false, 'message', 'Cliente no encontrado');
  END IF;

  IF p_additional_names IS NULL THEN
    v_additional_names := '[]'::jsonb;
  ELSIF jsonb_typeof(p_additional_names) <> 'array' THEN
    RETURN json_build_object('success', false, 'message', 'Nombres adicionales inválidos');
  ELSIF jsonb_array_length(p_additional_names) > 3 THEN
    RETURN json_build_object('success', false, 'message', 'Máximo 3 nombres adicionales');
  ELSE
    v_additional_names := p_additional_names;
  END IF;

  UPDATE public.customers
  SET
    full_name = p_full_name,
    email = COALESCE(p_email, email),
    phone = p_phone,
    dni = COALESCE(p_dni, dni),
    address = p_address,
    city = p_city,
    province = p_province,
    additional_names = v_additional_names,
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

CREATE OR REPLACE FUNCTION public.rpc_create_admin_customer(
  p_full_name text,
  p_email text DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_dni text DEFAULT NULL,
  p_address text DEFAULT NULL,
  p_city text DEFAULT NULL,
  p_province text DEFAULT NULL,
  p_additional_names jsonb DEFAULT '[]'::jsonb
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_customer_id uuid;
  v_admin_check boolean;
  v_customer_number text;
  v_additional_names jsonb;
BEGIN
  SELECT EXISTS(SELECT 1 FROM public.admins WHERE user_id = auth.uid()) INTO v_admin_check;
  IF NOT v_admin_check THEN
    RETURN json_build_object('success', false, 'message', 'No autorizado');
  END IF;

  IF p_additional_names IS NULL THEN
    v_additional_names := '[]'::jsonb;
  ELSIF jsonb_typeof(p_additional_names) <> 'array' THEN
    RETURN json_build_object('success', false, 'message', 'Nombres adicionales inválidos');
  ELSIF jsonb_array_length(p_additional_names) > 3 THEN
    RETURN json_build_object('success', false, 'message', 'Máximo 3 nombres adicionales');
  ELSE
    v_additional_names := p_additional_names;
  END IF;

  v_customer_id := gen_random_uuid();
  SELECT public.generate_customer_number() INTO v_customer_number;

  INSERT INTO public.customers (
    id,
    customer_number,
    full_name,
    email,
    phone,
    dni,
    address,
    city,
    province,
    additional_names,
    created_by_admin,
    created_at,
    updated_at
  ) VALUES (
    v_customer_id,
    v_customer_number,
    p_full_name,
    p_email,
    p_phone,
    p_dni,
    p_address,
    p_city,
    p_province,
    v_additional_names,
    true,
    now(),
    now()
  );

  RETURN json_build_object(
    'success', true,
    'customer_id', v_customer_id,
    'customer_number', v_customer_number,
    'message', 'Cliente creado con éxito'
  );

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('success', false, 'message', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_update_admin_customer(uuid, text, text, text, text, text, text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_create_admin_customer(text, text, text, text, text, text, text, jsonb) TO authenticated;

SELECT pg_notify('pgrst', 'reload schema');
