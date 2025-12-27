-- Probar cada etapa de la vista catalog_public_view para encontrar dónde se pierden los productos
-- Ejecutar cada CTE por separado

-- ETAPA 1: Base (debería incluir los productos)
WITH base AS (
  SELECT
    p.id as product_id,
    p.category as "Categoria",
    p.name as "Articulo",
    coalesce(p.description,'') as "Descripcion",
    pv.color as "Color",
    string_agg(distinct pv.size, ',' order by pv.size) as "Numeracion",
    to_char(coalesce(p.created_at::date, now()::date), 'DD/MM/YYYY') as "FechaIngreso",
    true as "Mostrar",
    'FALSE' as "Oferta",
    min(pv.price)::text as "Precio",
    max(case when vi.position = 1 then vi.url end) as "Imagen Principal",
    max(case when vi.position = 2 then vi.url end) as "Imagen 1",
    max(case when vi.position = 3 then vi.url end) as "Imagen 2",
    max(case when vi.position = 4 then vi.url end) as "Imagen 3",
    pt.tag1_id,
    pt.tag2_id,
    pt.tag3_ids
  FROM public.products p
  JOIN public.product_variants pv ON pv.product_id = p.id AND pv.active = true
  LEFT JOIN public.variant_images vi ON vi.variant_id = pv.id
  LEFT JOIN public.product_tags pt ON pt.product_id = p.id
  WHERE p.status = 'active'
  GROUP BY p.id, p.category, p.name, p.description, pv.color, p.created_at, pt.tag1_id, pt.tag2_id, pt.tag3_ids
)
SELECT 
  'ETAPA 1: Base' as etapa,
  "Articulo",
  "Categoria",
  "Color",
  "Numeracion",
  "Precio"
FROM base
WHERE "Articulo" IN ('422', 'BA300')
ORDER BY "Articulo", "Color";

-- ETAPA 2: Offers (debería mantener los productos)
WITH base AS (
  SELECT
    p.id as product_id,
    p.category as "Categoria",
    p.name as "Articulo",
    coalesce(p.description,'') as "Descripcion",
    pv.color as "Color",
    string_agg(distinct pv.size, ',' order by pv.size) as "Numeracion",
    to_char(coalesce(p.created_at::date, now()::date), 'DD/MM/YYYY') as "FechaIngreso",
    true as "Mostrar",
    'FALSE' as "Oferta",
    min(pv.price)::text as "Precio",
    max(case when vi.position = 1 then vi.url end) as "Imagen Principal",
    max(case when vi.position = 2 then vi.url end) as "Imagen 1",
    max(case when vi.position = 3 then vi.url end) as "Imagen 2",
    max(case when vi.position = 4 then vi.url end) as "Imagen 3",
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
    coalesce(cpo.has_offer, false) as "OfertaActiva",
    cpo.offer_price::text as "PrecioOferta"
  FROM base
  LEFT JOIN LATERAL (
    SELECT 
      true as has_offer,
      offer_price
    FROM public.color_price_offers
    WHERE product_id = base.product_id
      AND color = base."Color"
      AND status = 'active'
      AND current_date >= start_date
      AND current_date <= end_date
    ORDER BY created_at desc
    LIMIT 1
  ) cpo ON true
)
SELECT 
  'ETAPA 2: Offers' as etapa,
  "Articulo",
  "Categoria",
  "Color",
  "Numeracion",
  "Precio"
FROM offers_data
WHERE "Articulo" IN ('422', 'BA300')
ORDER BY "Articulo", "Color";

-- ETAPA 3: Promos (debería mantener los productos)
WITH base AS (
  SELECT
    p.id as product_id,
    p.category as "Categoria",
    p.name as "Articulo",
    coalesce(p.description,'') as "Descripcion",
    pv.color as "Color",
    string_agg(distinct pv.size, ',' order by pv.size) as "Numeracion",
    to_char(coalesce(p.created_at::date, now()::date), 'DD/MM/YYYY') as "FechaIngreso",
    true as "Mostrar",
    'FALSE' as "Oferta",
    min(pv.price)::text as "Precio",
    max(case when vi.position = 1 then vi.url end) as "Imagen Principal",
    max(case when vi.position = 2 then vi.url end) as "Imagen 1",
    max(case when vi.position = 3 then vi.url end) as "Imagen 2",
    max(case when vi.position = 4 then vi.url end) as "Imagen 3",
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
    coalesce(cpo.has_offer, false) as "OfertaActiva",
    cpo.offer_price::text as "PrecioOferta"
  FROM base
  LEFT JOIN LATERAL (
    SELECT 
      true as has_offer,
      offer_price
    FROM public.color_price_offers
    WHERE product_id = base.product_id
      AND color = base."Color"
      AND status = 'active'
      AND current_date >= start_date
      AND current_date <= end_date
    ORDER BY created_at desc
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
      case
        when pr.promo_type = '2x1' then '2x1'
        when pr.promo_type = '2xMonto' and pr.fixed_amount is not null then '2x$' || pr.fixed_amount::text
        else null
      end
    ) as "PromoActiva"
  FROM offers_data od
  LEFT JOIN public.promotion_items pi ON 
    (pi.product_id = od.product_id or pi.variant_id in (
      select pv.id from public.product_variants pv 
      where pv.product_id = od.product_id and pv.color = od."Color" and pv.active = true
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
)
SELECT 
  'ETAPA 3: Promos' as etapa,
  "Articulo",
  "Categoria",
  "Color",
  "Numeracion",
  "Precio"
FROM promos_data
WHERE "Articulo" IN ('422', 'BA300')
ORDER BY "Articulo", "Color";

-- ETAPA 4: Tags (última etapa antes del SELECT final)
WITH base AS (
  SELECT
    p.id as product_id,
    p.category as "Categoria",
    p.name as "Articulo",
    coalesce(p.description,'') as "Descripcion",
    pv.color as "Color",
    string_agg(distinct pv.size, ',' order by pv.size) as "Numeracion",
    to_char(coalesce(p.created_at::date, now()::date), 'DD/MM/YYYY') as "FechaIngreso",
    true as "Mostrar",
    'FALSE' as "Oferta",
    min(pv.price)::text as "Precio",
    max(case when vi.position = 1 then vi.url end) as "Imagen Principal",
    max(case when vi.position = 2 then vi.url end) as "Imagen 1",
    max(case when vi.position = 3 then vi.url end) as "Imagen 2",
    max(case when vi.position = 4 then vi.url end) as "Imagen 3",
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
    coalesce(cpo.has_offer, false) as "OfertaActiva",
    cpo.offer_price::text as "PrecioOferta"
  FROM base
  LEFT JOIN LATERAL (
    SELECT 
      true as has_offer,
      offer_price
    FROM public.color_price_offers
    WHERE product_id = base.product_id
      AND color = base."Color"
      AND status = 'active'
      AND current_date >= start_date
      AND current_date <= end_date
    ORDER BY created_at desc
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
      case
        when pr.promo_type = '2x1' then '2x1'
        when pr.promo_type = '2xMonto' and pr.fixed_amount is not null then '2x$' || pr.fixed_amount::text
        else null
      end
    ) as "PromoActiva"
  FROM offers_data od
  LEFT JOIN public.promotion_items pi ON 
    (pi.product_id = od.product_id or pi.variant_id in (
      select pv.id from public.product_variants pv 
      where pv.product_id = od.product_id and pv.color = od."Color" and pv.active = true
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
    t1.name as tag1_name,
    t2.name as tag2_name,
    array_agg(t3.name order by t3.name) filter (where t3.id is not null) as tag3_names
  FROM promos_data pd
  LEFT JOIN public.tags t1 ON t1.id = pd.tag1_id
  LEFT JOIN public.tags t2 ON t2.id = pd.tag2_id
  LEFT JOIN LATERAL unnest(coalesce(pd.tag3_ids, array[]::uuid[])) as tag3_id ON true
  LEFT JOIN public.tags t3 ON t3.id = tag3_id
  GROUP BY pd."Categoria", pd."Articulo", pd."Descripcion", pd."Color", pd."Numeracion",
           pd."FechaIngreso", pd."Mostrar", pd."Oferta", pd."Precio",
           pd."Imagen Principal", pd."Imagen 1", pd."Imagen 2", pd."Imagen 3",
           pd.tag1_id, pd.tag2_id, pd.tag3_ids, t1.name, t2.name,
           pd."OfertaActiva", pd."PrecioOferta", pd."PromoActiva", pd.product_id
)
SELECT 
  'ETAPA 4: Tags' as etapa,
  "Articulo",
  "Categoria",
  "Color",
  "Numeracion",
  "Precio",
  tag1_name,
  tag2_name,
  tag3_names
FROM tags_data
WHERE "Articulo" IN ('422', 'BA300')
ORDER BY "Articulo", "Color";

