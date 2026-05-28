-- 226_meta_feed_phase1_category_filtro1.sql
-- Fase 1 Meta feed: expone category + filtro1 (fuente product_type/gender en Edge).
-- NO modifica CTEs de stock, joins de elegibilidad ni columnas existentes del feed.

DROP FUNCTION IF EXISTS public.get_meta_feed();

CREATE OR REPLACE FUNCTION public.get_meta_feed()
RETURNS TABLE (
  id text,
  item_group_id text,
  title text,
  description text,
  price text,
  availability text,
  condition text,
  brand text,
  link text,
  image_link text,
  color text,
  size text,
  category text,
  filtro1 text
)
LANGUAGE sql
STABLE
AS $$
WITH wh AS (
  SELECT
    (max(id::text) FILTER (WHERE code = 'general'))::uuid AS general_id,
    (max(id::text) FILTER (WHERE code = 'venta-publico'))::uuid AS venta_id
  FROM public.warehouses
),
reserved_by_size AS (
  SELECT
    x.variant_id,
    x.size_norm,
    sum(x.reserved_qty)::int AS reserved_qty
  FROM (
    SELECT
      oi.variant_id,
      nullif(trim(coalesce(oi.size::text, '')), '') AS size_norm,
      sum(coalesce(oiss.qty, 0))::int AS reserved_qty
    FROM public.order_item_stock_sources oiss
    JOIN public.order_items oi ON oi.id = oiss.order_item_id
    JOIN public.orders o ON o.id = oi.order_id
    WHERE o.status NOT IN ('sent', 'expired', 'devolución')
      AND coalesce(oiss.qty, 0) > 0
    GROUP BY oi.variant_id, nullif(trim(coalesce(oi.size::text, '')), '')

    UNION ALL

    SELECT
      ci.variant_id,
      nullif(trim(coalesce(ci.size::text, '')), '') AS size_norm,
      sum(coalesce(ci.qty, 0))::int AS reserved_qty
    FROM public.cart_items ci
    JOIN public.carts c ON c.id = ci.cart_id
    WHERE c.status = 'open'
      AND ci.status = 'reserved'
      AND coalesce(ci.qty, 0) > 0
    GROUP BY ci.variant_id, nullif(trim(coalesce(ci.size::text, '')), '')
  ) x
  WHERE x.size_norm IS NOT NULL
  GROUP BY x.variant_id, x.size_norm
),
variant_available_sizes AS (
  SELECT
    vss.variant_id,
    trim(vss.size) AS size,
    sum(coalesce(vss.stock_qty, 0))::int AS physical_qty,
    coalesce(rbs.reserved_qty, 0)::int AS reserved_qty,
    greatest(sum(coalesce(vss.stock_qty, 0))::int - coalesce(rbs.reserved_qty, 0)::int, 0)::int AS available_qty
  FROM public.variant_size_warehouse_stock vss
  CROSS JOIN wh
  LEFT JOIN reserved_by_size rbs
    ON rbs.variant_id = vss.variant_id
   AND rbs.size_norm = nullif(trim(vss.size), '')
  WHERE nullif(trim(vss.size), '') IS NOT NULL
    AND vss.warehouse_id IN (wh.general_id, wh.venta_id)
  GROUP BY vss.variant_id, trim(vss.size), rbs.reserved_qty
  HAVING greatest(sum(coalesce(vss.stock_qty, 0))::int - coalesce(rbs.reserved_qty, 0)::int, 0)::int > 0
),
images_data AS (
  SELECT
    variant_id,
    url AS image_url,
    row_number() OVER (PARTITION BY variant_id ORDER BY position ASC) AS img_rank
  FROM public.variant_images
  WHERE url IS NOT NULL AND url != ''
)
SELECT
  nullif(trim(vs.sku), '')::text AS id,
  p.id::text AS item_group_id,
  (
    CASE
      WHEN nullif(btrim(t1.name), '') IS NOT NULL THEN
        initcap(
          regexp_replace(
            concat_ws(
              ' ',
              nullif(btrim(t1.name), ''),
              nullif(btrim(t2.name), ''),
              nullif(btrim(pv.color), ''),
              'Talle',
              vas.size
            ),
            '\s+',
            ' ',
            'g'
          )
        )
      ELSE
        initcap(
          regexp_replace(
            concat_ws(
              ' ',
              p.name,
              nullif(btrim(pv.color), ''),
              'Talle',
              vas.size
            ),
            '\s+',
            ' ',
            'g'
          )
        )
    END
  )::text AS title,
  coalesce(
    nullif(btrim(p.description), ''),
    ('Calzado femenino por mayor. Modelo ' || p.name || '.')
  )::text AS description,
  (
    CASE
      WHEN trunc(pv.price) = pv.price THEN to_char(pv.price, 'FM999999999')
      ELSE to_char(pv.price, 'FM999999999.00')
    END
    || ' ARS'
  )::text AS price,
  'in stock'::text AS availability,
  'new'::text AS condition,
  'FYL'::text AS brand,
  ('https://fylmoda.com.ar/catalogo?sku=' || nullif(trim(vs.sku), ''))::text AS link,
  coalesce(
    (SELECT img.image_url FROM images_data img
     WHERE img.variant_id = pv.id AND img.img_rank = 1),
    'https://res.cloudinary.com/dnuedzuzm/image/upload/f_auto,q_auto,w_1200/v1/meta-placeholder.jpg'
  )::text AS image_link,
  pv.color::text,
  vas.size::text AS size,
  p.category::text AS category,
  coalesce(nullif(btrim(t1.name), ''), '')::text AS filtro1
FROM variant_available_sizes vas
INNER JOIN public.variant_sizes vs
  ON vs.variant_id = vas.variant_id
 AND trim(coalesce(vs.size::text, '')) = vas.size
INNER JOIN public.product_variants pv
  ON pv.id = vas.variant_id
 AND pv.active IS TRUE
INNER JOIN public.products p
  ON p.id = pv.product_id
 AND p.status = 'active'
INNER JOIN public.catalog_public_available_view cat
  ON cat.variant_id = vas.variant_id
LEFT JOIN public.product_tags pt ON pt.product_id = p.id
LEFT JOIN public.tags t1 ON t1.id = pt.tag1_id
LEFT JOIN public.tags t2 ON t2.id = pt.tag2_id
WHERE nullif(trim(vs.sku), '') IS NOT NULL
  AND pv.price IS NOT NULL
  AND pv.price > 0
  AND nullif(
    btrim(
      CASE
        WHEN nullif(btrim(t1.name), '') IS NOT NULL THEN
          concat_ws(
            ' ',
            nullif(btrim(t1.name), ''),
            nullif(btrim(t2.name), ''),
            nullif(btrim(pv.color), ''),
            'Talle',
            vas.size
          )
        ELSE
          concat_ws(
            ' ',
            p.name,
            nullif(btrim(pv.color), ''),
            'Talle',
            vas.size
          )
      END
    ),
    ''
  ) IS NOT NULL
ORDER BY p.name, pv.color, vas.size;
$$;

GRANT EXECUTE ON FUNCTION public.get_meta_feed() TO anon;
GRANT EXECUTE ON FUNCTION public.get_meta_feed() TO authenticated;

COMMENT ON FUNCTION public.get_meta_feed() IS
  'Meta Catalog feed Fase 1: +category/filtro1 para product_type en Edge. Stock/elegibilidad sin cambios.';

SELECT pg_notify('pgrst', 'reload schema');
