-- 332_ROLLBACK_catalog_snapshot_dirty_refresh.sql
-- Quita dirty/cron/triggers de Fase 5. Restaura refresh admin 213 y version 232.
-- No toca catalog_public_snapshot ni la vista 330.

DO $$
BEGIN
  PERFORM cron.unschedule('catalog-snapshot-refresh-if-dirty');
EXCEPTION
  WHEN OTHERS THEN
    NULL;
END $$;

DROP TRIGGER IF EXISTS trg_catalog_snap_dirty_vss ON public.variant_size_warehouse_stock;
DROP TRIGGER IF EXISTS trg_catalog_snap_dirty_products ON public.products;
DROP TRIGGER IF EXISTS trg_catalog_snap_dirty_variants ON public.product_variants;
DROP TRIGGER IF EXISTS trg_catalog_snap_dirty_images ON public.variant_images;
DROP TRIGGER IF EXISTS trg_catalog_snap_dirty_colors ON public.colors;
DROP TRIGGER IF EXISTS trg_catalog_snap_dirty_suppliers ON public.suppliers;
DROP TRIGGER IF EXISTS trg_catalog_snap_dirty_product_tags ON public.product_tags;
DROP TRIGGER IF EXISTS trg_catalog_snap_dirty_product_tag_details ON public.product_tag_details;
DROP TRIGGER IF EXISTS trg_catalog_snap_dirty_tags ON public.tags;
DROP TRIGGER IF EXISTS trg_catalog_snap_dirty_offers ON public.color_price_offers;
DROP TRIGGER IF EXISTS trg_catalog_snap_dirty_promotions ON public.promotions;
DROP TRIGGER IF EXISTS trg_catalog_snap_dirty_promotion_items ON public.promotion_items;
DROP TRIGGER IF EXISTS trg_catalog_snap_dirty_warehouses ON public.warehouses;

DROP FUNCTION IF EXISTS public.fn_trg_catalog_snapshot_dirty_vss();
DROP FUNCTION IF EXISTS public.fn_trg_catalog_snapshot_dirty();
DROP FUNCTION IF EXISTS public.rpc_catalog_snapshot_observability();
DROP FUNCTION IF EXISTS public.rpc_refresh_catalog_snapshot_if_dirty();
DROP FUNCTION IF EXISTS public.fn_catalog_snapshot_rebuild();
DROP FUNCTION IF EXISTS public.fn_mark_catalog_snapshot_dirty();

ALTER TABLE public.catalog_public_snapshot_meta
  DROP COLUMN IF EXISTS dirty,
  DROP COLUMN IF EXISTS dirty_since,
  DROP COLUMN IF EXISTS change_revision,
  DROP COLUMN IF EXISTS last_refresh_at,
  DROP COLUMN IF EXISTS last_success_at,
  DROP COLUMN IF EXISTS last_attempt_at,
  DROP COLUMN IF EXISTS last_error,
  DROP COLUMN IF EXISTS last_duration_ms,
  DROP COLUMN IF EXISTS last_row_count;

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

REVOKE ALL ON FUNCTION public.rpc_refresh_catalog_public_snapshot() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_refresh_catalog_public_snapshot() TO authenticated, service_role;

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

REVOKE ALL ON FUNCTION public.rpc_catalog_public_version() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_catalog_public_version() TO anon, authenticated;

SELECT pg_notify('pgrst', 'reload schema');
