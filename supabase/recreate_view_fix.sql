-- Recrear la vista catalog_public_view para corregir problemas
-- Ejecutar en el SQL Editor de Supabase

-- 1. Eliminar la vista existente
DROP VIEW IF EXISTS public.catalog_public_view CASCADE;

-- 2. Recrear la vista (copiado de 04_catalog_public_view.sql)
CREATE VIEW public.catalog_public_view AS
WITH base AS (
  SELECT
    p.id                                               AS product_id,
    p.category                                         AS "Categoria",
    p.name                                             AS "Articulo",
    coalesce(p.description,'')                         AS "Descripcion",
    pv.color                                           AS "Color",
    string_agg(distinct pv.size, ',' ORDER BY pv.size) AS "Numeracion",
    to_char(coalesce(p.created_at::date, now()::date), 'DD/MM/YYYY') AS "FechaIngreso",
    true                                               AS "Mostrar",
    'FALSE'                                            AS "Oferta",
    min(pv.price)::text                                AS "Precio",
    max(case when vi.position = 1 then vi.url end)     AS "Imagen Principal",
    max(case when vi.position = 2 then vi.url end)     AS "Imagen 1",
    max(case when vi.position = 3 then vi.url end)     AS "Imagen 2",
    max(case when vi.position = 4 then vi.url end)     AS "Imagen 3",
    pt.tag1_id,
    pt.tag2_id,
    pt.tag3_ids
  FROM public.products p
  JOIN public.product_variants pv ON pv.product_id = p.id AND pv.active = true
  LEFT JOIN public.variant_images vi ON vi.variant_id = pv.id
  LEFT JOIN public.product_tags pt ON pt.product_id = p.id
  WHERE p.status = 'active'
  GROUP BY p.id, p.category, p.name, p.description, pv.color, p.created_at, pt.tag1_id, pt.tag2_id, pt.tag3_ids
),
offers_data AS (
  SELECT
    base.*,
    coalesce(cpo.has_offer, false) AS "OfertaActiva",
    cpo.offer_price::text AS "PrecioOferta"
  FROM base
  LEFT JOIN LATERAL (
    SELECT 
      true AS has_offer,
      offer_price
    FROM public.color_price_offers
    WHERE product_id = base.product_id
      AND color = base."Color"
      AND status = 'active'
      AND current_date >= start_date
      AND current_date <= end_date
    ORDER BY created_at DESC
    LIMIT 1
  ) cpo ON true
),
promos_data AS (
  SELECT
    od."Categoria", od."Articulo", od."Descripcion", od."Color", od."Numeracion",
    od."FechaIngreso", od."Mostrar", od."Oferta", od."Precio",
    od."Imagen Principal", od."Imagen 1", od."Imagen 2", od."Imagen 3",
    od.product_id, od.tag1_id, od.tag2_id, od.tag3_ids,
    od."OfertaActiva", od."PrecioOferta",
    max(
      CASE
        WHEN pr.promo_type = '2x1' THEN '2x1'
        WHEN pr.promo_type = '2xMonto' AND pr.fixed_amount IS NOT NULL THEN '2x$' || pr.fixed_amount::text
        ELSE NULL
      END
    ) AS "PromoActiva"
  FROM offers_data od
  LEFT JOIN public.promotion_items pi ON 
    (pi.product_id = od.product_id OR pi.variant_id IN (
      SELECT pv.id FROM public.product_variants pv 
      WHERE pv.product_id = od.product_id AND pv.color = od."Color" AND pv.active = true
    ))
  LEFT JOIN public.promotions pr ON 
    pr.id = pi.promotion_id
    AND pr.status = 'active'
    AND current_date >= pr.start_date
    AND current_date <= pr.end_date
  GROUP BY od."Categoria", od."Articulo", od."Descripcion", od."Color", od."Numeracion",
           od."FechaIngreso", od."Mostrar", od."Oferta", od."Precio",
           od."Imagen Principal", od."Imagen 1", od."Imagen 2", od."Imagen 3",
           od.product_id, od.tag1_id, od.tag2_id, od.tag3_ids,
           od."OfertaActiva", od."PrecioOferta"
),
tags_data AS (
  SELECT
    pd.*,
    t1.name AS tag1_name,
    t2.name AS tag2_name,
    array_agg(t3.name ORDER BY t3.name) FILTER (WHERE t3.id IS NOT NULL) AS tag3_names
  FROM promos_data pd
  LEFT JOIN public.tags t1 ON t1.id = pd.tag1_id
  LEFT JOIN public.tags t2 ON t2.id = pd.tag2_id
  LEFT JOIN LATERAL unnest(coalesce(pd.tag3_ids, array[]::uuid[])) AS tag3_id ON true
  LEFT JOIN public.tags t3 ON t3.id = tag3_id
  GROUP BY pd."Categoria", pd."Articulo", pd."Descripcion", pd."Color", pd."Numeracion",
           pd."FechaIngreso", pd."Mostrar", pd."Oferta", pd."Precio",
           pd."Imagen Principal", pd."Imagen 1", pd."Imagen 2", pd."Imagen 3",
           pd.tag1_id, pd.tag2_id, pd.tag3_ids, t1.name, t2.name,
           pd."OfertaActiva", pd."PrecioOferta", pd."PromoActiva", pd.product_id
)
SELECT
  "Categoria","Articulo","Descripcion","Color","Numeracion","FechaIngreso",
  "Mostrar","Oferta","Precio","Imagen Principal","Imagen 1","Imagen 2","Imagen 3",
  coalesce(tag1_name, '') AS "Filtro1",
  coalesce(tag2_name, '') AS "Filtro2",
  coalesce(
    CASE 
      WHEN array_length(tag3_names, 1) > 0 THEN array_to_string(tag3_names, ',')
      ELSE ''
    END,
    ''
  ) AS "Filtro3",
  "OfertaActiva",
  coalesce("PrecioOferta", '') AS "PrecioOferta",
  coalesce("PromoActiva", '') AS "PromoActiva"
FROM tags_data;

-- 3. Otorgar permisos
GRANT SELECT ON public.catalog_public_view TO anon;
GRANT SELECT ON public.catalog_public_view TO authenticated;

-- 4. Refrescar el esquema de PostgREST
SELECT pg_notify('pgrst','reload schema');

-- 5. Verificar que los productos ahora aparecen
SELECT 
  "Articulo",
  "Categoria",
  "Color",
  "Numeracion",
  "Precio"
FROM public.catalog_public_view
WHERE "Articulo" IN ('422', 'BA300')
ORDER BY "Articulo", "Color";

