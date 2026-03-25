-- 72_UPDATE_CATALOG_VIEW_FILTER_VARIANTS.sql
-- Actualizar catalog_public_view para filtrar variantes que no tengan stock > 0 o imágenes
-- (filtrado a nivel de variante, no de producto)

-- Dropear la vista existente
drop view if exists public.catalog_public_view;

-- Recrear la vista con filtrado a nivel de variante
create view public.catalog_public_view as
with base as (
  select
    p.id                                               as product_id,
    p.category                                         as "Categoria",
    p.name                                             as "Articulo",
    coalesce(p.description,'')                         as "Descripcion",
    pv.color                                           as "Color",
    -- Obtener talles desde variant_sizes en lugar de product_variants.size
    coalesce(
      string_agg(distinct vs.size, ',' order by vs.size) filter (where vs.size is not null and vs.size != ''),
      'Único'
    ) as "Numeracion",
    to_char(coalesce(p.created_at::date, now()::date), 'DD/MM/YYYY') as "FechaIngreso",
    true                                               as "Mostrar",
    'FALSE'                                            as "Oferta", -- Mantener por compatibilidad
    min(pv.price)::text                                as "Precio",
    max(case when vi.position = 1 then vi.url end)     as "Imagen Principal",
    max(case when vi.position = 2 then vi.url end)     as "Imagen 1",
    max(case when vi.position = 3 then vi.url end)     as "Imagen 2",
    max(case when vi.position = 4 then vi.url end)     as "Imagen 3",
    pt.tag1_id,
    pt.tag2_id,
    pt.tag3_ids,
    c.hex_color                                        as "ColorHex"
  from public.products p
  join public.product_variants pv on pv.product_id = p.id and pv.active is true
  -- Filtrar variantes que tienen stock > 0 en al menos un talle
  inner join (
    select distinct variant_id
    from variant_sizes
    where stock_qty > 0
  ) vs_with_stock on vs_with_stock.variant_id = pv.id
  -- Filtrar variantes que tienen al menos una imagen
  inner join (
    select distinct variant_id
    from variant_images
  ) vi_with_images on vi_with_images.variant_id = pv.id
  left join public.variant_sizes vs on vs.variant_id = pv.id
  left join public.variant_images vi on vi.variant_id = pv.id
  left join public.product_tags pt on pt.product_id = p.id
  left join public.colors c on lower(trim(c.name)) = lower(trim(pv.color))
  where p.status = 'active'
  group by p.id, p.category, p.name, p.description, pv.color, p.created_at, pt.tag1_id, pt.tag2_id, pt.tag3_ids, c.hex_color
),
offers_data as (
  select
    base.*,
    -- Oferta activa para este producto y color
    coalesce(cpo.has_offer, false) as "OfertaActiva",
    -- Precio de oferta (si existe) - tomar la más reciente
    cpo.offer_price::text as "PrecioOferta",
    -- Datos de campaña de oferta
    cpo.offer_campaign_id as "OfferCampaignId",
    cpo.offer_image_url as "OfferImageUrl",
    cpo.offer_title as "OfferTitle"
  from base
  left join lateral (
    select 
      true as has_offer,
      offer_price,
      offer_campaign_id,
      offer_image_url,
      offer_title
    from public.color_price_offers
    where product_id = base.product_id
      and color = base."Color"
      and status = 'active'
      and current_date >= start_date
      and current_date <= end_date
    order by created_at desc
    limit 1
  ) cpo on true
),
promos_data as (
  select
    od."Categoria", od."Articulo", od."Descripcion", od."Color", od."Numeracion",
    od."FechaIngreso", od."Mostrar", od."Oferta", od."Precio",
    od."Imagen Principal", od."Imagen 1", od."Imagen 2", od."Imagen 3",
    od.product_id, od.tag1_id, od.tag2_id, od.tag3_ids,
    od."OfertaActiva", od."PrecioOferta",
    od."OfferCampaignId", od."OfferImageUrl", od."OfferTitle",
    od."ColorHex",
    -- Promoción activa (texto: '2x1' o '2x$XXX' o null)
    max(
      case
        when pr.promo_type = '2x1' then '2x1'
        when pr.promo_type = '2xMonto' and pr.fixed_amount is not null then '2x$' || pr.fixed_amount::text
        else null
      end
    ) as "PromoActiva"
  from offers_data od
  left join public.promotion_items pi on 
    (pi.product_id = od.product_id or pi.variant_id in (
      select pv.id from public.product_variants pv 
      where pv.product_id = od.product_id and pv.color = od."Color" and pv.active = true
    ))
  left join public.promotions pr on 
    pr.id = pi.promotion_id
    and pr.status = 'active'
    and current_date >= pr.start_date
    and current_date <= pr.end_date
  group by od."Categoria", od."Articulo", od."Descripcion", od."Color", od."Numeracion",
           od."FechaIngreso", od."Mostrar", od."Oferta", od."Precio",
           od."Imagen Principal", od."Imagen 1", od."Imagen 2", od."Imagen 3",
           od.product_id, od.tag1_id, od.tag2_id, od.tag3_ids,
           od."OfertaActiva", od."PrecioOferta",
           od."OfferCampaignId", od."OfferImageUrl", od."OfferTitle", od."ColorHex"
),
tags_data as (
  select
    pd.*,
    t1.name as tag1_name,
    t2.name as tag2_name,
    array_agg(t3.name order by t3.name) filter (where t3.id is not null) as tag3_names
  from promos_data pd
  left join public.tags t1 on t1.id = pd.tag1_id
  left join public.tags t2 on t2.id = pd.tag2_id
  left join lateral unnest(coalesce(pd.tag3_ids, array[]::uuid[])) as tag3_id on true
  left join public.tags t3 on t3.id = tag3_id
  group by pd."Categoria", pd."Articulo", pd."Descripcion", pd."Color", pd."Numeracion",
           pd."FechaIngreso", pd."Mostrar", pd."Oferta", pd."Precio",
           pd."Imagen Principal", pd."Imagen 1", pd."Imagen 2", pd."Imagen 3",
           pd.tag1_id, pd.tag2_id, pd.tag3_ids, t1.name, t2.name,
           pd."OfertaActiva", pd."PrecioOferta", pd."PromoActiva", pd.product_id,
           pd."OfferCampaignId", pd."OfferImageUrl", pd."OfferTitle", pd."ColorHex"
)
select
  "Categoria","Articulo","Descripcion","Color","Numeracion","FechaIngreso",
  "Mostrar","Oferta","Precio","Imagen Principal","Imagen 1","Imagen 2","Imagen 3",
  coalesce(tag1_name, '') as "Filtro1",
  coalesce(tag2_name, '') as "Filtro2",
  coalesce(
    case 
      when array_length(tag3_names, 1) > 0 then array_to_string(tag3_names, ',')
      else ''
    end,
    ''
  ) as "Filtro3",
  "OfertaActiva",
  coalesce("PrecioOferta", '') as "PrecioOferta",
  coalesce("PromoActiva", '') as "PromoActiva",
  "OfferCampaignId",
  coalesce("OfferImageUrl", '') as "OfferImageUrl",
  coalesce("OfferTitle", '') as "OfferTitle",
  coalesce("ColorHex", '') as "ColorHex"
from tags_data;

-- Otorgar permisos
grant select on public.catalog_public_view to anon;
grant select on public.catalog_public_view to authenticated;

-- Notificar recarga de esquema
select pg_notify('pgrst','reload schema');

