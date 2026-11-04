-- 380_ROLLBACK_arq05_fase1_admin_pricing_rpcs.sql
--
-- Quita las RPC de costos. Solo es seguro si la 381 NO está aplicada
-- (con 381 aplicada, el admin queda sin forma de leer o guardar costos):
-- revertir primero la 381.

BEGIN;

SET LOCAL lock_timeout = '5s';

DROP FUNCTION IF EXISTS public.rpc_admin_set_product_pricing(uuid, numeric, boolean, numeric, numeric);
DROP FUNCTION IF EXISTS public.rpc_admin_get_product_pricing(uuid[]);

NOTIFY pgrst, 'reload schema';

COMMIT;
