-- 381_ROLLBACK_arq05_fase1_products_column_grants.sql
--
-- Restaura el ACL previo de authenticated sobre public.products
-- (authenticated=arwdxtm): SELECT, INSERT y UPDATE a nivel tabla.
-- Reabre la lectura y escritura directa de costos para cualquier sesión.
-- Usar solo si se rompe una función del admin o del catálogo.

BEGIN;

SET LOCAL lock_timeout = '5s';

REVOKE SELECT, INSERT, UPDATE ON public.products FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON public.products TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
