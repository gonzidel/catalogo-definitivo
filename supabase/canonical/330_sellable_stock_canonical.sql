-- 330_sellable_stock_canonical.sql
-- Fase 1: fuente canónica de stock vendible público.
--
-- sellable_qty = físico web libre restante
--   = greatest(sum(variant_size_warehouse_stock.stock_qty), 0)
--     WHERE warehouse.code IN ('general', 'venta-publico')
--
-- NO resta: order_item_stock_sources, cart_items, reserved_qty, awaiting_apartado.
-- OISS queda como trazabilidad de stock ya descontado (checkout/commit).
--
-- Contrato de catalog_public_available_view: mismas columnas/tipos/orden que 223.
-- NO refresca catalog_public_snapshot.
-- NO modifica rpc_checkout_cart ni el flujo 309.
--
-- Rollback: 330_ROLLBACK_sellable_stock_canonical.sql

-- ---------------------------------------------------------------------------
-- 1) Normalización de talle (misma semántica que checkout)
--    trim; si ^\d+(\.\d+)?$ → parte entera; si no, se preserva (S, M, XL, Unico,
--    39/40, 125x3.5cm, L., etc.)
-- ---------------------------------------------------------------------------
create or replace function public.fn_norm_size(p_size text)
returns text
language sql
immutable
parallel safe
set search_path = public, pg_catalog
as $$
  select case
    when p_size is null then null
    when btrim(p_size) = '' then ''
    when btrim(p_size) ~ '^\d+(\.\d+)?$' then split_part(btrim(p_size), '.', 1)
    else btrim(p_size)
  end;
$$;

comment on function public.fn_norm_size(text) is
  'Normaliza talle: trim; si es puramente numérico usa la parte entera. Preserva S/M/L/XL/Unico/rangos/medidas. Alineado con checkout.';

revoke all on function public.fn_norm_size(text) from public;
grant execute on function public.fn_norm_size(text) to anon;
grant execute on function public.fn_norm_size(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2) Sellable individual (read-only)
-- ---------------------------------------------------------------------------
create or replace function public.fn_sellable_qty(p_variant_id uuid, p_size text)
returns integer
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  select coalesce((
    select greatest(sum(coalesce(vss.stock_qty, 0)), 0)::integer
    from public.variant_size_warehouse_stock vss
    join public.warehouses w on w.id = vss.warehouse_id
    where vss.variant_id = p_variant_id
      and w.code in ('general', 'venta-publico')
      and public.fn_norm_size(vss.size) = public.fn_norm_size(p_size)
      and public.fn_norm_size(p_size) is not null
      and public.fn_norm_size(p_size) <> ''
  ), 0);
$$;

comment on function public.fn_sellable_qty(uuid, text) is
  'Stock vendible público: greatest(sum(stock_qty),0) en warehouses general+venta-publico. No consulta OISS, carts, reserved_qty ni awaiting_apartado.';

revoke all on function public.fn_sellable_qty(uuid, text) from public;
grant execute on function public.fn_sellable_qty(uuid, text) to anon;
grant execute on function public.fn_sellable_qty(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3) Batch (máx 500 variant_ids). No expone depósitos ni reservas.
-- ---------------------------------------------------------------------------
create or replace function public.fn_sellable_stock_batch(p_variant_ids uuid[])
returns table(variant_id uuid, size text, sellable_qty integer)
language plpgsql
stable
security invoker
set search_path = public, pg_catalog
as $$
begin
  if p_variant_ids is null or coalesce(cardinality(p_variant_ids), 0) = 0 then
    return;
  end if;

  if cardinality(p_variant_ids) > 500 then
    raise exception 'fn_sellable_stock_batch: máximo 500 variant_ids';
  end if;

  return query
  select
    vss.variant_id,
    public.fn_norm_size(vss.size) as size,
    greatest(sum(coalesce(vss.stock_qty, 0)), 0)::integer as sellable_qty
  from public.variant_size_warehouse_stock vss
  join public.warehouses w on w.id = vss.warehouse_id
  where vss.variant_id = any (p_variant_ids)
    and w.code in ('general', 'venta-publico')
    and public.fn_norm_size(vss.size) is not null
    and public.fn_norm_size(vss.size) <> ''
  group by vss.variant_id, public.fn_norm_size(vss.size);
end;
$$;

comment on function public.fn_sellable_stock_batch(uuid[]) is
  'Batch de sellable_qty por variant_id+size (máx 500). Misma semántica que fn_sellable_qty. No expone depósitos, pedidos ni reserved_qty.';

revoke all on function public.fn_sellable_stock_batch(uuid[]) from public;
grant execute on function public.fn_sellable_stock_batch(uuid[]) to anon;
grant execute on function public.fn_sellable_stock_batch(uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) Vista pública: misma shape que 223; disponibilidad = sellable canónico.
--    CREATE OR REPLACE para no romper get_meta_feed() ni grants.
-- ---------------------------------------------------------------------------
create or replace view public.catalog_public_available_view as
with variant_available_sizes as (
  select
    vss.variant_id,
    public.fn_norm_size(vss.size) as size,
    greatest(sum(coalesce(vss.stock_qty, 0)), 0)::int as sellable_qty
  from public.variant_size_warehouse_stock vss
  join public.warehouses w on w.id = vss.warehouse_id
  where w.code in ('general', 'venta-publico')
    and public.fn_norm_size(vss.size) is not null
    and public.fn_norm_size(vss.size) <> ''
  group by vss.variant_id, public.fn_norm_size(vss.size)
  having greatest(sum(coalesce(vss.stock_qty, 0)), 0)::int > 0
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
    coalesce(pv.last_published_at, p.last_published_at) as "FechaPublicacion",
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
    od."FechaIngreso", od."FechaPublicacion", od."Mostrar", od."Oferta", od."Precio",
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
           od."FechaIngreso", od."FechaPublicacion", od."Mostrar", od."Oferta", od."Precio",
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
           pd."FechaIngreso", pd."FechaPublicacion", pd."Mostrar", pd."Oferta", pd."Precio",
           pd."Imagen Principal", pd."Imagen 1", pd."Imagen 2", pd."Imagen 3",
           pd.tag1_id, pd.tag2_id, pd.tag3_ids, t1.name, t2.name,
           pd."OfertaActiva", pd."PrecioOferta", pd."PromoActiva", pd.product_id, pd.variant_id,
           pd."OfferCampaignId", pd."OfferImageUrl", pd."OfferTitle", pd."ColorHex", pd."ColorDisplayNumber", pd."SupplierCode"
)
select
  "Categoria","Articulo","Descripcion","Color","Numeracion","FechaIngreso",
  "FechaPublicacion",
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

comment on view public.catalog_public_available_view is
  'Catálogo público. Numeracion = talles con fn_sellable_qty > 0 (físico web general+venta-publico). No resta OISS/carts/reserved_qty. Shape 223.';

grant select on public.catalog_public_available_view to anon;
grant select on public.catalog_public_available_view to authenticated;

-- No llamar rpc_refresh_catalog_public_snapshot() desde esta migración.

select pg_notify('pgrst', 'reload schema');
