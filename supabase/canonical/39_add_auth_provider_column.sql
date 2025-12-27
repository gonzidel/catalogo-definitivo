-- 39_add_auth_provider_column.sql — Agregar columna auth_provider a customers
-- Este script agrega la columna auth_provider y sincroniza los datos desde auth.users

-- 1. Agregar columna auth_provider si no existe
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'customers' 
    AND column_name = 'auth_provider'
  ) THEN
    ALTER TABLE public.customers ADD COLUMN auth_provider text;
    RAISE NOTICE 'Columna auth_provider agregada';
  ELSE
    RAISE NOTICE 'Columna auth_provider ya existe';
  END IF;
END $$;

-- 2. Función para obtener el provider desde auth.users
-- En Supabase, el provider se encuentra en auth.identities
CREATE OR REPLACE FUNCTION public.get_auth_provider(p_user_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
DECLARE
  v_provider text;
  v_identity_provider text;
BEGIN
  -- Si el usuario no existe en auth.users, retornar null
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id) THEN
    RETURN NULL;
  END IF;
  
  -- Obtener el provider desde auth.identities (tabla que contiene los métodos de autenticación)
  -- Buscar la identidad principal (is_primary = true) o la primera disponible
  SELECT provider INTO v_identity_provider
  FROM auth.identities
  WHERE user_id = p_user_id
  ORDER BY created_at ASC
  LIMIT 1;
  
  -- Si no se encuentra en identities, intentar desde raw_app_meta_data
  IF v_identity_provider IS NULL THEN
    SELECT raw_app_meta_data->>'provider' INTO v_provider
    FROM auth.users
    WHERE id = p_user_id;
    
    IF v_provider IS NOT NULL THEN
      v_identity_provider := v_provider;
    END IF;
  END IF;
  
  -- Mapear providers comunes
  IF v_identity_provider IS NULL THEN
    RETURN NULL;
  ELSIF v_identity_provider = 'google' OR v_identity_provider = 'google.com' THEN
    RETURN 'google';
  ELSIF v_identity_provider = 'email' OR v_identity_provider = 'magiclink' THEN
    -- En Supabase, magic link y email pueden usar el mismo provider 'email'
    -- Verificamos si tiene email_verified para distinguir
    IF EXISTS (
      SELECT 1 FROM auth.users 
      WHERE id = p_user_id 
      AND email_confirmed_at IS NOT NULL
      AND raw_app_meta_data->>'provider' = 'email'
    ) THEN
      -- Verificar si fue magic link o email normal
      -- Magic link generalmente no tiene password_hash
      IF EXISTS (
        SELECT 1 FROM auth.users 
        WHERE id = p_user_id 
        AND encrypted_password IS NULL
      ) THEN
        RETURN 'magiclink';
      ELSE
        RETURN 'email';
      END IF;
    ELSE
      RETURN 'email';
    END IF;
  ELSE
    -- Retornar el provider tal cual si no es uno de los conocidos
    RETURN v_identity_provider;
  END IF;
END;
$$;

-- 3. Función para sincronizar auth_provider de un customer específico
CREATE OR REPLACE FUNCTION public.sync_customer_auth_provider(p_customer_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_provider text;
  v_created_by_admin boolean;
BEGIN
  -- Verificar si fue creado por admin
  SELECT created_by_admin INTO v_created_by_admin
  FROM public.customers
  WHERE id = p_customer_id;
  
  IF v_created_by_admin = true THEN
    -- Si fue creado por admin, el provider es 'admin'
    UPDATE public.customers
    SET auth_provider = 'admin'
    WHERE id = p_customer_id;
    RETURN 'admin';
  END IF;
  
  -- Obtener el provider desde auth.users
  v_provider := public.get_auth_provider(p_customer_id);
  
  -- Actualizar el customer
  UPDATE public.customers
  SET auth_provider = v_provider
  WHERE id = p_customer_id;
  
  RETURN v_provider;
END;
$$;

-- 4. Función para sincronizar todos los customers existentes
CREATE OR REPLACE FUNCTION public.sync_all_customers_auth_provider()
RETURNS TABLE(
  customer_id uuid,
  auth_provider text,
  status text
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  customer_record RECORD;
  v_provider text;
  v_created_by_admin boolean;
BEGIN
  -- Iterar sobre todos los customers
  FOR customer_record IN 
    SELECT id, created_by_admin
    FROM public.customers
  LOOP
    BEGIN
      -- Si fue creado por admin
      IF customer_record.created_by_admin = true THEN
        UPDATE public.customers
        SET auth_provider = 'admin'
        WHERE id = customer_record.id;
        
        customer_id := customer_record.id;
        auth_provider := 'admin';
        status := 'updated';
        RETURN NEXT;
      ELSE
        -- Obtener provider desde auth.users
        v_provider := public.get_auth_provider(customer_record.id);
        
        -- Actualizar
        UPDATE public.customers
        SET auth_provider = v_provider
        WHERE id = customer_record.id;
        
        customer_id := customer_record.id;
        auth_provider := v_provider;
        status := 'updated';
        RETURN NEXT;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      customer_id := customer_record.id;
      auth_provider := NULL;
      status := 'error: ' || SQLERRM;
      RETURN NEXT;
    END;
  END LOOP;
END;
$$;

-- 5. Trigger para actualizar auth_provider automáticamente cuando se crea un customer
-- Nota: Esto solo funciona si el customer tiene un id que existe en auth.users
CREATE OR REPLACE FUNCTION public.set_customer_auth_provider()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_provider text;
BEGIN
  -- Si fue creado por admin, establecer como 'admin'
  IF NEW.created_by_admin = true THEN
    NEW.auth_provider := 'admin';
    RETURN NEW;
  END IF;
  
  -- Si el id existe en auth.users, obtener el provider
  IF EXISTS (SELECT 1 FROM auth.users WHERE id = NEW.id) THEN
    v_provider := public.get_auth_provider(NEW.id);
    NEW.auth_provider := v_provider;
  END IF;
  
  RETURN NEW;
END;
$$;

-- Crear trigger si no existe
DROP TRIGGER IF EXISTS set_customer_auth_provider_trigger ON public.customers;
CREATE TRIGGER set_customer_auth_provider_trigger
  BEFORE INSERT OR UPDATE ON public.customers
  FOR EACH ROW
  EXECUTE FUNCTION public.set_customer_auth_provider();

-- 6. Sincronizar customers existentes
-- Ejecutar la función de sincronización
DO $$
DECLARE
  sync_result RECORD;
  total_updated integer := 0;
  total_errors integer := 0;
BEGIN
  RAISE NOTICE 'Iniciando sincronización de auth_provider para customers existentes...';
  
  FOR sync_result IN 
    SELECT * FROM public.sync_all_customers_auth_provider()
  LOOP
    IF sync_result.status LIKE 'error%' THEN
      total_errors := total_errors + 1;
      RAISE WARNING 'Error sincronizando customer %: %', sync_result.customer_id, sync_result.status;
    ELSE
      total_updated := total_updated + 1;
    END IF;
  END LOOP;
  
  RAISE NOTICE 'Sincronización completada: % actualizados, % errores', total_updated, total_errors;
END $$;

-- 7. Otorgar permisos
GRANT EXECUTE ON FUNCTION public.get_auth_provider(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_customer_auth_provider(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_all_customers_auth_provider() TO authenticated;

-- 8. Recargar esquema
SELECT pg_notify('pgrst', 'reload schema');

-- 9. Verificar resultados
SELECT 
  auth_provider,
  COUNT(*) as cantidad
FROM public.customers
GROUP BY auth_provider
ORDER BY cantidad DESC;

