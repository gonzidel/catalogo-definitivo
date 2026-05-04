-- 184_vw_stock_dead_products.sql
-- Vista de análisis operativo: productos activos con stock inmovilizado.
-- NO es una alerta de error técnico. Es una señal de oportunidad comercial.
--
-- Prioridad de fuente de última actividad:
--   1. stock_movements.created_at (movimiento físico de stock)
--   2. orders.created_at vía order_items (último pedido que incluyó el producto)
--   3. products.created_at (fallback conservador)
--
-- Solo incluye productos 'active' con stock real > 0 (variant_warehouse_stock)
-- y sin actividad >= 90 días.

CREATE OR REPLACE VIEW public.vw_stock_dead_products AS
WITH

  -- Stock total por producto (solo variantes activas con stock real)
  product_stock AS (
    SELECT
      pv.product_id,
      SUM(COALESCE(vws.stock_qty, 0)) AS stock_total
    FROM public.product_variants pv
    JOIN public.variant_warehouse_stock vws ON vws.variant_id = pv.id
    WHERE pv.active = true
    GROUP BY pv.product_id
    HAVING SUM(COALESCE(vws.stock_qty, 0)) > 0
  ),

  -- Último movimiento de stock registrado para alguna variante del producto
  last_movement AS (
    SELECT
      pv.product_id,
      MAX(sm.created_at) AS last_at
    FROM public.stock_movements sm
    JOIN public.product_variants pv ON pv.id = sm.variant_id
    GROUP BY pv.product_id
  ),

  -- Último pedido que incluyó alguna variante del producto
  last_order AS (
    SELECT
      pv.product_id,
      MAX(o.created_at) AS last_at
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    JOIN public.product_variants pv ON pv.id = oi.variant_id
    WHERE oi.variant_id IS NOT NULL
    GROUP BY pv.product_id
  )

SELECT
  p.id                                                            AS product_id,
  p.name                                                          AS nombre,
  p.category,
  ps.stock_total,
  COALESCE(lm.last_at, lo.last_at, p.created_at)                 AS ultima_actividad,
  FLOOR(
    EXTRACT(EPOCH FROM
      (NOW() - COALESCE(lm.last_at, lo.last_at, p.created_at))
    ) / 86400
  )::int                                                          AS dias_sin_movimiento,
  CASE
    WHEN lm.last_at IS NOT NULL THEN 'stock_movement'
    WHEN lo.last_at IS NOT NULL THEN 'order'
    ELSE                             'created_at'
  END                                                             AS fuente_actividad
FROM public.products p
JOIN product_stock ps ON ps.product_id = p.id
LEFT JOIN last_movement lm ON lm.product_id = p.id
LEFT JOIN last_order    lo ON lo.product_id = p.id
WHERE
  p.status = 'active'
  AND FLOOR(
    EXTRACT(EPOCH FROM
      (NOW() - COALESCE(lm.last_at, lo.last_at, p.created_at))
    ) / 86400
  ) >= 90
ORDER BY dias_sin_movimiento DESC;

-- Permisos de lectura para el rol admin (ajustar según roles del proyecto)
GRANT SELECT ON public.vw_stock_dead_products TO authenticated;

COMMENT ON VIEW public.vw_stock_dead_products IS
  'Análisis operativo: productos activos con stock real y sin actividad >= 90 días. '
  'Fuente priorizada: stock_movements → orders → created_at.';
