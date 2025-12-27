-- 40_bulk_create_customers.sql — Función RPC para creación masiva de clientes
-- Esta función permite a los admins importar múltiples clientes de una vez desde CSV

CREATE OR REPLACE FUNCTION public.rpc_bulk_create_customers(
  p_customers jsonb
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_admin_check boolean;
  v_customer jsonb;
  v_customer_id uuid;
  v_customer_number text;
  v_full_name text;
  v_phone text;
  v_address text;
  v_city text;
  v_province text;
  v_dni text;
  v_email text;
  v_success_count integer := 0;
  v_error_count integer := 0;
  v_errors jsonb := '[]'::jsonb;
  v_result jsonb;
  v_error_message text;
BEGIN
  -- Verificar si es admin (permite service_role key que bypasea auth)
  -- Si auth.uid() es NULL (service_role), permitir acceso
  IF auth.uid() IS NOT NULL THEN
    SELECT EXISTS(SELECT 1 FROM public.admins WHERE user_id = auth.uid()) INTO v_admin_check;
    IF NOT v_admin_check THEN
      RETURN json_build_object(
        'success', false,
        'message', 'No autorizado',
        'total', 0,
        'created', 0,
        'errors', 0
      );
    END IF;
  END IF;
  -- Si auth.uid() IS NULL, asumimos que es service_role (admin)

  -- Verificar que p_customers sea un array
  IF jsonb_typeof(p_customers) != 'array' THEN
    RETURN json_build_object(
      'success', false,
      'message', 'Los datos deben ser un array de clientes',
      'total', 0,
      'created', 0,
      'errors', 0
    );
  END IF;

  -- Iterar sobre cada cliente
  FOR v_customer IN SELECT * FROM jsonb_array_elements(p_customers)
  LOOP
    BEGIN
      -- Extraer datos del cliente
      v_full_name := COALESCE(v_customer->>'full_name', '');
      v_phone := COALESCE(v_customer->>'phone', '');
      v_address := COALESCE(v_customer->>'address', '');
      v_city := COALESCE(v_customer->>'city', '');
      v_province := COALESCE(v_customer->>'province', '');
      v_dni := v_customer->>'dni';
      v_email := v_customer->>'email';

      -- Validaciones básicas
      IF v_full_name IS NULL OR trim(v_full_name) = '' THEN
        v_error_message := 'Nombre completo requerido';
        RAISE EXCEPTION '%', v_error_message;
      END IF;

      IF v_phone IS NULL OR trim(v_phone) = '' THEN
        v_error_message := 'Teléfono requerido';
        RAISE EXCEPTION '%', v_error_message;
      END IF;

      IF v_address IS NULL OR trim(v_address) = '' THEN
        v_error_message := 'Dirección requerida';
        RAISE EXCEPTION '%', v_error_message;
      END IF;

      IF v_city IS NULL OR trim(v_city) = '' THEN
        v_error_message := 'Ciudad requerida';
        RAISE EXCEPTION '%', v_error_message;
      END IF;

      IF v_province IS NULL OR trim(v_province) = '' THEN
        v_error_message := 'Provincia requerida';
        RAISE EXCEPTION '%', v_error_message;
      END IF;

      -- Generar ID nuevo (UUID temporal que no existe en auth.users)
      v_customer_id := gen_random_uuid();

      -- Generar número de cliente automáticamente
      SELECT public.generate_customer_number() INTO v_customer_number;

      -- Insertar cliente con created_by_admin = true y auth_provider = 'admin'
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
        created_by_admin,
        auth_provider,
        created_at,
        updated_at
      ) VALUES (
        v_customer_id,
        v_customer_number,
        trim(v_full_name),
        NULLIF(trim(COALESCE(v_email, '')), ''),
        trim(v_phone),
        NULLIF(trim(COALESCE(v_dni, '')), ''),
        trim(v_address),
        trim(v_city),
        trim(v_province),
        true,
        'admin',
        now(),
        now()
      );

      v_success_count := v_success_count + 1;

    EXCEPTION WHEN OTHERS THEN
      v_error_count := v_error_count + 1;
      v_error_message := SQLERRM;
      
      -- Agregar error a la lista
      v_errors := v_errors || jsonb_build_object(
        'customer', v_customer,
        'error', v_error_message
      );
    END;
  END LOOP;

  -- Retornar resultados
  RETURN json_build_object(
    'success', true,
    'total', jsonb_array_length(p_customers),
    'created', v_success_count,
    'errors', v_error_count,
    'error_details', v_errors,
    'message', format('Importación completada: %s creados, %s errores', v_success_count, v_error_count)
  );

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object(
    'success', false,
    'message', SQLERRM,
    'total', 0,
    'created', 0,
    'errors', 0
  );
END;
$$;

-- Otorgar permisos de ejecución
GRANT EXECUTE ON FUNCTION public.rpc_bulk_create_customers(jsonb) TO authenticated;

-- Recargar esquema
SELECT pg_notify('pgrst', 'reload schema');

