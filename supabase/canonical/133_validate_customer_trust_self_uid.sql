-- 133_validate_customer_trust_self_uid.sql
-- Error: "El cliente debe tener un usuario en auth.users o ser creado por admin"
-- al guardar perfil (rpc_upsert_customer) estando logueado.
--
-- Causa: dentro de SECURITY DEFINER a veces la consulta a auth.users no refleja al usuario
-- o el contexto JWT no coincide; para altas donde customers.id = auth.uid() es seguro omitir
-- la lectura a auth.users (el usuario ya está autenticado en esa petición).

CREATE OR REPLACE FUNCTION public.validate_customer_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_catalog
AS $$
BEGIN
  IF COALESCE(NEW.created_by_admin, false) = true THEN
    RETURN NEW;
  END IF;

  -- Registro / actualización del propio usuario (flujo catálogo / rpc_upsert_customer)
  IF auth.uid() IS NOT NULL AND NEW.id = auth.uid() THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = NEW.id) THEN
    RAISE EXCEPTION 'El cliente debe tener un usuario en auth.users o ser creado por admin';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.validate_customer_user() IS
  'BEFORE INSERT/UPDATE customers: omite lectura auth.users si NEW.id = auth.uid() (autoregistro).';

SELECT pg_notify('pgrst', 'reload schema');
