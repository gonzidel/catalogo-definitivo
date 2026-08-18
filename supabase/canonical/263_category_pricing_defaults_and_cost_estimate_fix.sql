-- 263_category_pricing_defaults_and_cost_estimate_fix.sql
-- Objetivo:
-- 1) cost_is_estimated quedo mal puesta en 262 (product_variants no tiene cost;
--    el costo vive en products). Se mueve a products, se elimina la columna vieja.
-- 2) category_pricing_defaults: saca el porcentaje/monto logistico por categoria
--    de localStorage (por navegador) a una configuracion real compartida en DB.

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='product_variants' and column_name='cost_is_estimated'
  ) then
    alter table public.product_variants drop column cost_is_estimated;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='products' and column_name='cost_is_estimated'
  ) then
    alter table public.products add column cost_is_estimated boolean not null default false;
  end if;
end $$;

create table if not exists public.category_pricing_defaults (
  category text primary key check (category in ('Calzado','Ropa','Otros')),
  percentage numeric not null check (percentage >= 0 and percentage <= 100),
  logistic_amount numeric not null default 0 check (logistic_amount >= 0),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

insert into public.category_pricing_defaults (category, percentage, logistic_amount) values
  ('Calzado', 30, 500),
  ('Ropa', 35, 500),
  ('Otros', 30, 500)
on conflict (category) do nothing;

alter table public.category_pricing_defaults enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='category_pricing_defaults' and policyname='authenticated_select_pricing_defaults'
  ) then
    create policy authenticated_select_pricing_defaults on public.category_pricing_defaults
      for select to authenticated using (true);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='category_pricing_defaults' and policyname='super_admin_write_pricing_defaults'
  ) then
    create policy super_admin_write_pricing_defaults on public.category_pricing_defaults
      for all to authenticated
      using (exists (select 1 from public.admins a where a.user_id = auth.uid() and a.role = 'super_admin'))
      with check (exists (select 1 from public.admins a where a.user_id = auth.uid() and a.role = 'super_admin'));
  end if;
end $$;

select pg_notify('pgrst','reload schema');
