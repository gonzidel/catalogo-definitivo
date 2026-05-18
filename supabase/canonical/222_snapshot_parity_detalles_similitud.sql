-- 222_snapshot_parity_detalles_similitud.sql
--
-- Garantiza paridad estructural entre catalog_public_available_view y
-- catalog_public_snapshot: columnas (incl. "DetallesSimilitud", variant_id),
-- orden ordinal y tipos compatibles con INSERT SELECT * y rpc_refresh.
--
-- DEPLOY (staging-first, tras 221):
--   1) 220_curated_product_banners_schema.sql
--   2) 221_catalog_public_available_view_add_variant_id.sql
--   3) Este archivo
--
-- Idempotente: si ya hay paridad y el probe INSERT SELECT * pasa, no-op.
-- Si reconstruye: deja catalog_public_snapshot__pre_222_backup para rollback.
--
-- Rollback: 222_ROLLBACK_snapshot_parity_detalles_similitud.sql

-- ---------------------------------------------------------------------------
-- 1) Detección de paridad (nombre + orden + tipo por ordinal_position)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fyl_catalog_snapshot_has_view_parity()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT coalesce(
    (
      SELECT count(*) = 0
      FROM (
        SELECT
          c.ordinal_position,
          c.column_name,
          c.data_type,
          c.udt_name
        FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'catalog_public_available_view'
      ) v
      FULL OUTER JOIN (
        SELECT
          c.ordinal_position,
          c.column_name,
          c.data_type,
          c.udt_name
        FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'catalog_public_snapshot'
      ) s USING (ordinal_position)
      WHERE v.column_name IS DISTINCT FROM s.column_name
         OR v.data_type IS DISTINCT FROM s.data_type
         OR v.udt_name IS DISTINCT FROM s.udt_name
    ),
    false
  );
$$;

COMMENT ON FUNCTION public.fyl_catalog_snapshot_has_view_parity() IS
  'true si catalog_public_snapshot tiene las mismas columnas (orden/tipo) que catalog_public_available_view.';

-- ---------------------------------------------------------------------------
-- 2) Probe: INSERT SELECT * (0 filas) — falla si hay desalineación posicional
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fyl_catalog_snapshot_insert_select_star_ok()
RETURNS boolean
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF to_regclass('public.catalog_public_available_view') IS NULL
     OR to_regclass('public.catalog_public_snapshot') IS NULL THEN
    RETURN false;
  END IF;

  BEGIN
    CREATE TEMP TABLE _fyl_snapshot_star_probe
      (LIKE public.catalog_public_snapshot INCLUDING ALL)
      ON COMMIT DROP;
    INSERT INTO _fyl_snapshot_star_probe
    SELECT * FROM public.catalog_public_available_view
    LIMIT 0;
    RETURN true;
  EXCEPTION
    WHEN OTHERS THEN
      RETURN false;
  END;
END;
$$;

COMMENT ON FUNCTION public.fyl_catalog_snapshot_insert_select_star_ok() IS
  'true si INSERT INTO snapshot SELECT * FROM available_view (LIMIT 0) no lanza error de tipos/orden.';

-- ---------------------------------------------------------------------------
-- 3) Rebuild + refresh seguro (SECURITY DEFINER — uso admin/migración)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fyl_rebuild_catalog_public_snapshot_parity(
  p_refresh_from_view boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_rows integer := 0;
  v_rebuilt boolean := false;
BEGIN
  IF public.fyl_catalog_snapshot_has_view_parity()
     AND public.fyl_catalog_snapshot_insert_select_star_ok() THEN
    RETURN jsonb_build_object(
      'rebuilt', false,
      'refreshed', false,
      'reason', 'already_in_parity'
    );
  END IF;

  IF to_regclass('public.catalog_public_available_view') IS NULL THEN
    RAISE EXCEPTION 'catalog_public_available_view no existe; aplicar 221 antes que 222';
  END IF;

  -- Backup para rollback 222 (solo si hay tabla actual)
  DROP TABLE IF EXISTS public.catalog_public_snapshot__pre_222_backup;
  IF to_regclass('public.catalog_public_snapshot') IS NOT NULL THEN
    EXECUTE 'CREATE TABLE public.catalog_public_snapshot__pre_222_backup AS SELECT * FROM public.catalog_public_snapshot';
  END IF;

  DROP TABLE IF EXISTS public.catalog_public_snapshot__rebuild;
  CREATE TABLE public.catalog_public_snapshot__rebuild
    (LIKE public.catalog_public_available_view INCLUDING DEFAULTS);

  IF p_refresh_from_view THEN
    INSERT INTO public.catalog_public_snapshot__rebuild
    SELECT * FROM public.catalog_public_available_view;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
  ELSIF to_regclass('public.catalog_public_snapshot__pre_222_backup') IS NOT NULL THEN
    -- Fallback: copiar por nombre desde backup (orden legacy desconocido)
    EXECUTE $ins$
      INSERT INTO public.catalog_public_snapshot__rebuild (
        "Categoria", "Articulo", "Descripcion", "Color", "Numeracion", "FechaIngreso",
        "Mostrar", "Oferta", "Precio", "Imagen Principal", "Imagen 1", "Imagen 2", "Imagen 3",
        "Filtro1", "Filtro2", "Filtro3",
        "DetallesSimilitud",
        "OfertaActiva", "PrecioOferta", "PromoActiva",
        "OfferCampaignId", "OfferImageUrl", "OfferTitle",
        "ColorHex", "ColorDisplayNumber", "SupplierCode",
        variant_id
      )
      SELECT
        b."Categoria", b."Articulo", b."Descripcion", b."Color", b."Numeracion", b."FechaIngreso",
        b."Mostrar", b."Oferta", b."Precio", b."Imagen Principal", b."Imagen 1", b."Imagen 2", b."Imagen 3",
        b."Filtro1", b."Filtro2", b."Filtro3",
        coalesce(b."DetallesSimilitud", ''::text),
        b."OfertaActiva", b."PrecioOferta", b."PromoActiva",
        b."OfferCampaignId", b."OfferImageUrl", b."OfferTitle",
        b."ColorHex", b."ColorDisplayNumber", b."SupplierCode",
        b.variant_id
      FROM public.catalog_public_snapshot__pre_222_backup b
    $ins$;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
  END IF;

  DROP TABLE IF EXISTS public.catalog_public_snapshot;
  ALTER TABLE public.catalog_public_snapshot__rebuild
    RENAME TO catalog_public_snapshot;

  v_rebuilt := true;

  -- RLS + grants (idempotente; patrón 213)
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

  IF p_refresh_from_view AND to_regclass('public.catalog_public_snapshot_meta') IS NOT NULL THEN
    INSERT INTO public.catalog_public_snapshot_meta (id, refreshed_at, row_count)
    VALUES (true, now(), v_rows)
    ON CONFLICT (id) DO UPDATE
      SET refreshed_at = EXCLUDED.refreshed_at,
          row_count = EXCLUDED.row_count;
  END IF;

  IF NOT public.fyl_catalog_snapshot_insert_select_star_ok() THEN
    RAISE EXCEPTION 'Paridad no alcanzada tras rebuild de catalog_public_snapshot';
  END IF;

  RETURN jsonb_build_object(
    'rebuilt', v_rebuilt,
    'refreshed', p_refresh_from_view,
    'row_count', v_rows,
    'backup_table', 'catalog_public_snapshot__pre_222_backup'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.fyl_catalog_snapshot_has_view_parity() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fyl_catalog_snapshot_insert_select_star_ok() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fyl_catalog_snapshot_has_view_parity() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fyl_catalog_snapshot_insert_select_star_ok() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.fyl_rebuild_catalog_public_snapshot_parity(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fyl_rebuild_catalog_public_snapshot_parity(boolean) TO authenticated, service_role;

COMMENT ON FUNCTION public.fyl_rebuild_catalog_public_snapshot_parity(boolean) IS
  'Recrea catalog_public_snapshot LIKE la vista, refresca desde la vista y deja backup pre-222.';

-- ---------------------------------------------------------------------------
-- 4) Apply idempotente (migración)
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_result jsonb;
BEGIN
  IF to_regclass('public.catalog_public_available_view') IS NULL THEN
    RAISE NOTICE '222: omitido — catalog_public_available_view ausente (aplicar 221 primero)';
    RETURN;
  END IF;

  v_result := public.fyl_rebuild_catalog_public_snapshot_parity(true);
  RAISE NOTICE '222 snapshot parity: %', v_result;
END;
$$;

SELECT pg_notify('pgrst', 'reload schema');
