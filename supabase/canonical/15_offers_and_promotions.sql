-- 15_offers_and_promotions.sql — Sistema de ofertas por color y promociones 2x1/2xMonto (idempotente)

-- 1) Tabla de ofertas de precio por color
create table if not exists public.color_price_offers (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  color text not null,
  offer_price numeric not null check (offer_price > 0),
  start_date date not null,
  end_date date not null,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  check (end_date >= start_date)
);

-- Agregar nuevas columnas si no existen (para tablas ya creadas)
do $$
begin
  -- Agregar offer_campaign_id
  if not exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' 
    and table_name = 'color_price_offers' 
    and column_name = 'offer_campaign_id'
  ) then
    alter table public.color_price_offers add column offer_campaign_id uuid;
  end if;
  
  -- Agregar offer_image_url
  if not exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' 
    and table_name = 'color_price_offers' 
    and column_name = 'offer_image_url'
  ) then
    alter table public.color_price_offers add column offer_image_url text;
  end if;
  
  -- Agregar offer_title
  if not exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' 
    and table_name = 'color_price_offers' 
    and column_name = 'offer_title'
  ) then
    alter table public.color_price_offers add column offer_title text;
  end if;
end $$;

-- 2) Tabla de promociones
create table if not exists public.promotions (
  id uuid primary key default gen_random_uuid(),
  promo_type text not null check (promo_type in ('2x1', '2xMonto')),
  fixed_amount numeric check (fixed_amount > 0),
  start_date date not null,
  end_date date not null,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  check (end_date >= start_date),
  check ((promo_type = '2xMonto' and fixed_amount is not null) or (promo_type = '2x1' and fixed_amount is null))
);

-- Agregar columna de imagen principal si no existe (para tablas ya creadas)
do $$
begin
  -- Agregar promo_image_url
  if not exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' 
    and table_name = 'promotions' 
    and column_name = 'promo_image_url'
  ) then
    alter table public.promotions add column promo_image_url text;
  end if;
end $$;

-- 3) Tabla de items de promociones
create table if not exists public.promotion_items (
  id uuid primary key default gen_random_uuid(),
  promotion_id uuid not null references public.promotions(id) on delete cascade,
  product_id uuid references public.products(id) on delete cascade,
  variant_id uuid references public.product_variants(id) on delete cascade,
  check ((product_id is not null and variant_id is null) or (product_id is null and variant_id is not null))
);

-- 4) Índices para mejor rendimiento
create index if not exists ix_color_offers_product_color on public.color_price_offers(product_id, color);
create index if not exists ix_color_offers_status_dates on public.color_price_offers(status, start_date, end_date);
create index if not exists ix_color_offers_campaign on public.color_price_offers(offer_campaign_id) where offer_campaign_id is not null;
create index if not exists ix_promotions_status_dates on public.promotions(status, start_date, end_date);
create index if not exists ix_promotion_items_promotion on public.promotion_items(promotion_id);
create index if not exists ix_promotion_items_product on public.promotion_items(product_id) where product_id is not null;
create index if not exists ix_promotion_items_variant on public.promotion_items(variant_id) where variant_id is not null;

-- 5) Triggers updated_at
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'color_offers_set_updated_at') then
    create trigger color_offers_set_updated_at
      before update on public.color_price_offers
      for each row execute function public.set_updated_at();
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'promotions_set_updated_at') then
    create trigger promotions_set_updated_at
      before update on public.promotions
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- 6) Función para obtener precio efectivo considerando ofertas
create or replace function public.get_effective_price(
  p_variant_id uuid,
  p_check_date date default current_date
)
returns numeric
language plpgsql
stable
as $$
declare
  v_price numeric;
  v_product_id uuid;
  v_color text;
  v_offer_price numeric;
begin
  -- Obtener precio base y datos de la variante
  select pv.price, pv.product_id, pv.color
  into v_price, v_product_id, v_color
  from public.product_variants pv
  where pv.id = p_variant_id;
  
  if v_price is null then
    return null;
  end if;
  
  -- Buscar oferta activa para este producto y color
  select cpo.offer_price
  into v_offer_price
  from public.color_price_offers cpo
  where cpo.product_id = v_product_id
    and cpo.color = v_color
    and cpo.status = 'active'
    and p_check_date >= cpo.start_date
    and p_check_date <= cpo.end_date
  order by cpo.created_at desc
  limit 1;
  
  -- Retornar precio de oferta si existe, sino precio original
  return coalesce(v_offer_price, v_price);
end $$;

-- 7) Función para obtener promociones activas para un conjunto de variantes
create or replace function public.get_active_promotions_for_variants(
  p_variant_ids uuid[]
)
returns table (
  promotion_id uuid,
  promo_type text,
  fixed_amount numeric,
  variant_ids uuid[]
)
language plpgsql
stable
as $$
begin
  return query
  with variant_promotions as (
    -- Promociones que incluyen variantes específicas
    select distinct pi.promotion_id, pi.variant_id
    from public.promotion_items pi
    where pi.variant_id = any(p_variant_ids)
    
    union
    
    -- Promociones que incluyen productos completos
    select distinct pi.promotion_id, pv.id as variant_id
    from public.promotion_items pi
    join public.product_variants pv on pv.product_id = pi.product_id
    where pi.product_id is not null
      and pv.id = any(p_variant_ids)
  ),
  active_promos as (
    select 
      p.id as promotion_id,
      p.promo_type,
      p.fixed_amount,
      array_agg(distinct vp.variant_id) as variant_ids
    from public.promotions p
    join variant_promotions vp on vp.promotion_id = p.id
    where p.status = 'active'
      and current_date >= p.start_date
      and current_date <= p.end_date
    group by p.id, p.promo_type, p.fixed_amount
  )
  select 
    ap.promotion_id,
    ap.promo_type,
    ap.fixed_amount,
    ap.variant_ids
  from active_promos ap;
end $$;

-- 8) RLS Policies
alter table public.color_price_offers enable row level security;
alter table public.promotions enable row level security;
alter table public.promotion_items enable row level security;

-- Lectura pública para ofertas activas
drop policy if exists anon_select_active_offers on public.color_price_offers;
create policy anon_select_active_offers on public.color_price_offers
  for select to anon
  using (status = 'active' and current_date >= start_date and current_date <= end_date);

-- Lectura pública para promociones activas
drop policy if exists anon_select_active_promotions on public.promotions;
create policy anon_select_active_promotions on public.promotions
  for select to anon
  using (status = 'active' and current_date >= start_date and current_date <= end_date);

-- Lectura pública para items de promociones activas
drop policy if exists anon_select_active_promotion_items on public.promotion_items;
create policy anon_select_active_promotion_items on public.promotion_items
  for select to anon
  using (
    exists (
      select 1 from public.promotions p
      where p.id = promotion_id
        and p.status = 'active'
        and current_date >= p.start_date
        and current_date <= p.end_date
    )
  );

-- Administración completa para authenticated (ajustar según permisos del sistema)
drop policy if exists authenticated_manage_offers on public.color_price_offers;
create policy authenticated_manage_offers on public.color_price_offers
  for all to authenticated
  using (true)
  with check (true);

drop policy if exists authenticated_manage_promotions on public.promotions;
create policy authenticated_manage_promotions on public.promotions
  for all to authenticated
  using (true)
  with check (true);

drop policy if exists authenticated_manage_promotion_items on public.promotion_items;
create policy authenticated_manage_promotion_items on public.promotion_items
  for all to authenticated
  using (true)
  with check (true);

-- 9) Función para obtener ofertas activas con imágenes agrupadas por campaña
create or replace function public.get_active_offers_with_images()
returns table (
  offer_campaign_id uuid,
  offer_image_url text,
  offer_title text,
  product_count bigint,
  start_date date,
  end_date date
)
language plpgsql
stable
as $$
begin
  return query
  select 
    cpo.offer_campaign_id,
    max(cpo.offer_image_url) as offer_image_url,
    max(cpo.offer_title) as offer_title,
    count(distinct cpo.product_id || '|' || cpo.color) as product_count,
    min(cpo.start_date) as start_date,
    max(cpo.end_date) as end_date
  from public.color_price_offers cpo
  where cpo.status = 'active'
    and current_date >= cpo.start_date
    and current_date <= cpo.end_date
    and cpo.offer_campaign_id is not null
    and cpo.offer_image_url is not null
  group by cpo.offer_campaign_id
  having count(distinct cpo.product_id || '|' || cpo.color) > 0;
end $$;

-- Notificar a PostgREST para recargar schema
select pg_notify('pgrst','reload schema');


