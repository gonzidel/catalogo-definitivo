-- 262_product_facets_season_audience_dimensions.sql
-- Objetivo: agregar campos del panel de productos nuevo sin tocar productos existentes.
-- Todo nullable/opcional: ningun producto viejo se ve afectado.

-- 1) Temporada y publico objetivo (facetas planas, no jerarquicas -> no van en tags)
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='products' and column_name='season'
  ) then
    alter table public.products add column season text;
    alter table public.products add constraint products_season_check
      check (season is null or season in ('verano','invierno','todo_anio'));
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='products' and column_name='target_audience'
  ) then
    alter table public.products add column target_audience text;
    alter table public.products add constraint products_target_audience_check
      check (target_audience is null or target_audience in ('mujer','hombre','ninos','unisex'));
  end if;
end $$;

-- 2) Peso y medidas (a nivel producto, opcional, sin uso en calculos todavia)
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='products' and column_name='width_cm'
  ) then
    alter table public.products add column width_cm numeric check (width_cm is null or width_cm > 0);
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='products' and column_name='height_cm'
  ) then
    alter table public.products add column height_cm numeric check (height_cm is null or height_cm > 0);
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='products' and column_name='length_cm'
  ) then
    alter table public.products add column length_cm numeric check (length_cm is null or length_cm > 0);
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='products' and column_name='weight_kg'
  ) then
    alter table public.products add column weight_kg numeric check (weight_kg is null or weight_kg > 0);
  end if;
end $$;

-- 3) Marca de costo estimado (inversa de precio) en product_variants
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='product_variants' and column_name='cost_is_estimated'
  ) then
    alter table public.product_variants add column cost_is_estimated boolean not null default false;
  end if;
end $$;

-- 4) pg_trgm: soporte para chequeo de similitud al crear tags nuevos (sin aprobacion humana,
--    el algoritmo de similitud es el unico control - ver seccion "Crear tags nuevos" del plan)
create extension if not exists pg_trgm;

create index if not exists idx_tags_name_trgm
  on public.tags using gin (name gin_trgm_ops);

select pg_notify('pgrst','reload schema');
