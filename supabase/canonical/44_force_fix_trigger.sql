-- SOLUCIÓN RADICAL: Eliminar el trigger problemático si actualizarlo no funciona
-- A veces PostgreSQL mantiene permisos cacheados o hay dependencias ocultas

DROP TRIGGER IF EXISTS set_customer_auth_provider_trigger ON public.customers;
DROP FUNCTION IF EXISTS public.set_customer_auth_provider();

-- Recrear la función desde cero con permisos explícitos y search_path limpio
CREATE OR REPLACE FUNCTION public.set_customer_auth_provider()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_provider text;
BEGIN
  -- Verificar si es inserción y si existe la columna (prevención de errores)
  BEGIN
    IF TG_OP = 'INSERT' AND NEW.created_by_admin = true THEN
      NEW.auth_provider := 'admin';
      RETURN NEW;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Ignorar si la columna no existe
    NULL;
  END;

  -- Acceso seguro a auth.users gracias a SECURITY DEFINER
  -- Usamos un bloque anónimo para capturar cualquier error de permiso residual
  BEGIN
    SELECT provider INTO v_provider
    FROM auth.identities
    WHERE user_id = NEW.id
    ORDER BY created_at ASC
    LIMIT 1;
    
    IF v_provider IS NOT NULL THEN
      NEW.auth_provider := v_provider;
    ELSE
      -- Fallback a auth.users metadatos
      SELECT raw_app_meta_data->>'provider' INTO v_provider
      FROM auth.users
      WHERE id = NEW.id;
      
      IF v_provider IS NOT NULL THEN
        NEW.auth_provider := v_provider;
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Si falla por permisos, simplemente no seteamos el provider pero permitimos la inserción/update
    -- Esto es crítico para no bloquear la operación principal
    RAISE WARNING 'No se pudo obtener el provider para el usuario %: %', NEW.id, SQLERRM;
  END;

  RETURN NEW;
END;
$$;

-- Volver a crear el trigger
CREATE TRIGGER set_customer_auth_provider_trigger
  BEFORE INSERT OR UPDATE ON public.customers
  FOR EACH ROW
  EXECUTE FUNCTION public.set_customer_auth_provider();

-- Notificar recarga
SELECT pg_notify('pgrst', 'reload schema');

DO $$
BEGIN
    RAISE NOTICE '✅ Trigger recreado desde cero con manejo de errores robusto';
END $$;
