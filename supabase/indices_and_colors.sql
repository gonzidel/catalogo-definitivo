-- Unicidad en productos y variantes + catálogo de colores

-- 1) Unicidad de handle en productos
create unique index if not exists ux_products_handle on public.products(handle);

-- 2) Unicidad de SKU en variantes
create unique index if not exists ux_variants_sku on public.product_variants(sku);

-- 3) Evitar duplicados del mismo color+talle dentro del mismo producto
create unique index if not exists ux_variants_product_color_size
  on public.product_variants(product_id, color, size);

-- 4) Catálogo de colores (opcional, pero recomendado)
create table if not exists public.colors (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  code text unique,
  created_at timestamptz default now()
);

-- Semillas básicas (ignorar errores si ya existen)
insert into public.colors(name, code)
  values ('Negro','NEG'),('Suela','SUE'),('Beige','BEI'),('Plata','PLA'),('Blanco','BLA')
on conflict (name) do nothing;

-- Políticas RLS (lectura pública opcional, escritura sólo admin autenticado)
alter table public.colors enable row level security;
do $$ begin
  perform 1 from pg_policies where schemaname='public' and tablename='colors' and policyname='anon_select_colors';
  if not found then
    create policy anon_select_colors on public.colors for select to anon using (true);
  end if;
end $$;

-- Reemplaza el email por el tuyo o usa roles en app_metadata
do $$ begin
  perform 1 from pg_policies where schemaname='public' and tablename='colors' and policyname='authenticated_manage_colors';
  if not found then
    create policy authenticated_manage_colors on public.colors
      for all to authenticated
      using (auth.jwt() ->> 'email' in ('tu-mail@fylmoda.com.ar'))
      with check (auth.jwt() ->> 'email' in ('tu-mail@fylmoda.com.ar'));
  end if;
end $$;

