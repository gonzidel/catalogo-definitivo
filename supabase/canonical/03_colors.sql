-- 03_colors.sql — Catálogo de colores (opcional) + RLS (idempotente)

create table if not exists public.colors (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  code text unique,
  created_at timestamptz default now()
);

alter table public.colors enable row level security;

-- Lectura pública (opcional) y authenticated (compatibilidad IF NOT EXISTS)
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='colors' and policyname='anon_select_colors'
  ) then
    create policy anon_select_colors on public.colors for select to anon using (true);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='colors' and policyname='authenticated_select_colors'
  ) then
    create policy authenticated_select_colors on public.colors for select to authenticated using (true);
  end if;
end $$;

-- Escritura: solo admins
do $$ begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='colors' and policyname='admin_write_colors'
  ) then
    create policy admin_write_colors on public.colors
      for all to authenticated
      using (exists (select 1 from public.admins a where a.user_id = auth.uid()))
      with check (exists (select 1 from public.admins a where a.user_id = auth.uid()));
  end if;
end $$;

-- Semillas comunes (opcional)
insert into public.colors(name, code) values
('Negro','NEG'),('Suela','SUE'),('Beige','BEI'),('Plata','PLA'),('Blanco','BLA')
on conflict (name) do nothing;

select pg_notify('pgrst','reload schema');
