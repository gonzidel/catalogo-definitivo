-- 186_vw_stock_publication_inefficiency.sql
-- Vista de análisis operativo: productos publicados en redes (last_published_at IS NOT NULL)
-- que tienen stock disponible pero cero ventas desde la fecha de publicación.
--
-- "Publicación ineficiente" = el esfuerzo de publicar no generó conversión en ventas.
-- Esto puede indicar: precio fuera de rango, imágenes poco efectivas, producto equivocado.
--
-- Fuente de publicación:
--   · product_variants.last_published_at  (escrito por admin/publications.js)
--
-- Fuentes de venta post-publicación:
--   · order_items + orders        (B2B)
--   · public_sale_items           (venta al público)
--
-- Solo incluye publicaciones de los últimos 180 días para mantener relevancia.

CREATE OR REPLACE VIEW public.vw_stock_publication_inefficiency AS
WITH

  -- Última publicación por producto (máximo last_published_at entre variantes activas)
  last_pub AS (
    SELECT
      product_id,
      MAX(last_published_at)                                       AS last_published_at,
      COUNT(*) FILTER (WHERE last_published_at IS NOT NULL)        AS variants_published
    FROM public.product_variants
    WHERE
      last_published_at IS NOT NULL
      AND active = true
    GROUP BY product_id
  ),

  -- Ventas B2B desde la última publicación de cada producto
  b2b_after AS (
    SELECT
      pv.product_id,
      SUM(oi.quantity) AS units_sold
    FROM public.order_items     oi
    JOIN public.orders           o   ON o.id  = oi.order_id
    JOIN public.product_variants pv  ON pv.id = oi.variant_id
    JOIN last_pub                lp  ON lp.product_id = pv.product_id
    WHERE
      oi.status        != 'cancelled'
      AND o.created_at  >= lp.last_published_at
      AND oi.variant_id  IS NOT NULL
    GROUP BY pv.product_id
  ),

  -- Ventas al público desde la última publicación de cada producto
  vp_after AS (
    SELECT
      pv.product_id,
      SUM(psi.qty) AS units_sold
    FROM public.public_sale_items psi
    JOIN public.product_variants  pv  ON pv.id = psi.variant_id
    JOIN last_pub                 lp  ON lp.product_id = pv.product_id
    WHERE
      psi.is_return   = false
      AND psi.created_at >= lp.last_published_at
    GROUP BY pv.product_id
  ),

  -- Total ventas post-publicación (ambos canales)
  sales_after AS (
    SELECT product_id, SUM(units_sold) AS total_sold_after_pub
    FROM (
      SELECT product_id, units_sold FROM b2b_after
      UNION ALL
      SELECT product_id, units_sold FROM vp_after
    ) combined
    GROUP BY product_id
  ),

  -- Stock real actual
  stock_actual AS (
    SELECT
      pv.product_id,
      SUM(COALESCE(vws.stock_qty, 0)) AS stock_total
    FROM public.product_variants        pv
    JOIN public.variant_warehouse_stock  vws ON vws.variant_id = pv.id
    WHERE pv.active = true
    GROUP BY pv.product_id
  )

SELECT
  p.id                                                                       AS product_id,
  p.name                                                                     AS nombre,
  p.category,
  lp.last_published_at,
  lp.variants_published,
  FLOOR(
    EXTRACT(EPOCH FROM (NOW() - lp.last_published_at)) / 86400
  )::int                                                                     AS dias_desde_publicacion,
  COALESCE(sa2.total_sold_after_pub, 0)                                     AS ventas_tras_publicacion,
  sa.stock_total

FROM public.products         p
JOIN last_pub                lp   ON lp.product_id = p.id
JOIN stock_actual            sa   ON sa.product_id  = p.id
LEFT JOIN sales_after        sa2  ON sa2.product_id = p.id
WHERE
  p.status = 'active'
  AND sa.stock_total > 0
  -- Publicado dentro de los últimos 180 días (ventana de análisis relevante)
  AND lp.last_published_at >= NOW() - INTERVAL '180 days'
  -- Cero ventas desde la publicación
  AND COALESCE(sa2.total_sold_after_pub, 0) = 0
ORDER BY dias_desde_publicacion DESC;

GRANT SELECT ON public.vw_stock_publication_inefficiency TO authenticated;

COMMENT ON VIEW public.vw_stock_publication_inefficiency IS
  'Análisis operativo: productos publicados en redes (últimos 180d) con stock disponible '
  'pero sin ninguna venta B2B ni al público desde la fecha de publicación. '
  'Señal de ineficiencia de conversión: precio, imagen o producto inadecuado para el canal.';
