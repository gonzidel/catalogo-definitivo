-- Fix: "permission denied for table users" al editar perfil (customers)
-- El trigger set_customer_auth_provider accede a auth.users y falla con RLS.
-- Solución: desactivar el trigger para que rpc_upsert_customer pueda actualizar customers sin error.
-- La columna auth_provider puede quedar null; no afecta el guardado del perfil.

-- 1) Quitar el trigger (deja de ejecutarse en INSERT/UPDATE de customers)
DROP TRIGGER IF EXISTS set_customer_auth_provider_trigger ON public.customers;

-- 2) Opcional: redefinir la función para que NUNCA falle si en el futuro se vuelve a crear el trigger
--    Así, si alguien recrea el trigger, no bloqueará las actualizaciones
CREATE OR REPLACE FUNCTION public.set_customer_auth_provider()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_provider text;
BEGIN
  -- Cualquier acceso a auth.users/identities puede fallar por permisos; no propagar
  BEGIN
    SELECT provider INTO v_provider
    FROM auth.identities
    WHERE user_id = NEW.id
    ORDER BY created_at ASC
    LIMIT 1;
    IF v_provider IS NOT NULL THEN
      NEW.auth_provider := v_provider;
      RETURN NEW;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  BEGIN
    SELECT raw_app_meta_data->>'provider' INTO v_provider
    FROM auth.users
    WHERE id = NEW.id;
    IF v_provider IS NOT NULL THEN
      NEW.auth_provider := v_provider;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN NEW;
END;
$$;

-- No volver a crear el trigger aquí; así las actualizaciones de perfil no tocan auth.users
SELECT pg_notify('pgrst', 'reload schema');
