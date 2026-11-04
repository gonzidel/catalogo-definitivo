-- 332_catalog_snapshot_dirty_refresh.sql
-- Fase 5: frescura automática de catalog_public_snapshot.
--
-- El snapshot sigue siendo SOLO cache. Autoridad = vista 330 / sellable.
-- No cambia fn_sellable_qty, fn_sellable_stock_batch, la vista, checkout ni 309.
--
-- Modelo:
--   mutación relevante → fn_mark_catalog_snapshot_dirty() (barato, revision++)
--   cron */5 → rpc_refresh_catalog_snapshot_if_dirty()
--   rebuild reutiliza TRUNCATE+INSERT de 213 en una sola transacción
--   dirty se limpia solo si change_revision no cambió durante el rebuild
--
-- VSS: un trigger STATEMENT I/U/D, sin transition tables. Hoy solo hay
-- general + venta-publico; cualquier cambio de físico marca dirty.
--
-- Rollback: 332_ROLLBACK_catalog_snapshot_dirty_refresh.sql
-- Tests:    332_catalog_snapshot_dirty_refresh_tests.sql

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ---------------------------------------------------------------------------
-- 1) Estado: extender el singleton existente
-- ---------------------------------------------------------------------------
ALTER TABLE public.catalog_public_snapshot_meta
  ADD COLUMN IF NOT EXISTS dirty boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS dirty_since timestamptz,
  ADD COLUMN IF NOT EXISTS change_revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_refresh_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_success_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS last_duration_ms integer,
  ADD COLUMN IF NOT EXISTS last_row_count integer;

COMMENT ON TABLE public.catalog_public_snapshot_meta IS
  'Singleton de frescura del snapshot público. dirty/revision = invalidación; refreshed_at = último rebuild exitoso.';

INSERT INTO public.catalog_public_snapshot_meta (id, refreshed_at, row_count)
VALUES (true, now(), 0)
ON CONFLICT (id) DO NOTHING;

UPDATE public.catalog_public_snapshot_meta
SET
  last_success_at = COALESCE(last_success_at, refreshed_at),
  last_refresh_at = COALESCE(last_refresh_at, refreshed_at),
  last_row_count = COALESCE(last_row_count, row_count),
  dirty = true,
  dirty_since = COALESCE(dirty_since, clock_timestamp()),
  change_revision = GREATEST(change_revision, 1)
WHERE id IS TRUE;

-- ---------------------------------------------------------------------------
-- 2) Marcar dirty (barato, idempotente en dirty=true, revision siempre++)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_mark_catalog_snapshot_dirty()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  INSERT INTO public.catalog_public_snapshot_meta (
    id, refreshed_at, row_count, dirty, dirty_since, change_revision
  )
  VALUES (true, now(), 0, true, clock_timestamp(), 1)
  ON CONFLICT (id) DO UPDATE
    SET dirty = true,
        dirty_since = COALESCE(
          public.catalog_public_snapshot_meta.dirty_since,
          clock_timestamp()
        ),
        change_revision = public.catalog_public_snapshot_meta.change_revision + 1;
END;
$$;

COMMENT ON FUNCTION public.fn_mark_catalog_snapshot_dirty() IS
  'Marca el snapshot público sucio e incrementa change_revision. No reconstruye. dirty_since conserva la primera marca pendiente.';

REVOKE ALL ON FUNCTION public.fn_mark_catalog_snapshot_dirty() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3) Rebuild interno (misma atomicidad que 213: TRUNCATE+INSERT en la tx)
--    Lectores esperan ACCESS EXCLUSIVE; nunca ven tabla vacía/parcial.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_catalog_snapshot_rebuild()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_rows integer := 0;
BEGIN
  TRUNCATE TABLE public.catalog_public_snapshot;

  INSERT INTO public.catalog_public_snapshot
  SELECT * FROM public.catalog_public_available_view;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  UPDATE public.catalog_public_snapshot_meta
  SET
    refreshed_at = clock_timestamp(),
    row_count = v_rows,
    last_refresh_at = clock_timestamp(),
    last_row_count = v_rows
  WHERE id IS TRUE;

  RETURN v_rows;
END;
$$;

COMMENT ON FUNCTION public.fn_catalog_snapshot_rebuild() IS
  'Reconstruye catalog_public_snapshot desde la vista live. TRUNCATE+INSERT en la misma transacción. Sin check admin.';

REVOKE ALL ON FUNCTION public.fn_catalog_snapshot_rebuild() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4) Refresh si dirty (cron / service_role). Advisory lock + revision.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_refresh_catalog_snapshot_if_dirty()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  c_lock bigint := 93215005;
  v_meta public.catalog_public_snapshot_meta%ROWTYPE;
  v_today date;
  v_last_day date;
  v_needs boolean := false;
  v_rev bigint;
  v_rows integer := 0;
  v_t0 timestamptz;
  v_ms integer;
  v_rev_after bigint;
  v_dirty_after boolean;
BEGIN
  PERFORM pg_advisory_lock(c_lock);

  BEGIN
    SELECT * INTO v_meta
    FROM public.catalog_public_snapshot_meta
    WHERE id IS TRUE
    FOR UPDATE;

    IF NOT FOUND THEN
      INSERT INTO public.catalog_public_snapshot_meta (id, dirty, change_revision)
      VALUES (true, true, 1)
      RETURNING * INTO v_meta;
    END IF;

    v_today := (timezone('America/Argentina/Buenos_Aires', clock_timestamp()))::date;
    v_last_day := (timezone(
      'America/Argentina/Buenos_Aires',
      COALESCE(v_meta.last_success_at, 'epoch'::timestamptz)
    ))::date;

    v_needs := COALESCE(v_meta.dirty, false) OR v_last_day < v_today;

    IF NOT v_needs THEN
      PERFORM pg_advisory_unlock(c_lock);
      RETURN json_build_object(
        'success', true,
        'skipped', true,
        'reason', 'clean',
        'revision', v_meta.change_revision,
        'dirty', false,
        'refreshed_at', v_meta.refreshed_at,
        'row_count', v_meta.row_count
      );
    END IF;

    v_rev := v_meta.change_revision;
    v_t0 := clock_timestamp();

    UPDATE public.catalog_public_snapshot_meta
    SET last_attempt_at = v_t0
    WHERE id IS TRUE;

    v_rows := public.fn_catalog_snapshot_rebuild();
    v_ms := GREATEST(
      0,
      (EXTRACT(EPOCH FROM (clock_timestamp() - v_t0)) * 1000)::integer
    );

    SELECT change_revision INTO v_rev_after
    FROM public.catalog_public_snapshot_meta
    WHERE id IS TRUE;

    v_dirty_after := (v_rev_after IS DISTINCT FROM v_rev);

    UPDATE public.catalog_public_snapshot_meta
    SET
      last_success_at = clock_timestamp(),
      last_duration_ms = v_ms,
      last_error = NULL,
      dirty = v_dirty_after,
      dirty_since = CASE WHEN v_dirty_after THEN COALESCE(dirty_since, clock_timestamp()) ELSE NULL END
    WHERE id IS TRUE;

    PERFORM pg_advisory_unlock(c_lock);

    RETURN json_build_object(
      'success', true,
      'skipped', false,
      'reason', CASE WHEN v_dirty_after THEN 'rebuilt_still_dirty' ELSE 'rebuilt' END,
      'row_count', v_rows,
      'duration_ms', v_ms,
      'revision_start', v_rev,
      'revision', v_rev_after,
      'dirty', v_dirty_after,
      'refreshed_at', clock_timestamp()
    );
  EXCEPTION
    WHEN OTHERS THEN
      UPDATE public.catalog_public_snapshot_meta
      SET
        last_attempt_at = COALESCE(last_attempt_at, clock_timestamp()),
        last_error = left(SQLERRM, 1000)
      WHERE id IS TRUE;
      PERFORM pg_advisory_unlock(c_lock);
      RAISE;
  END;
END;
$$;

COMMENT ON FUNCTION public.rpc_refresh_catalog_snapshot_if_dirty() IS
  'Si dirty (o cambió el día ART) reconstruye el snapshot. Un solo worker (advisory lock). Limpia dirty solo si change_revision no avanzó durante el rebuild.';

REVOKE ALL ON FUNCTION public.rpc_refresh_catalog_snapshot_if_dirty() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_refresh_catalog_snapshot_if_dirty() TO service_role;

-- ---------------------------------------------------------------------------
-- 5) RPC admin (botón Acciones rápidas): fuerza rebuild, misma carrera/lock
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_refresh_catalog_public_snapshot()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  c_lock bigint := 93215005;
  v_rev bigint;
  v_rows integer := 0;
  v_t0 timestamptz;
  v_ms integer;
  v_rev_after bigint;
  v_dirty_after boolean;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Solo administradores pueden refrescar el snapshot publico de catalogo';
  END IF;

  PERFORM pg_advisory_lock(c_lock);

  BEGIN
    PERFORM public.fn_mark_catalog_snapshot_dirty();

    SELECT change_revision INTO v_rev
    FROM public.catalog_public_snapshot_meta
    WHERE id IS TRUE
    FOR UPDATE;

    v_t0 := clock_timestamp();

    UPDATE public.catalog_public_snapshot_meta
    SET last_attempt_at = v_t0
    WHERE id IS TRUE;

    v_rows := public.fn_catalog_snapshot_rebuild();
    v_ms := GREATEST(
      0,
      (EXTRACT(EPOCH FROM (clock_timestamp() - v_t0)) * 1000)::integer
    );

    SELECT change_revision INTO v_rev_after
    FROM public.catalog_public_snapshot_meta
    WHERE id IS TRUE;

    v_dirty_after := (v_rev_after IS DISTINCT FROM v_rev);

    UPDATE public.catalog_public_snapshot_meta
    SET
      last_success_at = clock_timestamp(),
      last_duration_ms = v_ms,
      last_error = NULL,
      dirty = v_dirty_after,
      dirty_since = CASE WHEN v_dirty_after THEN COALESCE(dirty_since, clock_timestamp()) ELSE NULL END
    WHERE id IS TRUE;

    PERFORM pg_advisory_unlock(c_lock);

    RETURN json_build_object(
      'success', true,
      'row_count', v_rows,
      'refreshed_at', clock_timestamp(),
      'duration_ms', v_ms,
      'dirty', v_dirty_after,
      'revision', v_rev_after
    );
  EXCEPTION
    WHEN OTHERS THEN
      UPDATE public.catalog_public_snapshot_meta
      SET last_error = left(SQLERRM, 1000)
      WHERE id IS TRUE;
      PERFORM pg_advisory_unlock(c_lock);
      RAISE;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_refresh_catalog_public_snapshot() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_refresh_catalog_public_snapshot() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6) Versión pública (anon): revision + timestamps. Sin dirty/error.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_catalog_public_version()
RETURNS json
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT json_build_object(
    'refreshed_at', m.refreshed_at,
    'row_count', m.row_count,
    'revision', m.change_revision
  )
  FROM public.catalog_public_snapshot_meta m
  WHERE m.id IS TRUE
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.rpc_catalog_public_version() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_catalog_public_version() TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7) Observabilidad admin
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_catalog_snapshot_observability()
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_meta public.catalog_public_snapshot_meta%ROWTYPE;
  v_view_rows integer;
  v_snap_rows integer;
  v_snap_only integer;
  v_view_only integer;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Solo administradores pueden ver el estado del snapshot';
  END IF;

  SELECT * INTO v_meta
  FROM public.catalog_public_snapshot_meta
  WHERE id IS TRUE;

  SELECT count(*) INTO v_view_rows FROM public.catalog_public_available_view;
  SELECT count(*) INTO v_snap_rows FROM public.catalog_public_snapshot;

  SELECT count(*) INTO v_snap_only
  FROM public.catalog_public_snapshot s
  WHERE NOT EXISTS (
    SELECT 1 FROM public.catalog_public_available_view v
    WHERE v.variant_id = s.variant_id
  );

  SELECT count(*) INTO v_view_only
  FROM public.catalog_public_available_view v
  WHERE NOT EXISTS (
    SELECT 1 FROM public.catalog_public_snapshot s
    WHERE s.variant_id = v.variant_id
  );

  RETURN json_build_object(
    'dirty', v_meta.dirty,
    'dirty_since', v_meta.dirty_since,
    'change_revision', v_meta.change_revision,
    'last_success_at', v_meta.last_success_at,
    'last_attempt_at', v_meta.last_attempt_at,
    'last_refresh_at', v_meta.last_refresh_at,
    'last_error', v_meta.last_error,
    'last_duration_ms', v_meta.last_duration_ms,
    'snapshot_row_count', v_snap_rows,
    'view_row_count', v_view_rows,
    'drift_snap_only', v_snap_only,
    'drift_view_only', v_view_only,
    'meta_row_count', v_meta.row_count,
    'refreshed_at', v_meta.refreshed_at
  );
END;
$$;

COMMENT ON FUNCTION public.rpc_catalog_snapshot_observability() IS
  'Estado admin del snapshot: dirty, revision, drift vista vs copia, último error/duración.';

REVOKE ALL ON FUNCTION public.rpc_catalog_snapshot_observability() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_catalog_snapshot_observability() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8) Triggers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_trg_catalog_snapshot_dirty()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  PERFORM public.fn_mark_catalog_snapshot_dirty();
  RETURN NULL;
END;
$$;

DROP FUNCTION IF EXISTS public.fn_trg_catalog_snapshot_dirty_vss();

DROP TRIGGER IF EXISTS trg_catalog_snap_dirty_vss ON public.variant_size_warehouse_stock;
CREATE TRIGGER trg_catalog_snap_dirty_vss
AFTER INSERT OR UPDATE OR DELETE ON public.variant_size_warehouse_stock
FOR EACH STATEMENT
EXECUTE FUNCTION public.fn_trg_catalog_snapshot_dirty();

DROP TRIGGER IF EXISTS trg_catalog_snap_dirty_products ON public.products;
CREATE TRIGGER trg_catalog_snap_dirty_products
AFTER INSERT OR DELETE OR UPDATE OF
  status, name, description, category, last_published_at, supplier_id
ON public.products
FOR EACH STATEMENT
EXECUTE FUNCTION public.fn_trg_catalog_snapshot_dirty();

DROP TRIGGER IF EXISTS trg_catalog_snap_dirty_variants ON public.product_variants;
CREATE TRIGGER trg_catalog_snap_dirty_variants
AFTER INSERT OR DELETE OR UPDATE OF
  active, color, price, last_published_at, product_id
ON public.product_variants
FOR EACH STATEMENT
EXECUTE FUNCTION public.fn_trg_catalog_snapshot_dirty();

DROP TRIGGER IF EXISTS trg_catalog_snap_dirty_images ON public.variant_images;
CREATE TRIGGER trg_catalog_snap_dirty_images
AFTER INSERT OR UPDATE OR DELETE ON public.variant_images
FOR EACH STATEMENT
EXECUTE FUNCTION public.fn_trg_catalog_snapshot_dirty();

DROP TRIGGER IF EXISTS trg_catalog_snap_dirty_colors ON public.colors;
CREATE TRIGGER trg_catalog_snap_dirty_colors
AFTER INSERT OR DELETE OR UPDATE OF name, hex_color, display_number
ON public.colors
FOR EACH STATEMENT
EXECUTE FUNCTION public.fn_trg_catalog_snapshot_dirty();

DROP TRIGGER IF EXISTS trg_catalog_snap_dirty_suppliers ON public.suppliers;
CREATE TRIGGER trg_catalog_snap_dirty_suppliers
AFTER UPDATE OF code ON public.suppliers
FOR EACH STATEMENT
EXECUTE FUNCTION public.fn_trg_catalog_snapshot_dirty();

DROP TRIGGER IF EXISTS trg_catalog_snap_dirty_product_tags ON public.product_tags;
CREATE TRIGGER trg_catalog_snap_dirty_product_tags
AFTER INSERT OR UPDATE OR DELETE ON public.product_tags
FOR EACH STATEMENT
EXECUTE FUNCTION public.fn_trg_catalog_snapshot_dirty();

DROP TRIGGER IF EXISTS trg_catalog_snap_dirty_product_tag_details ON public.product_tag_details;
CREATE TRIGGER trg_catalog_snap_dirty_product_tag_details
AFTER INSERT OR UPDATE OR DELETE ON public.product_tag_details
FOR EACH STATEMENT
EXECUTE FUNCTION public.fn_trg_catalog_snapshot_dirty();

DROP TRIGGER IF EXISTS trg_catalog_snap_dirty_tags ON public.tags;
CREATE TRIGGER trg_catalog_snap_dirty_tags
AFTER UPDATE OF name ON public.tags
FOR EACH STATEMENT
EXECUTE FUNCTION public.fn_trg_catalog_snapshot_dirty();

DROP TRIGGER IF EXISTS trg_catalog_snap_dirty_offers ON public.color_price_offers;
CREATE TRIGGER trg_catalog_snap_dirty_offers
AFTER INSERT OR DELETE OR UPDATE OF
  status, start_date, end_date, offer_price, color, product_id,
  offer_campaign_id, offer_image_url, offer_title
ON public.color_price_offers
FOR EACH STATEMENT
EXECUTE FUNCTION public.fn_trg_catalog_snapshot_dirty();

DROP TRIGGER IF EXISTS trg_catalog_snap_dirty_promotions ON public.promotions;
CREATE TRIGGER trg_catalog_snap_dirty_promotions
AFTER INSERT OR DELETE OR UPDATE OF
  status, start_date, end_date, promo_type, fixed_amount
ON public.promotions
FOR EACH STATEMENT
EXECUTE FUNCTION public.fn_trg_catalog_snapshot_dirty();

DROP TRIGGER IF EXISTS trg_catalog_snap_dirty_promotion_items ON public.promotion_items;
CREATE TRIGGER trg_catalog_snap_dirty_promotion_items
AFTER INSERT OR UPDATE OR DELETE ON public.promotion_items
FOR EACH STATEMENT
EXECUTE FUNCTION public.fn_trg_catalog_snapshot_dirty();

DROP TRIGGER IF EXISTS trg_catalog_snap_dirty_warehouses ON public.warehouses;
CREATE TRIGGER trg_catalog_snap_dirty_warehouses
AFTER UPDATE OF code ON public.warehouses
FOR EACH STATEMENT
EXECUTE FUNCTION public.fn_trg_catalog_snapshot_dirty();

-- ---------------------------------------------------------------------------
-- 9) Cron cada 5 minutos (no rebuild si está limpio)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  PERFORM cron.unschedule('catalog-snapshot-refresh-if-dirty');
EXCEPTION
  WHEN OTHERS THEN
    NULL;
END $$;

SELECT cron.schedule(
  'catalog-snapshot-refresh-if-dirty',
  '*/5 * * * *',
  $$SELECT public.rpc_refresh_catalog_snapshot_if_dirty();$$
);

-- Primera convergencia: hay drift real (vista vs snapshot) y dirty=true.
SELECT public.rpc_refresh_catalog_snapshot_if_dirty();

SELECT pg_notify('pgrst', 'reload schema');
