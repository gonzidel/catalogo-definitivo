-- 220_curated_product_banners_schema.sql
-- Curated Banner v1.1 — schema aditivo (product_variant_id).
-- NO reemplaza tag_value ni el runtime legacy de custom-banner.js.
--
-- DEPLOY: staging primero. NO aplicar en producción sin aprobación explícita.
-- Rollback: 220_ROLLBACK_curated_product_banners_schema.sql
--
-- Post-apply (readonly):
--   select column_name from information_schema.columns
--   where table_name = 'custom_product_banner_items';

-- =============================================================================
-- 1) Evolución custom_product_banners (columnas curated; legacy intacto)
-- =============================================================================

alter table public.custom_product_banners
  add column if not exists title text,
  add column if not exists slug text,
  add column if not exists description text,
  add column if not exists cover_image text,
  add column if not exists sort_order integer not null default 0;

-- Backfill title desde name (idempotente)
update public.custom_product_banners
set title = coalesce(
  nullif(trim(title), ''),
  nullif(trim(name), ''),
  'Banner'
)
where title is null or trim(title) = '';

-- Backfill slug desde name; sufijo corto de id si colisión
update public.custom_product_banners b
set slug = sub.final_slug
from (
  select
    id,
    case
      when exists (
        select 1
        from public.custom_product_banners b2
        where b2.id <> b0.id
          and b2.slug = b0.candidate_slug
      )
      then b0.candidate_slug || '-' || left(replace(b0.id::text, '-', ''), 8)
      else b0.candidate_slug
    end as final_slug
  from (
    select
      id,
      trim(both '-' from lower(
        regexp_replace(
          coalesce(nullif(trim(name), ''), 'banner'),
          '[^a-zA-Z0-9]+',
          '-',
          'g'
        )
      )) as candidate_slug
    from public.custom_product_banners b0
    where slug is null or trim(slug) = ''
  ) b0
) sub
where b.id = sub.id
  and (b.slug is null or trim(b.slug) = '');

-- Slugs explícitos vacíos → candidato desde title
update public.custom_product_banners b
set slug = sub.final_slug
from (
  select
    id,
    case
      when exists (
        select 1
        from public.custom_product_banners b2
        where b2.id <> b0.id
          and b2.slug = b0.candidate_slug
      )
      then b0.candidate_slug || '-' || left(replace(b0.id::text, '-', ''), 8)
      else b0.candidate_slug
    end as final_slug
  from (
    select
      id,
      trim(both '-' from lower(
        regexp_replace(
          coalesce(nullif(trim(title), ''), nullif(trim(name), ''), 'banner'),
          '[^a-zA-Z0-9]+',
          '-',
          'g'
        )
      )) as candidate_slug
    from public.custom_product_banners b0
    where slug is null or trim(slug) = ''
  ) b0
) sub
where b.id = sub.id
  and (b.slug is null or trim(b.slug) = '');

create unique index if not exists uq_custom_product_banners_slug
  on public.custom_product_banners (slug)
  where slug is not null and trim(slug) <> '';

create index if not exists idx_custom_product_banners_enabled_sort
  on public.custom_product_banners (enabled, sort_order, created_at desc)
  where enabled = true;

comment on column public.custom_product_banners.title is
  'Título visible en home / #/banner/{slug}. Legacy: name sigue usándose por custom-banner.js.';
comment on column public.custom_product_banners.slug is
  'Slug URL para Curated Banner v1.1 (#/banner/{slug}).';
comment on column public.custom_product_banners.tag_value is
  'LEGACY: matcher por tags (custom-banner.js). No usar en Curated Banner v1.1.';

-- =============================================================================
-- 2) Tabla ítems — una fila = una variante visual (product_variants.id)
-- =============================================================================

create table if not exists public.custom_product_banner_items (
  id uuid primary key default gen_random_uuid(),
  banner_id uuid not null
    references public.custom_product_banners (id) on delete cascade,
  product_variant_id uuid not null
    references public.product_variants (id) on delete cascade,
  product_id uuid not null
    references public.products (id) on delete cascade,
  position integer not null,
  created_at timestamptz not null default now(),
  constraint custom_product_banner_items_position_positive check (position > 0),
  constraint custom_product_banner_items_max_position check (position <= 20)
);

create unique index if not exists uq_custom_product_banner_items_banner_variant
  on public.custom_product_banner_items (banner_id, product_variant_id);

create unique index if not exists uq_custom_product_banner_items_banner_product
  on public.custom_product_banner_items (banner_id, product_id);

create unique index if not exists uq_custom_product_banner_items_banner_position
  on public.custom_product_banner_items (banner_id, position);

create index if not exists idx_custom_product_banner_items_banner_position
  on public.custom_product_banner_items (banner_id, position);

comment on table public.custom_product_banner_items is
  'Curated Banner v1.1: variantes visuales ordenadas. Sin SKU persistido.';
comment on column public.custom_product_banner_items.product_variant_id is
  'FK a product_variants.id — color/variante representativa en el carrusel.';
comment on column public.custom_product_banner_items.product_id is
  'Denormalizado desde la variante; UNIQUE(banner_id, product_id) evita dos colores del mismo producto.';

-- =============================================================================
-- 3) Triggers
-- =============================================================================

create or replace function public.fyl_banner_item_sync_product_id()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  v_product_id uuid;
begin
  select pv.product_id
    into v_product_id
  from public.product_variants pv
  where pv.id = new.product_variant_id;

  if v_product_id is null then
    raise exception 'invalid_product_variant_id'
      using errcode = 'foreign_key_violation';
  end if;

  new.product_id := v_product_id;
  return new;
end;
$$;

drop trigger if exists trg_custom_product_banner_items_sync_product
  on public.custom_product_banner_items;
create trigger trg_custom_product_banner_items_sync_product
  before insert or update of product_variant_id
  on public.custom_product_banner_items
  for each row
  execute function public.fyl_banner_item_sync_product_id();

create or replace function public.fyl_enforce_banner_items_max_20()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  v_banner_id uuid;
  v_count integer;
begin
  v_banner_id := coalesce(new.banner_id, old.banner_id);

  select count(*)::integer
    into v_count
  from public.custom_product_banner_items
  where banner_id = v_banner_id
    and (
      tg_op = 'INSERT'
      or id is distinct from new.id
    );

  if v_count >= 20 then
    raise exception 'banner_items_max_20_exceeded'
      using errcode = 'check_violation',
            hint = 'Máximo 20 variantes por banner.';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_custom_product_banner_items_max_20
  on public.custom_product_banner_items;
create trigger trg_custom_product_banner_items_max_20
  before insert or update of banner_id
  on public.custom_product_banner_items
  for each row
  execute function public.fyl_enforce_banner_items_max_20();

-- =============================================================================
-- 4) RLS + grants (lectura pública solo banners enabled)
-- =============================================================================

alter table public.custom_product_banner_items enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'custom_product_banner_items'
      and policyname = 'anon_select_custom_product_banner_items'
  ) then
    create policy anon_select_custom_product_banner_items
      on public.custom_product_banner_items
      for select
      to anon
      using (
        exists (
          select 1
          from public.custom_product_banners b
          where b.id = banner_id
            and b.enabled = true
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'custom_product_banner_items'
      and policyname = 'authenticated_select_custom_product_banner_items'
  ) then
    create policy authenticated_select_custom_product_banner_items
      on public.custom_product_banner_items
      for select
      to authenticated
      using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'custom_product_banner_items'
      and policyname = 'admin_write_custom_product_banner_items'
  ) then
    create policy admin_write_custom_product_banner_items
      on public.custom_product_banner_items
      for all
      to authenticated
      using (
        exists (
          select 1 from public.admins a
          where a.user_id = auth.uid()
        )
      )
      with check (
        exists (
          select 1 from public.admins a
          where a.user_id = auth.uid()
        )
      );
  end if;
end $$;

grant select on table public.custom_product_banner_items to anon, authenticated;

select pg_notify('pgrst', 'reload schema');
