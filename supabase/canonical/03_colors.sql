-- 03_colors.sql — Catálogo de colores (opcional) + RLS (idempotente)

create table if not exists public.colors (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  code text unique,
  hex_color text,
  created_at timestamptz default now()
);

-- Agregar columna hex_color si no existe
alter table public.colors add column if not exists hex_color text;

-- Agregar columna display_number si no existe (número del 1 al 9 para mostrar en círculos de color)
alter table public.colors add column if not exists display_number integer;

-- Agregar constraint para validar que display_number esté entre 1 y 9 si se proporciona
do $$
begin
  if not exists (
    select 1 from pg_constraint 
    where conname = 'colors_display_number_check' 
    and conrelid = 'public.colors'::regclass
  ) then
    alter table public.colors 
    add constraint colors_display_number_check 
    check (display_number is null or (display_number >= 1 and display_number <= 9));
  end if;
end $$;

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
insert into public.colors(name, code, hex_color) values
('Negro','NEG','#000000'),
('Suela','SUE','#8B4513'),
('Beige','BEI','#F5F5DC'),
('Plata','PLA','#C0C0C0'),
('Blanco','BLA','#FFFFFF')
on conflict (name) do update set hex_color = excluded.hex_color where colors.hex_color is null;

select pg_notify('pgrst','reload schema');
