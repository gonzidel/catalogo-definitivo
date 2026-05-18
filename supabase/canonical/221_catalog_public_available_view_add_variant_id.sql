-- 221_catalog_public_available_view_add_variant_id.sql
-- Añade columna variant_id (uuid = product_variants.id) a catalog_public_available_view.
-- Cambio ADITIVO al final del SELECT; columnas existentes sin reorden.
-- Nombre snake_case: alinea con product_variant_id y Supabase JS (.in('variant_id', ...)).
--
-- DEPLOY staging (orden):
--   1) Este archivo (recreate view + snapshot column)
--   2) 222_snapshot_parity_detalles_similitud.sql (paridad orden/tipos + refresh seguro)
--   3) Alternativa manual: rpc_refresh_catalog_public_snapshot() (JWT admin) solo si 222 ya aplicó paridad
--
-- Canonical en repo: supabase/canonical/193_catalog_public_available_view.sql (sincronizado).
-- Rollback: 221_ROLLBACK_catalog_public_available_view_add_variant_id.sql
--
-- Riesgo: breve DROP VIEW; consumidores PostgREST reintentan. Sin downtime de tablas.

drop view if exists public.catalog_public_available_view;

create view public.catalog_public_available_view as
with wh as (
  select
    (max(id::text) filter (where code = 'general'))::uuid as general_id,
    (max(id::text) filter (where code = 'venta-publico'))::uuid as venta_id
  from public.warehouses
),
reserved_by_size as (
  select
    x.variant_id,
    x.size_norm,
    sum(x.reserved_qty)::int as reserved_qty
  from (
    select
      oi.variant_id,
      nullif(trim(coalesce(oi.size::text, '')), '') as size_norm,
      sum(coalesce(oiss.qty, 0))::int as reserved_qty
    from public.order_item_stock_sources oiss
    join public.order_items oi on oi.id = oiss.order_item_id
    join public.orders o on o.id = oi.order_id
    where o.status not in ('sent', 'expired', 'devolución')
      and coalesce(oiss.qty, 0) > 0
    group by oi.variant_id, nullif(trim(coalesce(oi.size::text, '')), '')

    union all

    select
      ci.variant_id,
      nullif(trim(coalesce(ci.size::text, '')), '') as size_norm,
      sum(coalesce(ci.qty, 0))::int as reserved_qty
    from public.cart_items ci
    join public.carts c on c.id = ci.cart_id
    where c.status = 'open'
      and ci.status = 'reserved'
      and coalesce(ci.qty, 0) > 0
    group by ci.variant_id, nullif(trim(coalesce(ci.size::text, '')), '')
  ) x
  where x.size_norm is not null
  group by x.variant_id, x.size_norm
),
variant_available_sizes as (
  select
    vss.variant_id,
    trim(vss.size) as size,
    sum(coalesce(vss.stock_qty, 0))::int as physical_qty,
    coalesce(rbs.reserved_qty, 0)::int as reserved_qty,
    greatest(sum(coalesce(vss.stock_qty, 0))::int - coalesce(rbs.reserved_qty, 0)::int, 0)::int as available_qty
  from public.variant_size_warehouse_stock vss
  cross join wh
  left join reserved_by_size rbs
    on rbs.variant_id = vss.variant_id
   and rbs.size_norm = nullif(trim(vss.size), '')
  where nullif(trim(vss.size), '') is not null
    and vss.warehouse_id in (wh.general_id, wh.venta_id)
  group by vss.variant_id, trim(vss.size), rbs.reserved_qty
  having greatest(sum(coalesce(vss.stock_qty, 0))::int - coalesce(rbs.reserved_qty, 0)::int, 0)::int > 0
),
base as (
  select
    p.id as product_id,
    pv.id as variant_id,
    p.category as "Categoria",
    p.name as "Articulo",
    coalesce(p.description, '') as "Descripcion",
    pv.color as "Color",
    sz.numeracion as "Numeracion",
    to_char(coalesce(p.created_at::date, now()::date), 'DD/MM/YYYY') as "FechaIngreso",
    true as "Mostrar",
    'FALSE' as "Oferta",
    pv.price::text as "Precio",
    coalesce(img."Imagen Principal", img.first_image) as "Imagen Principal",
    img."Imagen 1",
    img."Imagen 2",
    img."Imagen 3",
    pt.tag1_id,
    pt.tag2_id,
    pt.tag3_ids,
    c.hex_color as "ColorHex",
    c.display_number as "ColorDisplayNumber",
    coalesce(s.code, '') as "SupplierCode"
  from public.products p
  join public.product_variants pv
    on pv.product_id = p.id
   and pv.active is true
  left join public.suppliers s on s.id = p.supplier_id
  left join public.product_tags pt on pt.product_id = p.id
  left join public.colors c on lower(trim(c.name)) = lower(trim(pv.color))
  join lateral (
    select
      string_agg(distinct vas.size, ',' order by vas.size) as numeracion
    from variant_available_sizes vas
    where vas.variant_id = pv.id
  ) sz on sz.numeracion is not null
  join lateral (
    select
      max(case when vi.position = 1 then vi.url end) as "Imagen Principal",
      max(case when vi.position = 2 then vi.url end) as "Imagen 1",
      max(case when vi.position = 3 then vi.url end) as "Imagen 2",
      max(case when vi.position = 4 then vi.url end) as "Imagen 3",
      min(nullif(trim(vi.url), '')) as first_image,
      count(*) filter (where nullif(trim(vi.url), '') is not null) as image_count
    from public.variant_images vi
    where vi.variant_id = pv.id
  ) img on img.image_count > 0
  where p.status = 'active'
),
offers_data as (
  select
    base.*,
    coalesce(cpo.has_offer, false) as "OfertaActiva",
    cpo.offer_price::text as "PrecioOferta",
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
    od.product_id, od.variant_id, od.tag1_id, od.tag2_id, od.tag3_ids,
    od."OfertaActiva", od."PrecioOferta",
    od."OfferCampaignId", od."OfferImageUrl", od."OfferTitle",
    od."ColorHex", od."ColorDisplayNumber", od."SupplierCode",
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
           od.product_id, od.variant_id, od.tag1_id, od.tag2_id, od.tag3_ids,
           od."OfertaActiva", od."PrecioOferta",
           od."OfferCampaignId", od."OfferImageUrl", od."OfferTitle", od."ColorHex", od."ColorDisplayNumber", od."SupplierCode"
),
tags_data as (
  select
    pd.*,
    t1.name as tag1_name,
    t2.name as tag2_name,
    array_agg(t3.name order by t3.name) filter (where t3.id is not null) as tag3_names,
    coalesce((
      select string_agg(distinct t.name, ',' order by t.name)
      from public.product_tag_details ptd
      join public.tags t on t.id = ptd.tag3_id
      where ptd.product_id = pd.product_id
    ), '') as detalles_similitud
  from promos_data pd
  left join public.tags t1 on t1.id = pd.tag1_id
  left join public.tags t2 on t2.id = pd.tag2_id
  left join lateral unnest(coalesce(pd.tag3_ids, array[]::uuid[])) as tag3_id on true
  left join public.tags t3 on t3.id = tag3_id
  group by pd."Categoria", pd."Articulo", pd."Descripcion", pd."Color", pd."Numeracion",
           pd."FechaIngreso", pd."Mostrar", pd."Oferta", pd."Precio",
           pd."Imagen Principal", pd."Imagen 1", pd."Imagen 2", pd."Imagen 3",
           pd.tag1_id, pd.tag2_id, pd.tag3_ids, t1.name, t2.name,
           pd."OfertaActiva", pd."PrecioOferta", pd."PromoActiva", pd.product_id, pd.variant_id,
           pd."OfferCampaignId", pd."OfferImageUrl", pd."OfferTitle", pd."ColorHex", pd."ColorDisplayNumber", pd."SupplierCode"
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
  coalesce(detalles_similitud, '') as "DetallesSimilitud",
  "OfertaActiva",
  coalesce("PrecioOferta", '') as "PrecioOferta",
  coalesce("PromoActiva", '') as "PromoActiva",
  "OfferCampaignId",
  coalesce("OfferImageUrl", '') as "OfferImageUrl",
  coalesce("OfferTitle", '') as "OfferTitle",
  coalesce("ColorHex", '') as "ColorHex",
  "ColorDisplayNumber",
  coalesce("SupplierCode", '') as "SupplierCode",
  variant_id
from tags_data;

grant select on public.catalog_public_available_view to anon;
grant select on public.catalog_public_available_view to authenticated;

alter table public.catalog_public_snapshot
  add column if not exists variant_id uuid;

-- Tras apply: ejecutar 222 (recomendado) o refresh admin si paridad ya OK:
--   select public.fyl_rebuild_catalog_public_snapshot_parity(true);
--   -- o: select public.rpc_refresh_catalog_public_snapshot();

select pg_notify('pgrst', 'reload schema');
