-- 228_meta_feed_phase3_offers_images_marketing.sql
-- Fase 3: offer_price, imágenes secundarias, fecha publicación, fast sellers para sale_price/marketing.
-- NO modifica CTEs de stock ni reglas de elegibilidad.

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
  filtro1 text,
  filtro2 text,
  filtro3 text,
  detalles_similitud text,
  supplier_code text,
  oferta_activa boolean,
  list_price numeric,
  offer_price numeric,
  additional_image_link text,
  fecha_publicacion timestamptz,
  units_sold_90d integer
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
),
fast_sellers AS (
  SELECT product_id, units_sold_90d
  FROM public.vw_stock_fast_sellers
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
  coalesce(nullif(btrim(t1.name), ''), '')::text AS filtro1,
  coalesce(nullif(btrim(t2.name), ''), '')::text AS filtro2,
  coalesce((
    SELECT string_agg(t3.name, ',' ORDER BY t3.name)
    FROM unnest(coalesce(pt.tag3_ids, array[]::uuid[])) AS tag3_id
    JOIN public.tags t3 ON t3.id = tag3_id
  ), '')::text AS filtro3,
  coalesce((
    SELECT string_agg(DISTINCT t.name, ',' ORDER BY t.name)
    FROM public.product_tag_details ptd
    JOIN public.tags t ON t.id = ptd.tag3_id
    WHERE ptd.product_id = p.id
  ), '')::text AS detalles_similitud,
  coalesce(nullif(btrim(s.code), ''), '')::text AS supplier_code,
  EXISTS (
    SELECT 1
    FROM public.color_price_offers cpo
    WHERE cpo.product_id = p.id
      AND cpo.color = pv.color
      AND cpo.status = 'active'
      AND current_date >= cpo.start_date
      AND current_date <= cpo.end_date
  ) AS oferta_activa,
  pv.price::numeric AS list_price,
  (
    SELECT cpo.offer_price
    FROM public.color_price_offers cpo
    WHERE cpo.product_id = p.id
      AND cpo.color = pv.color
      AND cpo.status = 'active'
      AND current_date >= cpo.start_date
      AND current_date <= cpo.end_date
    ORDER BY cpo.created_at DESC
    LIMIT 1
  ) AS offer_price,
  coalesce((
    SELECT string_agg(img.image_url, ',' ORDER BY img.img_rank)
    FROM images_data img
    WHERE img.variant_id = pv.id
      AND img.img_rank >= 2
  ), '')::text AS additional_image_link,
  coalesce(pv.last_published_at, p.last_published_at) AS fecha_publicacion,
  coalesce(fs.units_sold_90d, 0)::int AS units_sold_90d
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
INNER JOIN (SELECT DISTINCT variant_id FROM public.catalog_public_available_view) cat
  ON cat.variant_id = vas.variant_id
LEFT JOIN public.product_tags pt ON pt.product_id = p.id
LEFT JOIN public.tags t1 ON t1.id = pt.tag1_id
LEFT JOIN public.tags t2 ON t2.id = pt.tag2_id
LEFT JOIN public.suppliers s ON s.id = p.supplier_id
LEFT JOIN fast_sellers fs ON fs.product_id = p.id
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
  'Meta Catalog feed Fase 3: +offer_price, additional_image_link, fecha_publicacion, units_sold_90d.';

SELECT pg_notify('pgrst', 'reload schema');
