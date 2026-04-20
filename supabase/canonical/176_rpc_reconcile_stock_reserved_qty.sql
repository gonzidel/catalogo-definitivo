-- 176_rpc_reconcile_stock_reserved_qty.sql
-- Sprint 4 / Bloque Final — Extender rpc_reconcile_stock para reserved_qty.
--
-- Cambios respecto a 146:
--   · Nuevo parámetro opcional: p_fix_reserved_qty boolean default false.
--     - false (default) → modo diagnóstico: detecta drift sin escribir nada.
--     - true            → modo corrección: actualiza product_variants.reserved_qty.
--   · Snapshot before/after incluye reserved_qty_diffs.
--   · JSON de salida incluye sección 'reserved_qty' con stats detallados.
--
-- Compatibilidad hacia atrás:
--   Llamar rpc_reconcile_stock() sin parámetros funciona exactamente igual que
--   antes (p_fix_reserved_qty toma su valor default false → solo reconcilia
--   derivadas, no toca reserved_qty).
--
-- Seguridad:
--   · SECURITY DEFINER sin cambios.
--   · Solo admin o service_role pueden ejecutar.
--   · reserved_qty nunca queda negativo (GREATEST(0, ...)).
--   · Solo escribe si hay diferencia real (IS DISTINCT FROM).
--   · No toca otras tablas, triggers ni RPCs.

-- Eliminar la firma anterior (sin parámetros) antes de redefinir con parámetro.
-- Es necesario porque PostgreSQL trata firmas distintas como funciones distintas.
DROP FUNCTION IF EXISTS public.rpc_reconcile_stock();

CREATE OR REPLACE FUNCTION public.rpc_reconcile_stock(
  p_fix_reserved_qty boolean DEFAULT false
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  -- Auth
  v_uid      uuid;
  v_is_admin boolean := false;

  -- Snapshots — tablas derivadas (comportamiento original)
  v_before_vs_diff      int := 0;
  v_before_vws_diff     int := 0;
  v_before_orphans      int := 0;
  v_after_vs_diff       int := 0;
  v_after_vws_diff      int := 0;
  v_after_orphans       int := 0;

  -- Filas cambiadas — tablas derivadas (comportamiento original)
  v_updated_variant_sizes      int := 0;
  v_inserted_variant_sizes     int := 0;
  v_zeroed_variant_sizes       int := 0;
  v_updated_variant_warehouse  int := 0;
  v_inserted_variant_warehouse int := 0;
  v_zeroed_variant_warehouse   int := 0;

  -- reserved_qty (nuevo)
  v_before_reserved_diffs int  := 0;
  v_after_reserved_diffs  int  := 0;
  v_reserved_fixed        int  := 0;
  v_affected_ids          uuid[] := '{}'::uuid[];
  v_diff_rec              record;
BEGIN
  -- ═══════════════════════════════════════════════════════════════════════
  -- AUTH — igual que el original
  -- ═══════════════════════════════════════════════════════════════════════
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    -- Permitir service_role para tareas operativas automatizadas.
    v_is_admin := COALESCE(current_setting('request.jwt.claim.role', true), '') = 'service_role';
    IF NOT v_is_admin THEN
      RAISE EXCEPTION 'No autenticado';
    END IF;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM public.admins a WHERE a.user_id = v_uid
    ) INTO v_is_admin;
  END IF;

  IF NOT v_is_admin THEN
    RAISE EXCEPTION 'Solo administradores pueden reconciliar stock';
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- SNAPSHOT BEFORE
  -- ═══════════════════════════════════════════════════════════════════════
  SELECT count(*)::int INTO v_before_vs_diff
    FROM public.vw_stock_audit_variant_sizes_diff;

  SELECT count(*)::int INTO v_before_vws_diff
    FROM public.vw_stock_audit_variant_warehouse_diff;

  SELECT count(*)::int INTO v_before_orphans
    FROM public.vw_stock_audit_orphan_size_rows;

  SELECT count(*)::int INTO v_before_reserved_diffs
    FROM public.vw_stock_audit_reserved_qty_diff;

  -- ═══════════════════════════════════════════════════════════════════════
  -- BLOQUE 1 — reconciliar variant_sizes desde variant_size_warehouse_stock
  -- (comportamiento original sin cambios)
  -- ═══════════════════════════════════════════════════════════════════════
  UPDATE public.variant_sizes vs
  SET
    stock_qty  = sub.total_qty,
    updated_at = now()
  FROM (
    SELECT
      variant_id,
      TRIM(COALESCE(size::text, '')) AS size_norm,
      COALESCE(SUM(stock_qty), 0)::int AS total_qty
    FROM public.variant_size_warehouse_stock
    GROUP BY variant_id, TRIM(COALESCE(size::text, ''))
  ) sub
  WHERE vs.variant_id = sub.variant_id
    AND TRIM(COALESCE(vs.size::text, '')) = sub.size_norm
    AND vs.stock_qty IS DISTINCT FROM sub.total_qty;
  GET DIAGNOSTICS v_updated_variant_sizes = ROW_COUNT;

  INSERT INTO public.variant_sizes (variant_id, size, stock_qty, updated_at)
  SELECT
    sw.variant_id,
    TRIM(COALESCE(sw.size::text, '')),
    COALESCE(SUM(sw.stock_qty), 0)::int,
    now()
  FROM public.variant_size_warehouse_stock sw
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.variant_sizes vs
    WHERE vs.variant_id = sw.variant_id
      AND TRIM(COALESCE(vs.size::text, '')) = TRIM(COALESCE(sw.size::text, ''))
  )
  GROUP BY sw.variant_id, TRIM(COALESCE(sw.size::text, ''))
  ON CONFLICT (variant_id, size)
  DO UPDATE SET stock_qty = EXCLUDED.stock_qty, updated_at = now();
  GET DIAGNOSTICS v_inserted_variant_sizes = ROW_COUNT;

  UPDATE public.variant_sizes vs
  SET
    stock_qty  = 0,
    updated_at = now()
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.variant_size_warehouse_stock sw
    WHERE sw.variant_id = vs.variant_id
      AND TRIM(COALESCE(sw.size::text, '')) = TRIM(COALESCE(vs.size::text, ''))
  )
  AND vs.stock_qty <> 0;
  GET DIAGNOSTICS v_zeroed_variant_sizes = ROW_COUNT;

  -- ═══════════════════════════════════════════════════════════════════════
  -- BLOQUE 2 — reconciliar variant_warehouse_stock desde variant_size_warehouse_stock
  -- (comportamiento original sin cambios)
  -- ═══════════════════════════════════════════════════════════════════════
  UPDATE public.variant_warehouse_stock vws
  SET
    stock_qty  = sub.total_qty,
    updated_at = now()
  FROM (
    SELECT
      variant_id,
      warehouse_id,
      COALESCE(SUM(stock_qty), 0)::int AS total_qty
    FROM public.variant_size_warehouse_stock
    GROUP BY variant_id, warehouse_id
  ) sub
  WHERE vws.variant_id  = sub.variant_id
    AND vws.warehouse_id = sub.warehouse_id
    AND vws.stock_qty IS DISTINCT FROM sub.total_qty;
  GET DIAGNOSTICS v_updated_variant_warehouse = ROW_COUNT;

  INSERT INTO public.variant_warehouse_stock (variant_id, warehouse_id, stock_qty, updated_at)
  SELECT
    sw.variant_id,
    sw.warehouse_id,
    COALESCE(SUM(sw.stock_qty), 0)::int,
    now()
  FROM public.variant_size_warehouse_stock sw
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.variant_warehouse_stock vws
    WHERE vws.variant_id  = sw.variant_id
      AND vws.warehouse_id = sw.warehouse_id
  )
  GROUP BY sw.variant_id, sw.warehouse_id
  ON CONFLICT (variant_id, warehouse_id)
  DO UPDATE SET stock_qty = EXCLUDED.stock_qty, updated_at = now();
  GET DIAGNOSTICS v_inserted_variant_warehouse = ROW_COUNT;

  UPDATE public.variant_warehouse_stock vws
  SET
    stock_qty  = 0,
    updated_at = now()
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.variant_size_warehouse_stock sw
    WHERE sw.variant_id  = vws.variant_id
      AND sw.warehouse_id = vws.warehouse_id
  )
  AND vws.stock_qty <> 0;
  GET DIAGNOSTICS v_zeroed_variant_warehouse = ROW_COUNT;

  -- ═══════════════════════════════════════════════════════════════════════
  -- BLOQUE 3 — reserved_qty (nuevo)
  --
  -- Fuente de verdad: vw_stock_audit_reserved_qty_diff (creada en 175).
  -- correct_qty = GREATEST(0, real_reserved_qty)
  --   · real_reserved_qty ya viene calculado desde la vista como la suma real
  --     de order_item_stock_sources (pedidos activos) + cart_items (open).
  --   · GREATEST(0, ...) garantiza que reserved_qty nunca queda negativo.
  --   · Solo actualiza si hay diferencia real (IS DISTINCT FROM).
  --   · Solo ejecuta si p_fix_reserved_qty = true.
  -- ═══════════════════════════════════════════════════════════════════════
  IF p_fix_reserved_qty THEN
    FOR v_diff_rec IN
      SELECT
        variant_id,
        GREATEST(0, real_reserved_qty::int) AS correct_qty
      FROM public.vw_stock_audit_reserved_qty_diff
      ORDER BY variant_id   -- orden determinístico para deadlock-safety
    LOOP
      UPDATE public.product_variants
      SET reserved_qty = v_diff_rec.correct_qty
      WHERE id = v_diff_rec.variant_id
        AND COALESCE(reserved_qty, 0)::int
              IS DISTINCT FROM v_diff_rec.correct_qty;

      IF FOUND THEN
        v_reserved_fixed := v_reserved_fixed + 1;
        -- Acumular hasta 50 IDs en el resultado (evitar respuesta excesivamente grande).
        IF array_length(v_affected_ids, 1) IS NULL
           OR array_length(v_affected_ids, 1) < 50
        THEN
          v_affected_ids := v_affected_ids || v_diff_rec.variant_id;
        END IF;
      END IF;
    END LOOP;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- SNAPSHOT AFTER
  -- ═══════════════════════════════════════════════════════════════════════
  SELECT count(*)::int INTO v_after_vs_diff
    FROM public.vw_stock_audit_variant_sizes_diff;

  SELECT count(*)::int INTO v_after_vws_diff
    FROM public.vw_stock_audit_variant_warehouse_diff;

  SELECT count(*)::int INTO v_after_orphans
    FROM public.vw_stock_audit_orphan_size_rows;

  SELECT count(*)::int INTO v_after_reserved_diffs
    FROM public.vw_stock_audit_reserved_qty_diff;

  -- ═══════════════════════════════════════════════════════════════════════
  -- RESULTADO
  -- ═══════════════════════════════════════════════════════════════════════
  RETURN json_build_object(
    'ok', true,
    'fix_reserved_qty_requested', p_fix_reserved_qty,
    'before', json_build_object(
      'variant_sizes_diffs',     v_before_vs_diff,
      'variant_warehouse_diffs', v_before_vws_diff,
      'orphan_rows',             v_before_orphans,
      'reserved_qty_diffs',      v_before_reserved_diffs
    ),
    'after', json_build_object(
      'variant_sizes_diffs',     v_after_vs_diff,
      'variant_warehouse_diffs', v_after_vws_diff,
      'orphan_rows',             v_after_orphans,
      'reserved_qty_diffs',      v_after_reserved_diffs
    ),
    'rows_changed', json_build_object(
      'variant_sizes_updated',      v_updated_variant_sizes,
      'variant_sizes_inserted',     v_inserted_variant_sizes,
      'variant_sizes_zeroed',       v_zeroed_variant_sizes,
      'variant_warehouse_updated',  v_updated_variant_warehouse,
      'variant_warehouse_inserted', v_inserted_variant_warehouse,
      'variant_warehouse_zeroed',   v_zeroed_variant_warehouse
    ),
    'reserved_qty', json_build_object(
      'checked',             v_before_reserved_diffs,
      'fixed',               v_reserved_fixed,
      'remaining_diffs',     v_after_reserved_diffs,
      'affected_variant_ids', v_affected_ids
    )
  );
END;
$$;

COMMENT ON FUNCTION public.rpc_reconcile_stock(boolean) IS
  'Stock Audit V3: reconciliación masiva de tablas derivadas + corrección opcional de reserved_qty. '
  'p_fix_reserved_qty=false (default): solo reporta drift sin escribir. '
  'p_fix_reserved_qty=true: corrige product_variants.reserved_qty desde vw_stock_audit_reserved_qty_diff.';

GRANT EXECUTE ON FUNCTION public.rpc_reconcile_stock(boolean) TO authenticated, service_role;

SELECT pg_notify('pgrst', 'reload schema');
