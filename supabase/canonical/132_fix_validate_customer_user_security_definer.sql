-- 132_fix_validate_customer_user_security_definer.sql
-- Error al guardar perfil (modal / complete-profile): "permission denied for table users"
--
-- Causa: validate_customer_user_trigger (canonical 36) ejecuta SELECT en auth.users
-- con permisos del rol invocador (authenticated). Ese rol no puede leer auth.users.
--
-- Solución: la función del trigger debe ser SECURITY DEFINER y ver auth con search_path seguro.

CREATE OR REPLACE FUNCTION public.validate_customer_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_catalog
AS $$
BEGIN
  IF COALESCE(NEW.created_by_admin, false) = false THEN
    IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = NEW.id) THEN
      RAISE EXCEPTION 'El cliente debe tener un usuario en auth.users o ser creado por admin';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Opcional: asegurar dueño con privilegios (en Supabase SQL Editor suele ser postgres)
-- ALTER FUNCTION public.validate_customer_user() OWNER TO postgres;

COMMENT ON FUNCTION public.validate_customer_user() IS
  'BEFORE INSERT/UPDATE customers: valida que id exista en auth.users salvo created_by_admin. SECURITY DEFINER para leer auth.users.';

SELECT pg_notify('pgrst', 'reload schema');
