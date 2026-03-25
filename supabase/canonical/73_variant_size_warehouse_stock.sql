-- 73_variant_size_warehouse_stock.sql — Tabla para almacenar stock por talle y warehouse

-- Tabla para almacenar stock por talle y warehouse
create table if not exists public.variant_size_warehouse_stock (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references public.product_variants(id) on delete cascade,
  size text not null,
  warehouse_id uuid not null references public.warehouses(id) on delete cascade,
  stock_qty int not null default 0 check (stock_qty >= 0),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(variant_id, size, warehouse_id)
);

-- Índices
create index if not exists ix_variant_size_warehouse_stock_variant on public.variant_size_warehouse_stock(variant_id);
create index if not exists ix_variant_size_warehouse_stock_size on public.variant_size_warehouse_stock(size);
create index if not exists ix_variant_size_warehouse_stock_warehouse on public.variant_size_warehouse_stock(warehouse_id);
create index if not exists ix_variant_size_warehouse_stock_variant_size on public.variant_size_warehouse_stock(variant_id, size);

-- Trigger updated_at
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'variant_size_warehouse_stock_set_updated_at') then
    create trigger variant_size_warehouse_stock_set_updated_at
      before update on public.variant_size_warehouse_stock
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- RLS
alter table public.variant_size_warehouse_stock enable row level security;

-- Policies

-- Lectura anónima (todas visibles)
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='variant_size_warehouse_stock' and policyname='anon_select_variant_size_warehouse_stock'
  ) then
    create policy anon_select_variant_size_warehouse_stock on public.variant_size_warehouse_stock
      for select to anon using (true);
  end if;
end $$;

-- Lectura authenticated
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='variant_size_warehouse_stock' and policyname='auth_select_variant_size_warehouse_stock'
  ) then
    create policy auth_select_variant_size_warehouse_stock on public.variant_size_warehouse_stock
      for select to authenticated using (true);
  end if;
end $$;

-- Admin puede hacer todo
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='variant_size_warehouse_stock' and policyname='admin_manage_variant_size_warehouse_stock'
  ) then
    create policy admin_manage_variant_size_warehouse_stock on public.variant_size_warehouse_stock
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

