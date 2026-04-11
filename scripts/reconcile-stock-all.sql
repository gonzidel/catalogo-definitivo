-- reconcile-stock-all.sql
-- Reconciliación masiva: recalcular variant_sizes y variant_warehouse_stock
-- desde variant_size_warehouse_stock (fuente de verdad).
-- Ejecutar UNA VEZ después de instalar triggers 84 + 145.

-- ============================================================================
-- 0) Preview: cuántas inconsistencias hay antes de reconciliar
-- ============================================================================
SELECT 'variant_sizes diffs' AS check_type, count(*) AS rows
FROM public.vw_stock_audit_variant_sizes_diff
UNION ALL
SELECT 'variant_warehouse diffs', count(*)
FROM public.vw_stock_audit_variant_warehouse_diff
UNION ALL
SELECT 'orphan size rows', count(*)
FROM public.vw_stock_audit_orphan_size_rows;

-- ============================================================================
-- 1) Reconciliar variant_sizes.stock_qty = SUM(variant_size_warehouse_stock)
-- ============================================================================
BEGIN;

UPDATE public.variant_sizes vs
SET
  stock_qty = sub.total_qty,
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

-- Crear filas faltantes en variant_sizes (orphans en variant_size_warehouse_stock)
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

-- Filas en variant_sizes sin correspondencia en variant_size_warehouse_stock → stock 0
UPDATE public.variant_sizes vs
SET
  stock_qty = 0,
  updated_at = now()
WHERE NOT EXISTS (
  SELECT 1
  FROM public.variant_size_warehouse_stock sw
  WHERE sw.variant_id = vs.variant_id
    AND TRIM(COALESCE(sw.size::text, '')) = TRIM(COALESCE(vs.size::text, ''))
)
AND vs.stock_qty <> 0;

COMMIT;

-- ============================================================================
-- 2) Reconciliar variant_warehouse_stock.stock_qty = SUM por depósito
-- ============================================================================
BEGIN;

UPDATE public.variant_warehouse_stock vws
SET
  stock_qty = sub.total_qty,
  updated_at = now()
FROM (
  SELECT
    variant_id,
    warehouse_id,
    COALESCE(SUM(stock_qty), 0)::int AS total_qty
  FROM public.variant_size_warehouse_stock
  GROUP BY variant_id, warehouse_id
) sub
WHERE vws.variant_id = sub.variant_id
  AND vws.warehouse_id = sub.warehouse_id
  AND vws.stock_qty IS DISTINCT FROM sub.total_qty;

-- Crear filas faltantes en variant_warehouse_stock
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
  WHERE vws.variant_id = sw.variant_id
    AND vws.warehouse_id = sw.warehouse_id
)
GROUP BY sw.variant_id, sw.warehouse_id
ON CONFLICT (variant_id, warehouse_id)
DO UPDATE SET stock_qty = EXCLUDED.stock_qty, updated_at = now();

-- Filas en variant_warehouse_stock sin correspondencia → stock 0
UPDATE public.variant_warehouse_stock vws
SET
  stock_qty = 0,
  updated_at = now()
WHERE NOT EXISTS (
  SELECT 1
  FROM public.variant_size_warehouse_stock sw
  WHERE sw.variant_id = vws.variant_id
    AND sw.warehouse_id = vws.warehouse_id
)
AND vws.stock_qty <> 0;

COMMIT;

-- ============================================================================
-- 3) Verificación post-reconciliación
-- ============================================================================
SELECT 'variant_sizes diffs' AS check_type, count(*) AS rows
FROM public.vw_stock_audit_variant_sizes_diff
UNION ALL
SELECT 'variant_warehouse diffs', count(*)
FROM public.vw_stock_audit_variant_warehouse_diff
UNION ALL
SELECT 'orphan size rows', count(*)
FROM public.vw_stock_audit_orphan_size_rows;
