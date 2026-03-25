-- Fix for "permission denied for table users" error
-- This error occurs because the trigger function `set_customer_auth_provider` attempts to access `auth.users`
-- but it was missing the SECURITY DEFINER attribute, so it ran with the permissions of the authenticated user.

-- We redefine the function with SECURITY DEFINER and correct search_path.

CREATE OR REPLACE FUNCTION public.set_customer_auth_provider()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_provider text;
BEGIN
  -- Si fue creado por admin, establecer como 'admin'
  -- Verificamos si la columna existe en NEW (por si acaso)
  BEGIN
    IF NEW.created_by_admin = true THEN
      NEW.auth_provider := 'admin';
      RETURN NEW;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Si la columna created_by_admin no existe, ignorar
    NULL;
  END;
  
  -- Si el id existe en auth.users, obtener el provider
  -- Al ser SECURITY DEFINER, ahora sí tenemos permiso para consultar auth.users
  IF EXISTS (SELECT 1 FROM auth.users WHERE id = NEW.id) THEN
    -- Usamos la función helper que ya es security definer
    v_provider := public.get_auth_provider(NEW.id);
    NEW.auth_provider := v_provider;
  END IF;
  
  RETURN NEW;
END;
$$;

-- Notificar para recargar el esquema caché de PostgREST
SELECT pg_notify('pgrst', 'reload schema');

DO $$
BEGIN
    RAISE NOTICE '✅ Función set_customer_auth_provider actualizada con SECURITY DEFINER';
END $$;
