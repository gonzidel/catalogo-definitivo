-- 187_vw_stock_tag_summary.sql
-- Vista de agregados por tag para el sistema de inteligencia operativa (stock_report_ai).
-- Agrupa ventas y stock por tag1 + tag2 para responder preguntas como:
--   ¿Se venden más botas o zapatillas? / ¿Qué tipo rota mejor?
--
-- Fuentes de venta: order_items (B2B) + public_sale_items (venta al público)
-- Ventanas: últimos 30 días y últimos 90 días.
-- Solo productos activos con tag1 asignado.

CREATE OR REPLACE VIEW public.vw_stock_tag_summary AS
WITH

  -- Nombres de tag1 / tag2 por producto (solo activos con tag1 asignado)
  tag_names AS (
    SELECT
      pt.product_id,
      t1.name        AS tag1_nombre,
      t1.category,
      t2.name        AS tag2_nombre
    FROM public.product_tags pt
    LEFT JOIN public.tags t1 ON t1.id = pt.tag1_id
    LEFT JOIN public.tags t2 ON t2.id = pt.tag2_id
    WHERE pt.tag1_id IS NOT NULL
  ),

  -- Ventas B2B últimos 30 días
  b2b_30 AS (
    SELECT pv.product_id, SUM(oi.quantity) AS u30
    FROM public.order_items     oi
    JOIN public.orders           o  ON o.id  = oi.order_id
    JOIN public.product_variants pv ON pv.id = oi.variant_id
    WHERE oi.status != 'cancelled'
      AND o.created_at >= NOW() - INTERVAL '30 days'
      AND oi.variant_id IS NOT NULL
    GROUP BY pv.product_id
  ),

  -- Ventas B2B últimos 90 días
  b2b_90 AS (
    SELECT pv.product_id, SUM(oi.quantity) AS u90
    FROM public.order_items     oi
    JOIN public.orders           o  ON o.id  = oi.order_id
    JOIN public.product_variants pv ON pv.id = oi.variant_id
    WHERE oi.status != 'cancelled'
      AND o.created_at >= NOW() - INTERVAL '90 days'
      AND oi.variant_id IS NOT NULL
    GROUP BY pv.product_id
  ),

  -- Ventas al público últimos 30 días
  vp_30 AS (
    SELECT pv.product_id, SUM(psi.qty) AS u30
    FROM public.public_sale_items psi
    JOIN public.product_variants  pv ON pv.id = psi.variant_id
    WHERE psi.is_return = false
      AND psi.created_at >= NOW() - INTERVAL '30 days'
    GROUP BY pv.product_id
  ),

  -- Ventas al público últimos 90 días
  vp_90 AS (
    SELECT pv.product_id, SUM(psi.qty) AS u90
    FROM public.public_sale_items psi
    JOIN public.product_variants  pv ON pv.id = psi.variant_id
    WHERE psi.is_return = false
      AND psi.created_at >= NOW() - INTERVAL '90 days'
    GROUP BY pv.product_id
  ),

  -- Stock actual (variantes activas, todos los depósitos)
  stk AS (
    SELECT pv.product_id, SUM(COALESCE(vws.stock_qty, 0)) AS stock_total
    FROM public.product_variants        pv
    JOIN public.variant_warehouse_stock vws ON vws.variant_id = pv.id
    WHERE pv.active = true
    GROUP BY pv.product_id
  )

SELECT
  tn.tag1_nombre,
  tn.category,
  tn.tag2_nombre,
  COUNT(DISTINCT p.id)                                                        AS productos_activos,
  SUM(COALESCE(b30.u30, 0) + COALESCE(v30.u30, 0))                          AS unidades_30d,
  SUM(COALESCE(b90.u90, 0) + COALESCE(v90.u90, 0))                          AS unidades_90d,
  SUM(COALESCE(s.stock_total, 0))                                             AS stock_total,
  -- Velocidad: unidades por día (90d)
  ROUND(
    SUM(COALESCE(b90.u90, 0) + COALESCE(v90.u90, 0))::numeric / 90, 2
  )                                                                            AS unidades_por_dia

FROM public.products p
JOIN tag_names       tn  ON tn.product_id  = p.id
LEFT JOIN b2b_30     b30 ON b30.product_id = p.id
LEFT JOIN b2b_90     b90 ON b90.product_id = p.id
LEFT JOIN vp_30      v30 ON v30.product_id = p.id
LEFT JOIN vp_90      v90 ON v90.product_id = p.id
LEFT JOIN stk        s   ON s.product_id   = p.id
WHERE p.status = 'active'
GROUP BY tn.tag1_nombre, tn.category, tn.tag2_nombre
ORDER BY unidades_90d DESC NULLS LAST;

GRANT SELECT ON public.vw_stock_tag_summary TO authenticated;

COMMENT ON VIEW public.vw_stock_tag_summary IS
  'Agregados de ventas y stock agrupados por tag1+tag2 para inteligencia operativa. '
  'Alimenta el sistema stock_report_ai para responder preguntas como '
  '"¿qué tipo de calzado rota mejor?" con datos reales.';
