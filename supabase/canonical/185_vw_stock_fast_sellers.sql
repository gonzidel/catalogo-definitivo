-- 185_vw_stock_fast_sellers.sql
-- Vista de análisis operativo: productos activos con ventas activas en los últimos 90 días.
-- Cubre tres señales de la UI:
--   · Alta demanda      → units_sold_90d alto, dias_stock_restante bajo
--   · Buena rotación    → es_nuevo = true (creado hace < 120 días)
--   · Stock acumulado   → dias_stock_restante > 180 (demasiado stock para la velocidad actual)
--
-- Fuentes de venta:
--   · order_items + orders        (B2B / revendedores)
--   · public_sale_items           (venta al público)
--
-- Umbral mínimo: 3 unidades vendidas en 90 días para filtrar ruido estadístico.

CREATE OR REPLACE VIEW public.vw_stock_fast_sellers AS
WITH

  -- Ventas B2B de los últimos 90 días (excluye ítems cancelados)
  b2b AS (
    SELECT
      pv.product_id,
      SUM(oi.quantity) AS units_sold
    FROM public.order_items    oi
    JOIN public.orders          o  ON o.id  = oi.order_id
    JOIN public.product_variants pv ON pv.id = oi.variant_id
    WHERE
      oi.status       != 'cancelled'
      AND o.created_at >= NOW() - INTERVAL '90 days'
      AND oi.variant_id IS NOT NULL
    GROUP BY pv.product_id
  ),

  -- Ventas al público de los últimos 90 días (excluye devoluciones)
  vp AS (
    SELECT
      pv.product_id,
      SUM(psi.qty) AS units_sold
    FROM public.public_sale_items psi
    JOIN public.product_variants  pv  ON pv.id = psi.variant_id
    WHERE
      psi.is_return   = false
      AND psi.created_at >= NOW() - INTERVAL '90 days'
    GROUP BY pv.product_id
  ),

  -- Total de unidades vendidas (ambos canales)
  total_sales AS (
    SELECT product_id, SUM(units_sold) AS units_sold_90d
    FROM (
      SELECT product_id, units_sold FROM b2b
      UNION ALL
      SELECT product_id, units_sold FROM vp
    ) combined
    GROUP BY product_id
  ),

  -- Stock real actual (solo variantes activas, todos los depósitos)
  stock_actual AS (
    SELECT
      pv.product_id,
      SUM(COALESCE(vws.stock_qty, 0)) AS stock_total
    FROM public.product_variants       pv
    JOIN public.variant_warehouse_stock vws ON vws.variant_id = pv.id
    WHERE pv.active = true
    GROUP BY pv.product_id
  )

SELECT
  p.id                                              AS product_id,
  p.name                                            AS nombre,
  p.category,
  p.created_at                                      AS alta_en,
  ts.units_sold_90d,
  sa.stock_total,

  -- Velocidad de venta en unidades por día
  ROUND(ts.units_sold_90d::numeric / 90, 2)         AS unidades_por_dia,

  -- Días de stock restante a la velocidad actual (NULL si units_sold = 0)
  CASE
    WHEN ts.units_sold_90d > 0
    THEN ROUND(sa.stock_total / (ts.units_sold_90d::numeric / 90))::int
    ELSE NULL
  END                                               AS dias_stock_restante,

  -- Señal: producto creado hace menos de 120 días
  (p.created_at >= NOW() - INTERVAL '120 days')     AS es_nuevo

FROM public.products          p
JOIN total_sales              ts ON ts.product_id = p.id
JOIN stock_actual             sa ON sa.product_id = p.id
WHERE
  p.status          = 'active'
  AND ts.units_sold_90d >= 3   -- umbral mínimo para reducir ruido estadístico
ORDER BY ts.units_sold_90d DESC;

GRANT SELECT ON public.vw_stock_fast_sellers TO authenticated;

COMMENT ON VIEW public.vw_stock_fast_sellers IS
  'Análisis operativo: productos activos con ventas en los últimos 90 días (B2B + venta pública). '
  'Señales: alta demanda, buena rotación en nuevos, stock acumulado relativo a velocidad.';
