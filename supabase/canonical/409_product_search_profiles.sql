-- 409_product_search_profiles.sql
-- Perfiles de búsqueda generados por IA (borrador → revisión humana → approved).
-- No toca products.description ni tags. No cambia catalog_public_snapshot shape.
--
-- Grants explícitos (Data API post-2026-10-30): mínimo privilegio.
-- Rollback: 409_ROLLBACK_product_search_profiles.sql

create table if not exists public.product_search_profiles (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  articulo text not null,
  status text not null default 'draft'
    check (status in ('draft', 'approved', 'rejected', 'stale')),
  search_terms text[] not null default '{}',
  style_terms text[] not null default '{}',
  occasion_terms text[] not null default '{}',
  color_families text[] not null default '{}',
  audience text null
    check (audience is null or audience in ('mujer', 'hombre', 'ninos', 'unisex')),
  season text null
    check (season is null or season in ('verano', 'invierno', 'todo_anio')),
  source_hash text not null default '',
  provider text null,
  model text null,
  prompt_version text null,
  confidence numeric null,
  cost_usd numeric null,
  generated_at timestamptz null,
  reviewed_by uuid null,
  reviewed_at timestamptz null,
  review_note text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id)
);

create index if not exists product_search_profiles_status_idx
  on public.product_search_profiles (status);

create index if not exists product_search_profiles_articulo_idx
  on public.product_search_profiles (articulo);

comment on table public.product_search_profiles is
  'Perfil interno de búsqueda por artículo. Solo status=approved es legible por anon (columnas públicas).';

alter table public.product_search_profiles enable row level security;

-- Lectura pública: solo approved + columnas no sensibles
drop policy if exists product_search_profiles_anon_select_approved on public.product_search_profiles;
create policy product_search_profiles_anon_select_approved
  on public.product_search_profiles
  for select
  to anon, authenticated
  using (status = 'approved');

-- Admin full via is_admin()
drop policy if exists product_search_profiles_admin_all on public.product_search_profiles;
create policy product_search_profiles_admin_all
  on public.product_search_profiles
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Grants mínimos (mismas columnas públicas para anon)
revoke all on table public.product_search_profiles from public;
revoke all on table public.product_search_profiles from anon;
revoke all on table public.product_search_profiles from authenticated;

grant select (
  articulo,
  search_terms,
  style_terms,
  occasion_terms,
  color_families,
  audience,
  season
) on table public.product_search_profiles to anon;

grant select (
  articulo,
  search_terms,
  style_terms,
  occasion_terms,
  color_families,
  audience,
  season
) on table public.product_search_profiles to authenticated;

-- Admins (authenticated + is_admin RLS) necesitan CRUD completo
grant select, insert, update, delete on table public.product_search_profiles to authenticated;

-- Vista conveniente para el cliente (solo approved)
create or replace view public.product_search_profiles_public
with (security_invoker = true)
as
select
  articulo,
  search_terms,
  style_terms,
  occasion_terms,
  color_families,
  audience,
  season
from public.product_search_profiles
where status = 'approved';

grant select on public.product_search_profiles_public to anon;
grant select on public.product_search_profiles_public to authenticated;

-- updated_at
create or replace function public.tg_product_search_profiles_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists product_search_profiles_updated_at on public.product_search_profiles;
create trigger product_search_profiles_updated_at
  before update on public.product_search_profiles
  for each row execute function public.tg_product_search_profiles_updated_at();

select pg_notify('pgrst', 'reload schema');
