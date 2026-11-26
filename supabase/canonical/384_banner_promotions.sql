-- 384_banner_promotions.sql
-- Promociones visuales del banner de Ofertas.
-- No son 2x1 ni 2xMonto: no cambian el precio ni entran en promotions.
-- end_date NULL = permanente.

create table if not exists public.banner_promotions (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  image_url text,
  status text not null default 'active',
  end_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint banner_promotions_title_check
    check (char_length(btrim(title)) between 1 and 80),
  constraint banner_promotions_status_check
    check (status in ('active', 'inactive'))
);

create table if not exists public.banner_promotion_items (
  id uuid primary key default gen_random_uuid(),
  banner_promotion_id uuid not null
    references public.banner_promotions(id) on delete cascade,
  product_id uuid references public.products(id) on delete cascade,
  variant_id uuid references public.product_variants(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint banner_promotion_items_target_check check (
    (product_id is not null and variant_id is null)
    or (product_id is null and variant_id is not null)
  )
);

create index if not exists banner_promotion_items_promotion_idx
  on public.banner_promotion_items (banner_promotion_id);

comment on table public.banner_promotions is
  'Promoción visual del banner de Ofertas. No modifica precios. end_date null = permanente.';

alter table public.banner_promotions enable row level security;
alter table public.banner_promotion_items enable row level security;

revoke all on table public.banner_promotions from public, anon, authenticated;
revoke all on table public.banner_promotion_items from public, anon, authenticated;

grant select on table public.banner_promotions to anon, authenticated;
grant insert, update, delete on table public.banner_promotions to authenticated;
grant select, insert, update, delete on table public.banner_promotions to service_role;

grant select on table public.banner_promotion_items to anon, authenticated;
grant insert, update, delete on table public.banner_promotion_items to authenticated;
grant select, insert, update, delete on table public.banner_promotion_items to service_role;

drop policy if exists banner_promotions_public_select on public.banner_promotions;
create policy banner_promotions_public_select
  on public.banner_promotions
  for select
  to anon, authenticated
  using (
    status = 'active'
    and (end_date is null or end_date >= current_date)
  );

drop policy if exists banner_promotions_admin_all on public.banner_promotions;
create policy banner_promotions_admin_all
  on public.banner_promotions
  for all
  to authenticated
  using (exists (select 1 from public.admins a where a.user_id = auth.uid()))
  with check (exists (select 1 from public.admins a where a.user_id = auth.uid()));

drop policy if exists banner_promotion_items_public_select on public.banner_promotion_items;
create policy banner_promotion_items_public_select
  on public.banner_promotion_items
  for select
  to anon, authenticated
  using (
    exists (
      select 1 from public.banner_promotions p
      where p.id = banner_promotion_items.banner_promotion_id
        and p.status = 'active'
        and (p.end_date is null or p.end_date >= current_date)
    )
  );

drop policy if exists banner_promotion_items_admin_all on public.banner_promotion_items;
create policy banner_promotion_items_admin_all
  on public.banner_promotion_items
  for all
  to authenticated
  using (exists (select 1 from public.admins a where a.user_id = auth.uid()))
  with check (exists (select 1 from public.admins a where a.user_id = auth.uid()));

select pg_notify('pgrst', 'reload schema');
