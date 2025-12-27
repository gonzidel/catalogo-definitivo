-- 36_fix_customers_admin_module.sql — Corregir módulo de clientes para admins
-- Este script corrige los problemas para que los admins puedan crear, ver y editar clientes

-- 1. Eliminar la restricción de clave foránea que requiere que el id exista en auth.users
-- Esto permite que los admins creen clientes con UUIDs temporales
DO $$
BEGIN
  -- Verificar si existe la restricción
  IF EXISTS (
    SELECT 1 
    FROM information_schema.table_constraints 
    WHERE constraint_schema = 'public' 
    AND table_name = 'customers' 
    AND constraint_type = 'FOREIGN KEY'
    AND constraint_name LIKE '%auth_users%'
  ) THEN
    -- Eliminar la restricción de clave foránea
    ALTER TABLE public.customers 
    DROP CONSTRAINT IF EXISTS customers_id_fkey;
    
    RAISE NOTICE 'Restricción de clave foránea eliminada';
  ELSE
    RAISE NOTICE 'No se encontró restricción de clave foránea en customers';
  END IF;
END $$;

-- 2. Crear un trigger que valide que el id existe en auth.users solo si no es un cliente creado por admin
-- (Esto es una validación lógica, no una restricción de base de datos)
CREATE OR REPLACE FUNCTION public.validate_customer_user()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Si el cliente tiene created_by_admin = true, permitir cualquier UUID
  -- Si no, validar que existe en auth.users
  IF COALESCE(NEW.created_by_admin, false) = false THEN
    IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = NEW.id) THEN
      RAISE EXCEPTION 'El cliente debe tener un usuario en auth.users o ser creado por admin';
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$;

-- Eliminar trigger anterior si existe
DROP TRIGGER IF EXISTS validate_customer_user_trigger ON public.customers;

-- Crear el trigger
CREATE TRIGGER validate_customer_user_trigger
  BEFORE INSERT OR UPDATE ON public.customers
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_customer_user();

-- 3. Agregar columna created_by_admin si no existe
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'customers' 
    AND column_name = 'created_by_admin'
  ) THEN
    ALTER TABLE public.customers ADD COLUMN created_by_admin boolean DEFAULT false;
    RAISE NOTICE 'Columna created_by_admin agregada';
  ELSE
    RAISE NOTICE 'Columna created_by_admin ya existe';
  END IF;
END $$;

-- 4. Asegurar que las políticas RLS para admins estén correctas
-- Eliminar políticas duplicadas o incorrectas
DROP POLICY IF EXISTS customers_admin_select ON public.customers;
DROP POLICY IF EXISTS customers_admin_insert ON public.customers;
DROP POLICY IF EXISTS customers_admin_update ON public.customers;

-- Política de SELECT para admins (pueden ver todos los clientes)
CREATE POLICY customers_admin_select
ON public.customers
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.admins 
    WHERE user_id = auth.uid()
  )
);

-- Política de INSERT para admins (pueden crear clientes)
CREATE POLICY customers_admin_insert
ON public.customers
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.admins 
    WHERE user_id = auth.uid()
  )
);

-- Política de UPDATE para admins (pueden editar todos los clientes)
CREATE POLICY customers_admin_update
ON public.customers
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.admins 
    WHERE user_id = auth.uid()
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.admins 
    WHERE user_id = auth.uid()
  )
);

-- 5. Actualizar la función rpc_create_admin_customer para que:
--    - Marque created_by_admin = true
--    - Genere customer_number automáticamente (el trigger lo hará)
CREATE OR REPLACE FUNCTION public.rpc_create_admin_customer(
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
  v_customer_id uuid;
  v_admin_check boolean;
  v_customer_number text;
BEGIN
  -- Verificar si es admin
  SELECT EXISTS(SELECT 1 FROM public.admins WHERE user_id = auth.uid()) INTO v_admin_check;
  IF NOT v_admin_check THEN
    RETURN json_build_object('success', false, 'message', 'No autorizado');
  END IF;

  -- Generar ID nuevo (UUID temporal que no existe en auth.users)
  v_customer_id := gen_random_uuid();

  -- Generar número de cliente
  SELECT public.generate_customer_number() INTO v_customer_number;

  -- Insertar cliente con created_by_admin = true
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
    true, -- Marcar como creado por admin
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

-- Otorgar permisos de ejecución
GRANT EXECUTE ON FUNCTION public.rpc_create_admin_customer TO authenticated;

-- 6. Asegurar que el trigger de customer_number funcione correctamente
-- El trigger ya debería estar en 01_customers.sql, pero verificamos que exista
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger 
    WHERE tgname = 'assign_customer_number_trigger'
  ) THEN
    CREATE TRIGGER assign_customer_number_trigger
    BEFORE INSERT OR UPDATE ON public.customers
    FOR EACH ROW
    EXECUTE FUNCTION public.assign_customer_number();
    
    RAISE NOTICE 'Trigger assign_customer_number_trigger creado';
  ELSE
    RAISE NOTICE 'Trigger assign_customer_number_trigger ya existe';
  END IF;
END $$;

-- 7. Recargar esquema
SELECT pg_notify('pgrst', 'reload schema');

-- 8. Verificar políticas finales
SELECT 
    policyname as "Nombre de Política",
    cmd as "Comando",
    CASE 
        WHEN with_check IS NOT NULL THEN 'WITH CHECK: ' || with_check
        WHEN qual IS NOT NULL THEN 'USING: ' || qual
        ELSE 'Sin condición'
    END as "Condición"
FROM pg_policies
WHERE schemaname = 'public' 
  AND tablename = 'customers'
ORDER BY policyname;

