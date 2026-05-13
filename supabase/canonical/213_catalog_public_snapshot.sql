-- 213_catalog_public_snapshot.sql
--
-- Snapshot publico compatible con catalog_public_available_view.
-- Objetivo: preparar el retiro gradual de grants anon sobre tablas operativas.

CREATE TABLE IF NOT EXISTS public.catalog_public_snapshot
  (LIKE public.catalog_public_available_view INCLUDING DEFAULTS);

CREATE TABLE IF NOT EXISTS public.catalog_public_snapshot_meta (
  id boolean PRIMARY KEY DEFAULT true,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  row_count integer NOT NULL DEFAULT 0,
  CONSTRAINT catalog_public_snapshot_meta_singleton CHECK (id)
);

ALTER TABLE public.catalog_public_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalog_public_snapshot_meta ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.catalog_public_snapshot FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.catalog_public_snapshot TO anon, authenticated;

REVOKE ALL ON TABLE public.catalog_public_snapshot_meta FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.catalog_public_snapshot_meta TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'catalog_public_snapshot'
      AND policyname = 'catalog_public_snapshot_public_select'
  ) THEN
    CREATE POLICY catalog_public_snapshot_public_select
      ON public.catalog_public_snapshot
      FOR SELECT TO anon, authenticated
      USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'catalog_public_snapshot_meta'
      AND policyname = 'catalog_public_snapshot_meta_admin_select'
  ) THEN
    CREATE POLICY catalog_public_snapshot_meta_admin_select
      ON public.catalog_public_snapshot_meta
      FOR SELECT TO authenticated
      USING (public.is_admin());
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.rpc_refresh_catalog_public_snapshot()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_rows integer := 0;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Solo administradores pueden refrescar el snapshot publico de catalogo';
  END IF;

  TRUNCATE TABLE public.catalog_public_snapshot;

  INSERT INTO public.catalog_public_snapshot
  SELECT * FROM public.catalog_public_available_view;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  INSERT INTO public.catalog_public_snapshot_meta (id, refreshed_at, row_count)
  VALUES (true, now(), v_rows)
  ON CONFLICT (id) DO UPDATE
    SET refreshed_at = EXCLUDED.refreshed_at,
        row_count = EXCLUDED.row_count;

  RETURN json_build_object(
    'success', true,
    'row_count', v_rows,
    'refreshed_at', now()
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.rpc_refresh_catalog_public_snapshot() FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_refresh_catalog_public_snapshot() TO authenticated, service_role;

TRUNCATE TABLE public.catalog_public_snapshot;
INSERT INTO public.catalog_public_snapshot
SELECT * FROM public.catalog_public_available_view;

INSERT INTO public.catalog_public_snapshot_meta (id, refreshed_at, row_count)
SELECT true, now(), count(*)::integer
FROM public.catalog_public_snapshot
ON CONFLICT (id) DO UPDATE
  SET refreshed_at = EXCLUDED.refreshed_at,
      row_count = EXCLUDED.row_count;

SELECT pg_notify('pgrst', 'reload schema');
