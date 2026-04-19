-- FYL — Chequeos de coherencia de stock (SOLO LECTURA)
-- No modifica datos. Ejecutar en Supabase SQL Editor o psql con rol de lectura.
-- Objetivo: detectar filtraciones entre variant_sizes, variant_size_warehouse_stock y variant_warehouse_stock.

-- ---------------------------------------------------------------------------
-- 1) variant_sizes vs suma de variant_size_warehouse_stock por (variant_id, size)
--    Si hay filas aquí, el trigger debería mantener variant_sizes alineado cuando
--    el origen de verdad es variant_size_warehouse_stock; escrituras directas a
--    variant_sizes (p. ej. admin/products) pueden generar diferencias hasta que
--    se normalice en otra pantalla.
-- ---------------------------------------------------------------------------
SELECT
  vs.variant_id,
  vs.size,
  vs.stock_qty AS variant_sizes_qty,
  COALESCE(sws.sum_qty, 0) AS sum_size_warehouse_qty,
  vs.stock_qty - COALESCE(sws.sum_qty, 0) AS delta
FROM public.variant_sizes vs
LEFT JOIN (
  SELECT
    variant_id,
    TRIM(COALESCE(size::text, '')) AS size_norm,
    SUM(stock_qty)::int AS sum_qty
  FROM public.variant_size_warehouse_stock
  GROUP BY variant_id, TRIM(COALESCE(size::text, ''))
) sws ON sws.variant_id = vs.variant_id AND sws.size_norm = TRIM(COALESCE(vs.size::text, ''))
WHERE vs.stock_qty IS DISTINCT FROM COALESCE(sws.sum_qty, 0)
ORDER BY delta DESC;

-- ---------------------------------------------------------------------------
-- 2) variant_warehouse_stock vs suma de variant_size_warehouse_stock por depósito
-- ---------------------------------------------------------------------------
WITH by_wh AS (
  SELECT variant_id, warehouse_id, SUM(stock_qty)::int AS sum_qty
  FROM public.variant_size_warehouse_stock
  GROUP BY variant_id, warehouse_id
)
SELECT
  vws.variant_id,
  w.code AS warehouse_code,
  vws.stock_qty AS aggregated_row_qty,
  COALESCE(b.sum_qty, 0) AS sum_from_size_rows,
  vws.stock_qty - COALESCE(b.sum_qty, 0) AS delta
FROM public.variant_warehouse_stock vws
JOIN public.warehouses w ON w.id = vws.warehouse_id
LEFT JOIN by_wh b ON b.variant_id = vws.variant_id AND b.warehouse_id = vws.warehouse_id
WHERE vws.stock_qty IS DISTINCT FROM COALESCE(b.sum_qty, 0)
ORDER BY ABS(vws.stock_qty - COALESCE(b.sum_qty, 0)) DESC;

-- ---------------------------------------------------------------------------
-- 3) Opcional: filas en variant_size_warehouse_stock sin fila en variant_sizes
--    (mismo variant_id + size)
-- ---------------------------------------------------------------------------
SELECT sws.variant_id, sws.size, sws.warehouse_id, sws.stock_qty
FROM public.variant_size_warehouse_stock sws
WHERE NOT EXISTS (
  SELECT 1 FROM public.variant_sizes vs
  WHERE vs.variant_id = sws.variant_id
    AND TRIM(COALESCE(vs.size::text, '')) = TRIM(COALESCE(sws.size::text, ''))
);

-- ---------------------------------------------------------------------------
-- 4) Opcional: order_items con price_snapshot < 1000 (auditoría legacy / UI)
--    Enteros en este rango pueden ser pesos reales o datos viejos en "miles";
--    revisar manualmente antes de cualquier migración masiva.
-- ---------------------------------------------------------------------------
SELECT
  oi.id,
  oi.order_id,
  oi.product_name,
  oi.quantity,
  oi.price_snapshot,
  o.created_at
FROM public.order_items oi
JOIN public.orders o ON o.id = oi.order_id
WHERE oi.price_snapshot IS NOT NULL
  AND oi.price_snapshot > 0
  AND oi.price_snapshot < 1000
ORDER BY o.created_at DESC
LIMIT 200;
