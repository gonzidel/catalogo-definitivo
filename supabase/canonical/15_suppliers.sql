-- 15_suppliers.sql — Tabla de proveedores + RLS (idempotente)

-- 1) Tabla de proveedores
create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  name text not null,
  description text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- 2) Trigger updated_at
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'suppliers_set_updated_at') then
    create trigger suppliers_set_updated_at
      before update on public.suppliers
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- 3) Índices
create index if not exists ix_suppliers_code on public.suppliers(code);
create index if not exists ix_suppliers_name on public.suppliers(name);

-- 4) RLS Policies
alter table public.suppliers enable row level security;

-- Lectura pública para proveedores (para que aparezcan en selects)
do $$
begin
  if not exists (
    select 1 from pg_policies 
    where schemaname='public' and tablename='suppliers' and policyname='anon_select_suppliers'
  ) then
    create policy anon_select_suppliers on public.suppliers
      for select to anon using (true);
  end if;
  
  if not exists (
    select 1 from pg_policies 
    where schemaname='public' and tablename='suppliers' and policyname='auth_select_suppliers'
  ) then
    create policy auth_select_suppliers on public.suppliers
      for select to authenticated using (true);
  end if;
end $$;

-- Escritura solo para admins autenticados
do $$
begin
  if not exists (
    select 1 from pg_policies 
    where schemaname='public' and tablename='suppliers' and policyname='admin_manage_suppliers'
  ) then
    create policy admin_manage_suppliers on public.suppliers
      for all to authenticated
      using (
        exists (select 1 from public.admins a where a.user_id = auth.uid())
      )
      with check (
        exists (select 1 from public.admins a where a.user_id = auth.uid())
      );
  end if;
end $$;

select pg_notify('pgrst','reload schema');



























