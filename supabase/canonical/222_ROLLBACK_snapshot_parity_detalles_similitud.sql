-- 222_ROLLBACK_snapshot_parity_detalles_similitud.sql
--
-- Revierte la estructura de catalog_public_snapshot al estado previo a 222
-- usando catalog_public_snapshot__pre_222_backup (si existe).
--
-- NO revierte 221 (vista variant_id) ni 220 (banners curated).
-- Tras rollback: rpc_refresh puede volver a fallar si backup tenía drift;
-- ejecutar refresh manual solo si la estructura del backup es compatible con la vista.
--
-- Si no hay backup (222 fue no-op), solo elimina funciones helper.

DO $$
BEGIN
  IF to_regclass('public.catalog_public_snapshot__pre_222_backup') IS NOT NULL THEN
    DROP TABLE IF EXISTS public.catalog_public_snapshot;

    ALTER TABLE public.catalog_public_snapshot__pre_222_backup
      RENAME TO catalog_public_snapshot;

    ALTER TABLE public.catalog_public_snapshot ENABLE ROW LEVEL SECURITY;

    REVOKE ALL ON TABLE public.catalog_public_snapshot FROM PUBLIC, anon, authenticated;
    GRANT SELECT ON TABLE public.catalog_public_snapshot TO anon, authenticated;

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

    RAISE NOTICE '222 rollback: catalog_public_snapshot restaurado desde __pre_222_backup';
  ELSE
    RAISE NOTICE '222 rollback: sin backup — estructura de snapshot sin cambios';
  END IF;
END;
$$;

DROP FUNCTION IF EXISTS public.fyl_rebuild_catalog_public_snapshot_parity(boolean);
DROP FUNCTION IF EXISTS public.fyl_catalog_snapshot_insert_select_star_ok();
DROP FUNCTION IF EXISTS public.fyl_catalog_snapshot_has_view_parity();

SELECT pg_notify('pgrst', 'reload schema');
