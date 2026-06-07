-- 232_expose_catalog_snapshot_version_anon.sql
--
-- Fase 1.5 (OPCIONAL — requiere aprobación explícita antes de aplicar en prod)
--
-- Objetivo: permitir que el catálogo público (rol anon) lea refreshed_at del snapshot
-- para invalidación precisa de la cache SWR local en background.
--
-- Riesgo: bajo — solo expone refreshed_at y row_count (metadatos de refresh, no datos de producto).
--
-- Rollback:
--   REVOKE SELECT ON TABLE public.catalog_public_snapshot_meta FROM anon;
--   -- o DROP FUNCTION public.rpc_catalog_public_version(); si se usa la RPC

-- Opción A (recomendada): RPC mínima de solo lectura
CREATE OR REPLACE FUNCTION public.rpc_catalog_public_version()
RETURNS json
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT json_build_object(
    'refreshed_at', m.refreshed_at,
    'row_count', m.row_count
  )
  FROM public.catalog_public_snapshot_meta m
  WHERE m.id IS TRUE
  LIMIT 1;
$$;

REVOKE EXECUTE ON FUNCTION public.rpc_catalog_public_version() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_catalog_public_version() TO anon, authenticated;

-- Opción B (alternativa, comentada): grant directo sobre meta
-- GRANT SELECT (refreshed_at, row_count) ON TABLE public.catalog_public_snapshot_meta TO anon;
-- CREATE POLICY catalog_public_snapshot_meta_anon_select
--   ON public.catalog_public_snapshot_meta
--   FOR SELECT TO anon
--   USING (true);

SELECT pg_notify('pgrst', 'reload schema');
