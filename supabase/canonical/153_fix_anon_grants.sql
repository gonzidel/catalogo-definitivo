-- 153_fix_anon_grants.sql
-- Revoca acceso EXECUTE a anon en funciones SECURITY DEFINER que manejan datos de clientes.
--
-- Origen: 26_sistema_vinculacion_completo.sql (lineas 254-255) otorgaba EXECUTE a anon
-- en get_customer_id_for_user y rpc_link_or_create_customer.
--
-- El flujo OAuth completa con JWT authenticated antes de llamar estas funciones,
-- por lo que el grant a anon es innecesario y representa superficie de ataque.
-- Los RPCs de vinculacion solo deben ser accesibles para usuarios autenticados.

-- ============================================================================
-- SECCION 1: Revocar EXECUTE de anon en funciones de vinculacion de clientes
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'get_customer_id_for_user'
  ) THEN
    REVOKE EXECUTE ON FUNCTION public.get_customer_id_for_user(uuid) FROM anon;
    RAISE NOTICE 'get_customer_id_for_user: EXECUTE revocado de anon';
  ELSE
    RAISE NOTICE 'get_customer_id_for_user: funcion no existe, omitiendo';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'rpc_link_or_create_customer'
  ) THEN
    REVOKE EXECUTE ON FUNCTION public.rpc_link_or_create_customer(uuid, text, text, text, text) FROM anon;
    RAISE NOTICE 'rpc_link_or_create_customer: EXECUTE revocado de anon';
  ELSE
    RAISE NOTICE 'rpc_link_or_create_customer: funcion no existe, omitiendo';
  END IF;
END $$;

-- ============================================================================
-- SECCION 2: Verificacion
-- ============================================================================

-- Debe devolver 0 filas para anon en estas funciones
SELECT
  n.nspname AS schema_name,
  p.proname AS function_name,
  acl.grantee,
  acl.privilege_type
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
WHERE n.nspname = 'public'
  AND p.proname IN ('get_customer_id_for_user', 'rpc_link_or_create_customer')
  AND acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'anon')
ORDER BY p.proname;

-- Recargar esquema PostgREST
SELECT pg_notify('pgrst', 'reload schema');
