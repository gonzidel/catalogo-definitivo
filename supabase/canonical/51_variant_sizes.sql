-- 51_variant_sizes.sql — Tabla para almacenar talles y stock por variante

-- Tabla para almacenar talles y stock por variante
create table if not exists public.variant_sizes (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references public.product_variants(id) on delete cascade,
  size text not null,
  stock_qty int not null default 0 check (stock_qty >= 0),
  sku text, -- SKU completo: {sku_base}-{size}
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(variant_id, size)
);

-- Índices
create index if not exists ix_variant_sizes_variant on public.variant_sizes(variant_id);
create index if not exists ix_variant_sizes_sku on public.variant_sizes(sku);

-- Trigger updated_at
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'variant_sizes_set_updated_at') then
    create trigger variant_sizes_set_updated_at
      before update on public.variant_sizes
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- RLS
alter table public.variant_sizes enable row level security;

-- Policies (mismo patrón que variant_images)

-- Lectura anónima (todas visibles)
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='variant_sizes' and policyname='anon_select_variant_sizes'
  ) then
    create policy anon_select_variant_sizes on public.variant_sizes
      for select to anon using (true);
  end if;
end $$;

-- Lectura authenticated
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='variant_sizes' and policyname='auth_select_variant_sizes'
  ) then
    create policy auth_select_variant_sizes on public.variant_sizes
      for select to authenticated using (true);
  end if;
end $$;

-- Admin puede hacer todo (verificar en tabla admins, mismo patrón que variant_warehouse_stock)
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='variant_sizes' and policyname='admin_manage_variant_sizes'
  ) then
    create policy admin_manage_variant_sizes on public.variant_sizes
      for all to authenticated
      using (
        exists (
          select 1 from public.admins 
          where user_id = auth.uid()
        )
      )
      with check (
        exists (
          select 1 from public.admins 
          where user_id = auth.uid()
        )
      );
  end if;
end $$;

select pg_notify('pgrst','reload schema');

