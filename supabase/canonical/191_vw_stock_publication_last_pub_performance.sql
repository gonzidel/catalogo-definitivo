-- 191_vw_stock_publication_last_pub_performance.sql
-- FASE 1: rendimiento de ventas en ventanas 0–24h, 24–72h y 0–7d posteriores a la
-- ÚNICA fecha conocida: MAX(last_published_at) por producto en variantes activas.
--
-- LIMITACIÓN ESTRUCTURAL (obligatoria en análisis e IA):
--   · No existe tabla de eventos de publicación. Cada nueva publicación SOBRESCRIBE
--     last_published_at. No se puede medir frecuencia, republicación ni campañas.
--   · Las columnas u_* miden ventas atribuidas a “lo ocurrido tras la última
--     publicación registrada”, no tras publicaciones anteriores.
--
-- Fuentes de venta: order_items+orders (B2B) y public_sale_items (venta pública).
-- Ventana de productos: publicados en los últimos 180 días, producto activo, con stock.

CREATE OR REPLACE VIEW public.vw_stock_publication_last_pub_performance AS
WITH
  last_pub AS (
    SELECT
      product_id,
      MAX(last_published_at) AS last_published_at,
      COUNT(*) FILTER (WHERE last_published_at IS NOT NULL) AS variants_published
    FROM public.product_variants
    WHERE
      last_published_at IS NOT NULL
      AND active = true
    GROUP BY product_id
  ),

  sales_unified AS (
    SELECT
      lp.product_id,
      lp.last_published_at,
      oi.quantity::numeric AS qty,
      o.created_at AS sale_at
    FROM last_pub lp
    JOIN public.product_variants pv ON pv.product_id = lp.product_id AND pv.active = true
    JOIN public.order_items oi ON oi.variant_id = pv.id
    JOIN public.orders o ON o.id = oi.order_id
    WHERE
      oi.status != 'cancelled'
      AND oi.variant_id IS NOT NULL
      AND o.created_at >= lp.last_published_at
    UNION ALL
    SELECT
      lp.product_id,
      lp.last_published_at,
      psi.qty::numeric,
      psi.created_at AS sale_at
    FROM last_pub lp
    JOIN public.product_variants pv ON pv.product_id = lp.product_id AND pv.active = true
    JOIN public.public_sale_items psi ON psi.variant_id = pv.id
    WHERE
      psi.is_return = false
      AND psi.created_at >= lp.last_published_at
  ),

  agg AS (
    SELECT
      product_id,
      last_published_at,
      COALESCE(SUM(qty) FILTER (
        WHERE sale_at >= last_published_at
          AND sale_at < last_published_at + INTERVAL '1 day'
      ), 0) AS u_0_24h,
      COALESCE(SUM(qty) FILTER (
        WHERE sale_at >= last_published_at + INTERVAL '1 day'
          AND sale_at < last_published_at + INTERVAL '3 days'
      ), 0) AS u_24_72h,
      COALESCE(SUM(qty) FILTER (
        WHERE sale_at >= last_published_at
          AND sale_at < last_published_at + INTERVAL '7 days'
      ), 0) AS u_0_7d,
      COALESCE(SUM(qty), 0) AS ventas_totales_post_ultima_pub
    FROM sales_unified
    GROUP BY product_id, last_published_at
  ),

  stock_actual AS (
    SELECT
      pv.product_id,
      SUM(COALESCE(vws.stock_qty, 0)) AS stock_total
    FROM public.product_variants pv
    JOIN public.variant_warehouse_stock vws ON vws.variant_id = pv.id
    WHERE pv.active = true
    GROUP BY pv.product_id
  )

SELECT
  p.id AS product_id,
  p.name AS nombre,
  p.category,
  lp.last_published_at,
  lp.variants_published,
  FLOOR(EXTRACT(EPOCH FROM (NOW() - lp.last_published_at)) / 86400)::int AS dias_desde_publicacion,
  COALESCE(a.u_0_24h, 0)::numeric AS u_0_24h,
  COALESCE(a.u_24_72h, 0)::numeric AS u_24_72h,
  COALESCE(a.u_0_7d, 0)::numeric AS u_0_7d,
  COALESCE(a.ventas_totales_post_ultima_pub, 0)::numeric AS ventas_totales_post_ultima_pub,
  sa.stock_total
FROM public.products p
JOIN last_pub lp ON lp.product_id = p.id
LEFT JOIN agg a ON a.product_id = p.id AND a.last_published_at = lp.last_published_at
JOIN stock_actual sa ON sa.product_id = p.id
WHERE
  p.status = 'active'
  AND sa.stock_total > 0
  AND lp.last_published_at >= NOW() - INTERVAL '180 days';

GRANT SELECT ON public.vw_stock_publication_last_pub_performance TO authenticated;

COMMENT ON VIEW public.vw_stock_publication_last_pub_performance IS
  'FASE 1 — Ventas B2B + público en 0–24h, 24–72h y 0–7d tras la ÚLTIMA '
  'last_published_at conocida por producto. Sin historial de publicaciones múltiples: '
  'no inferir frecuencia, republicaciones ni campañas. FASE 3 reemplazaría fuente por publication_events.';

-- Aclara la misma limitación en la vista de ineficiencia (solo última publicación).
COMMENT ON VIEW public.vw_stock_publication_inefficiency IS
  'Análisis operativo: productos con stock (últimos 180d de last_published_at) sin ventas '
  'B2B ni público desde esa fecha. LIMITACIÓN: no hay historial de publicaciones; '
  'solo existe last_published_at (se sobrescribe). Las métricas se refieren a la última '
  'publicación registrada, no a intentos anteriores.';
