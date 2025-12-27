-- Tablas y políticas para Tags

create table if not exists public.tags (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  created_at timestamptz default now()
);

create table if not exists public.product_tags (
  product_id uuid not null references public.products(id) on delete cascade,
  tag_id uuid not null references public.tags(id) on delete cascade,
  primary key (product_id, tag_id)
);

alter table public.tags enable row level security;
alter table public.product_tags enable row level security;

-- Lectura (pública opcional y/o autenticada)
create policy if not exists anon_select_tags on public.tags for select to anon using (true);
create policy if not exists authenticated_select_tags on public.tags for select to authenticated using (true);
create policy if not exists authenticated_select_product_tags on public.product_tags for select to authenticated using (true);

-- Escritura sólo admins (basado en public.admins)
do $$ begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='tags' and policyname='admin_write_tags'
  ) then
    create policy admin_write_tags on public.tags
      for all to authenticated
      using (exists (select 1 from public.admins a where a.user_id = auth.uid()))
      with check (exists (select 1 from public.admins a where a.user_id = auth.uid()));
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='product_tags' and policyname='admin_write_product_tags'
  ) then
    create policy admin_write_product_tags on public.product_tags
      for all to authenticated
      using (exists (select 1 from public.admins a where a.user_id = auth.uid()))
      with check (exists (select 1 from public.admins a where a.user_id = auth.uid()));
  end if;
end $$;

-- Semillas opcionales
insert into public.tags(name) values ('Sandalia'),('Bota'),('Verano'),('Oferta')
on conflict (name) do nothing;

-- Recargar esquema
select pg_notify('pgrst','reload schema');

