-- 362_ROLLBACK_rollout_experience.sql
-- Revierte 362 por completo. Borra las asignaciones full registradas.
--
-- ANTES de ejecutar en producción con tráfico real:
--   1. Poner el middleware en ROLLOUT_FORCE_MODE=kill (o sacar el deploy) para que
--      nadie llame a las RPC mientras se borran.
--   2. Exportar el historial si se quiere conservar (paso 0). Sin export, los grants
--      quota/tester_link/open_all se pierden: NO es reversible en datos.
--   3. Las cookies firmadas `full` que ya tengan los navegadores siguen siendo válidas
--      para el middleware hasta que se rote ROLLOUT_COOKIE_SECRET. Rotarlo si el
--      rollback busca volver a todos a catalog.

BEGIN;

-- 0) Export opcional (descomentar): copia fuera de la API pública.
-- CREATE TABLE IF NOT EXISTS public._rollout_grants_backup_362 AS
--   SELECT * FROM public.rollout_grants;
-- REVOKE ALL ON TABLE public._rollout_grants_backup_362 FROM PUBLIC, anon, authenticated;

DROP FUNCTION IF EXISTS public.rpc_rollout_link_user(uuid, uuid);
DROP FUNCTION IF EXISTS public.rpc_rollout_resolve(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.fn_rollout_result(text, text, public.rollout_grants, date);
DROP FUNCTION IF EXISTS public.fn_rollout_staff_source(uuid);
DROP FUNCTION IF EXISTS public.fn_rollout_today();

DROP TABLE IF EXISTS public.rollout_daily_counter;
DROP TABLE IF EXISTS public.rollout_grants;
DROP TABLE IF EXISTS public.rollout_config;

COMMIT;

-- Verificación post-rollback (debe devolver 0 filas):
-- SELECT tablename FROM pg_tables
-- WHERE schemaname = 'public' AND tablename LIKE 'rollout_%';
-- SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
-- WHERE n.nspname = 'public' AND proname LIKE '%rollout%';
