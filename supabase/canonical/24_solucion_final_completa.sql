-- SOLUCIÓN FINAL COMPLETA
-- Ejecuta esto DESPUÉS de verificar con 23_diagnostico_completo.sql

-- PASO 1: Eliminar TODAS las constraints FK que apuntan a auth.users
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN (
        SELECT conname 
        FROM pg_constraint 
        WHERE conrelid = 'public.customers'::regclass
          AND contype = 'f'
          AND confrelid = 'auth.users'::regclass
    ) LOOP
        EXECUTE 'ALTER TABLE public.customers DROP CONSTRAINT ' || quote_ident(r.conname) || ' CASCADE';
        RAISE NOTICE 'Constraint FK eliminada: %', r.conname;
    END LOOP;
    
    IF NOT FOUND THEN
        RAISE NOTICE 'No se encontraron constraints FK para eliminar';
    END IF;
END $$;

-- PASO 2: Eliminar función anterior completamente
DROP FUNCTION IF EXISTS public.rpc_create_admin_customer CASCADE;

-- PASO 3: Verificar que generate_customer_number existe, si no, crear una versión simple
CREATE OR REPLACE FUNCTION public.generate_customer_number()
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
    v_next_number integer;
BEGIN
    SELECT COALESCE(MAX(CAST(COALESCE(NULLIF(trim(customer_number), ''), '0') AS integer)), 0) + 1
    INTO v_next_number
    FROM public.customers
    WHERE customer_number ~ '^[0-9]+$';
    
    RETURN LPAD(v_next_number::text, 4, '0');
END;
$$;

-- PASO 4: Crear función RPC para crear clientes admin
CREATE OR REPLACE FUNCTION public.rpc_create_admin_customer(
  p_full_name text,
  p_email text DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_dni text DEFAULT NULL,
  p_address text DEFAULT NULL,
  p_city text DEFAULT NULL,
  p_province text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_customer_id uuid;
  v_customer_number text;
  v_temp_uuid uuid;
BEGIN
  -- Validación de nombre
  IF p_full_name IS NULL OR trim(p_full_name) = '' THEN
    RETURN json_build_object(
      'success', false,
      'error', 'validation_error',
      'message', 'El nombre completo es obligatorio'
    );
  END IF;
  
  -- Generar UUID temporal (este UUID NO necesita existir en auth.users)
  v_temp_uuid := gen_random_uuid();
  
  -- Insertar directamente en customers
  -- IMPORTANTE: NO hay constraint FK, así que esto debería funcionar
  BEGIN
    INSERT INTO public.customers (
      id, 
      full_name, 
      email, 
      phone, 
      dni, 
      address, 
      city, 
      province,
      customer_number, 
      created_by_admin, 
      auth_provider
    )
    VALUES (
      v_temp_uuid, 
      trim(p_full_name), 
      nullif(trim(COALESCE(p_email, '')), ''),
      nullif(trim(COALESCE(p_phone, '')), ''), 
      nullif(trim(COALESCE(p_dni, '')), ''),
      nullif(trim(COALESCE(p_address, '')), ''), 
      nullif(trim(COALESCE(p_city, '')), ''),
      nullif(trim(COALESCE(p_province, '')), ''), 
      public.generate_customer_number(),
      true, 
      'admin'
    )
    RETURNING id, customer_number INTO v_customer_id, v_customer_number;
    
    -- Éxito
    RETURN json_build_object(
      'success', true,
      'customer_id', v_customer_id,
      'customer_number', v_customer_number,
      'message', 'Cliente creado exitosamente'
    );
    
  EXCEPTION 
    WHEN foreign_key_violation THEN
      -- Si todavía aparece este error, hay algo raro
      RETURN json_build_object(
        'success', false,
        'error', 'foreign_key_violation',
        'error_code', SQLSTATE,
        'error_message', SQLERRM,
        'message', 'Error inesperado: La constraint FK no debería existir. Verifica con 23_diagnostico_completo.sql',
        'hint', 'Ejecuta: SELECT conname FROM pg_constraint WHERE conrelid = ''public.customers''::regclass AND contype = ''f'''
      );
    WHEN OTHERS THEN
      RETURN json_build_object(
        'success', false,
        'error', SQLSTATE,
        'error_message', SQLERRM,
        'message', 'Error al crear cliente: ' || SQLERRM,
        'hint', 'Revisa los logs de Supabase para más detalles'
      );
  END;
END;
$$;

-- PASO 5: Dar permisos
GRANT EXECUTE ON FUNCTION public.rpc_create_admin_customer(text, text, text, text, text, text, text) 
  TO authenticated, anon;

-- PASO 6: Recargar esquema de Supabase
SELECT pg_notify('pgrst', 'reload schema');

-- PASO 7: Verificación final
DO $$
DECLARE
  v_fk_count integer;
  v_func_exists boolean;
BEGIN
  -- Verificar FK
  SELECT COUNT(*) INTO v_fk_count
  FROM pg_constraint
  WHERE conrelid = 'public.customers'::regclass
    AND contype = 'f'
    AND confrelid = 'auth.users'::regclass;
  
  -- Verificar función
  SELECT EXISTS(
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
      AND p.proname = 'rpc_create_admin_customer'
  ) INTO v_func_exists;
  
  RAISE NOTICE '=== VERIFICACIÓN FINAL ===';
  RAISE NOTICE 'Constraints FK restantes: %', v_fk_count;
  RAISE NOTICE 'Función existe: %', v_func_exists;
  
  IF v_fk_count = 0 AND v_func_exists THEN
    RAISE NOTICE '✅ TODO CORRECTO: Listo para probar';
  ELSE
    RAISE NOTICE '⚠️ ADVERTENCIA: Revisa los valores arriba';
  END IF;
END $$;
