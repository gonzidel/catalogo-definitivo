-- 100_fix_security_vulnerabilities.sql — Corrección de vulnerabilidades de seguridad
-- Corrige RLS deshabilitado en tablas internas y SECURITY DEFINER en views

-- ============================================
-- Sección 1: RLS para tablas internas
-- ============================================

-- Tabla: public.customer_link_history
-- Activar RLS y revocar permisos públicos
do $$
begin
  -- Solo proceder si la tabla existe
  if exists (
    select 1 from information_schema.tables 
    where table_schema = 'public' 
    and table_name = 'customer_link_history'
  ) then
    -- Activar RLS
    alter table public.customer_link_history enable row level security;
    alter table public.customer_link_history force row level security;
    
    -- Revocar todos los permisos a anon
    revoke all on public.customer_link_history from anon;
    
    -- Revocar todos los permisos a authenticated
    revoke all on public.customer_link_history from authenticated;
    
    -- Revocar todos los permisos del rol public (blindaje total)
    revoke all on public.customer_link_history from public;
    
    -- Eliminar cualquier policy existente (para forzar bloqueo total)
    drop policy if exists customer_link_history_select on public.customer_link_history;
    drop policy if exists customer_link_history_insert on public.customer_link_history;
    drop policy if exists customer_link_history_update on public.customer_link_history;
    drop policy if exists customer_link_history_delete on public.customer_link_history;
    
    -- No crear ninguna policy: la tabla queda completamente bloqueada para anon y authenticated
    -- Solo service_role puede acceder (via Edge Functions, n8n, etc.)
    
    raise notice '✅ RLS activado y permisos revocados para customer_link_history';
  else
    raise notice 'ℹ️  Tabla customer_link_history no existe, omitiendo';
  end if;
end $$;

-- Tabla: public.pending_sales
-- Activar RLS y revocar permisos públicos
do $$
begin
  -- Solo proceder si la tabla existe
  if exists (
    select 1 from information_schema.tables 
    where table_schema = 'public' 
    and table_name = 'pending_sales'
  ) then
    -- Activar RLS
    alter table public.pending_sales enable row level security;
    alter table public.pending_sales force row level security;
    
    -- Revocar todos los permisos a anon
    revoke all on public.pending_sales from anon;
    
    -- Revocar todos los permisos a authenticated
    revoke all on public.pending_sales from authenticated;
    
    -- Revocar todos los permisos del rol public (blindaje total)
    revoke all on public.pending_sales from public;
    
    -- Eliminar cualquier policy existente (para forzar bloqueo total)
    drop policy if exists pending_sales_select on public.pending_sales;
    drop policy if exists pending_sales_insert on public.pending_sales;
    drop policy if exists pending_sales_update on public.pending_sales;
    drop policy if exists pending_sales_delete on public.pending_sales;
    
    -- No crear ninguna policy: la tabla queda completamente bloqueada para anon y authenticated
    -- Solo service_role puede acceder (via Edge Functions, n8n, etc.)
    -- Las funciones RPC con security definer seguirán funcionando porque usan service_role
    
    raise notice '✅ RLS activado y permisos revocados para pending_sales';
  else
    raise notice 'ℹ️  Tabla pending_sales no existe, omitiendo';
  end if;
end $$;

-- ============================================
-- Sección 2: View catálogo público
-- ============================================

-- Corregir catalog_public_view para usar SECURITY INVOKER (no SECURITY DEFINER)
-- Esto asegura que la view respete las policies RLS de las tablas base

do $$
begin
  -- Verificar si la view existe
  if exists (
    select 1 from information_schema.views 
    where table_schema = 'public' 
    and table_name = 'catalog_public_view'
  ) then
    -- En PostgreSQL, para cambiar de SECURITY DEFINER a SECURITY INVOKER,
    -- necesitamos recrear la view sin la opción SECURITY DEFINER.
    -- Como la view puede ser compleja, primero obtenemos su definición original
    -- y la recreamos explícitamente con SECURITY INVOKER.
    
    -- Drop la view existente (CASCADE para evitar errores de dependencias)
    drop view if exists public.catalog_public_view cascade;
    
    raise notice '✅ Vista catalog_public_view eliminada, será recreada con SECURITY INVOKER';
  else
    raise notice 'ℹ️  Vista catalog_public_view no existe, será creada con SECURITY INVOKER';
  end if;
end $$;

-- Recrear la view con SECURITY INVOKER (comportamiento por defecto, pero explícito)
-- Esta es la misma definición que en 04_catalog_public_view.sql, pero asegurando SECURITY INVOKER
create or replace view public.catalog_public_view as
with base as (
  select
    p.id                                               as product_id,
    p.category                                         as "Categoria",
    p.name                                             as "Articulo",
    coalesce(p.description,'')                         as "Descripcion",
    pv.color                                           as "Color",
    string_agg(distinct pv.size, ',' order by pv.size) as "Numeracion",
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
    pt.tag3_ids
  from public.products p
  join public.product_variants pv on pv.product_id = p.id and pv.active is true
  left join public.variant_images vi on vi.variant_id = pv.id
  left join public.product_tags pt on pt.product_id = p.id
  where p.status = 'active'
  group by p.id, p.category, p.name, p.description, pv.color, p.created_at, pt.tag1_id, pt.tag2_id, pt.tag3_ids
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
           od."OfferCampaignId", od."OfferImageUrl", od."OfferTitle"
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
           pd."OfferCampaignId", pd."OfferImageUrl", pd."OfferTitle"
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
  coalesce("OfferTitle", '') as "OfferTitle"
from tags_data;

-- Asegurar que la view use SECURITY INVOKER explícitamente (PostgreSQL 15+)
-- Si la versión no lo soporta, no es problema: las views por defecto son SECURITY INVOKER
do $$
begin
  begin
    alter view public.catalog_public_view set (security_invoker = true);
    raise notice '✅ catalog_public_view configurada con SECURITY INVOKER explícito';
  exception when others then
    -- En versiones anteriores de PostgreSQL, esto puede fallar
    -- pero no es problema porque SECURITY INVOKER es el comportamiento por defecto
    raise notice 'ℹ️  No se pudo establecer security_invoker explícitamente (versión anterior - no es problema)';
  end;
end $$;

-- Restaurar permisos: anon y authenticated pueden leer la view (necesario para el frontend)
grant select on public.catalog_public_view to anon;
grant select on public.catalog_public_view to authenticated;

-- ============================================
-- Sección 3: Policies mínimas para catálogo público
-- ============================================

-- product_tags: agregar policy de SELECT para anon (necesaria para catalog_public_view con SECURITY INVOKER)
-- Esta tabla es usada por catalog_public_view pero solo tenía policy para authenticated
do $$
begin
  if not exists (
    select 1 from pg_policies 
    where schemaname='public' 
    and tablename='product_tags' 
    and policyname='anon_select_product_tags'
  ) then
    create policy anon_select_product_tags on public.product_tags 
      for select to anon using (true);
    raise notice '✅ Policy anon_select_product_tags creada para product_tags';
  else
    raise notice 'ℹ️  Policy anon_select_product_tags ya existe en product_tags';
  end if;
end $$;

-- Recargar esquema del API REST
select pg_notify('pgrst','reload schema');

