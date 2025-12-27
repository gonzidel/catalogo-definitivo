-- 06_public_read_policies.sql — Lectura pública de catálogo (anon) y authenticated

alter table public.products enable row level security;
alter table public.product_variants enable row level security;
alter table public.variant_images enable row level security;

-- Products (solo activos)
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='products' and policyname='anon_select_products'
  ) then
    create policy anon_select_products on public.products
      for select to anon using (status = 'active');
  end if;
end $$;

-- Variants (solo activas)
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='product_variants' and policyname='anon_select_variants'
  ) then
    create policy anon_select_variants on public.product_variants
      for select to anon using (active is true);
  end if;
end $$;

-- Imagenes (todas visibles)
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='variant_images' and policyname='anon_select_variant_images'
  ) then
    create policy anon_select_variant_images on public.variant_images
      for select to anon using (true);
  end if;
end $$;

-- Lectura para authenticated (idéntico a anon en este caso)
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='products' and policyname='auth_select_products'
  ) then
    create policy auth_select_products on public.products
      for select to authenticated using (status = 'active');
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='product_variants' and policyname='auth_select_variants'
  ) then
    create policy auth_select_variants on public.product_variants
      for select to authenticated using (active is true);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='variant_images' and policyname='auth_select_variant_images'
  ) then
    create policy auth_select_variant_images on public.variant_images
      for select to authenticated using (true);
  end if;
end $$;

select pg_notify('pgrst','reload schema');

