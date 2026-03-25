-- 121_quick_actions.sql — Acciones rápidas configurables + RLS (idempotente)

-- Crear tabla quick_actions si no existe
create table if not exists public.quick_actions (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('category', 'tag', 'offer', 'provider')),
  label text not null,
  value text not null, -- Valor a filtrar (ej: nombre de categoría, tag name, etc.)
  icon text, -- Icono emoji o nombre
  "order" integer not null default 0,
  enabled boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Índice para ordenamiento rápido
create index if not exists idx_quick_actions_order_enabled 
on public.quick_actions(enabled, "order") 
where enabled = true;

alter table public.quick_actions enable row level security;

-- Políticas RLS: lectura pública (todos pueden ver acciones rápidas habilitadas)
do $$
begin
  if not exists (
    select 1 from pg_policies 
    where schemaname='public' 
    and tablename='quick_actions' 
    and policyname='anon_select_quick_actions'
  ) then
    create policy anon_select_quick_actions on public.quick_actions
      for select to anon
      using (enabled = true);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies 
    where schemaname='public' 
    and tablename='quick_actions' 
    and policyname='authenticated_select_quick_actions'
  ) then
    create policy authenticated_select_quick_actions on public.quick_actions
      for select to authenticated
      using (true); -- Autenticados pueden ver todas (para admin preview)
  end if;
end $$;

-- Escritura: solo admins
do $$ 
begin
  if not exists (
    select 1 from pg_policies 
    where schemaname='public' 
    and tablename='quick_actions' 
    and policyname='admin_write_quick_actions'
  ) then
    create policy admin_write_quick_actions on public.quick_actions
      for all to authenticated
      using (exists (select 1 from public.admins a where a.user_id = auth.uid()))
      with check (exists (select 1 from public.admins a where a.user_id = auth.uid()));
  end if;
end $$;

-- Trigger para updated_at
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'quick_actions_set_updated_at') then
    create trigger quick_actions_set_updated_at
      before update on public.quick_actions
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- Datos iniciales: Inicio siempre está (managed by app, pero agregamos ejemplo)
-- Insertar acciones por defecto solo si la tabla está vacía
insert into public.quick_actions (type, label, value, icon, "order", enabled)
select * from (values
  ('category', 'Calzado', 'Calzado', '👟', 1, true),
  ('category', 'Ropa', 'Ropa', '👕', 2, true),
  ('category', 'Lencería', 'Lenceria', '👙', 3, true),
  ('category', 'Accesorios', 'Marroquineria', '👜', 4, true),
  ('offer', 'Ofertas', 'Ofertas', '🔥', 5, true),
  ('category', 'Novedades', 'Novedades', '⭐', 6, true)
) as v(type, label, value, icon, "order", enabled)
where not exists (select 1 from public.quick_actions limit 1);

-- Tabla para banners promocionales
create table if not exists public.promotional_banners (
  id uuid primary key default gen_random_uuid(),
  text text not null,
  link text, -- URL o acción (ej: "Novedades", "Ofertas", o URL completa)
  link_type text default 'category' check (link_type in ('category', 'tag', 'url')),
  enabled boolean not null default true,
  "order" integer not null default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Índice para banners habilitados
create index if not exists idx_promotional_banners_enabled 
on public.promotional_banners(enabled, "order") 
where enabled = true;

alter table public.promotional_banners enable row level security;

-- Políticas RLS: lectura pública
do $$
begin
  if not exists (
    select 1 from pg_policies 
    where schemaname='public' 
    and tablename='promotional_banners' 
    and policyname='anon_select_promotional_banners'
  ) then
    create policy anon_select_promotional_banners on public.promotional_banners
      for select to anon
      using (enabled = true);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies 
    where schemaname='public' 
    and tablename='promotional_banners' 
    and policyname='authenticated_select_promotional_banners'
  ) then
    create policy authenticated_select_promotional_banners on public.promotional_banners
      for select to authenticated
      using (true);
  end if;
end $$;

-- Escritura: solo admins
do $$ 
begin
  if not exists (
    select 1 from pg_policies 
    where schemaname='public' 
    and tablename='promotional_banners' 
    and policyname='admin_write_promotional_banners'
  ) then
    create policy admin_write_promotional_banners on public.promotional_banners
      for all to authenticated
      using (exists (select 1 from public.admins a where a.user_id = auth.uid()))
      with check (exists (select 1 from public.admins a where a.user_id = auth.uid()));
  end if;
end $$;

-- Trigger para updated_at
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'promotional_banners_set_updated_at') then
    create trigger promotional_banners_set_updated_at
      before update on public.promotional_banners
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- Banner por defecto
insert into public.promotional_banners (text, link, link_type, "order", enabled)
select * from (values
  ('Nuevos ingresos de la semana', 'Novedades', 'category', 0, true)
) as v(text, link, link_type, "order", enabled)
where not exists (select 1 from public.promotional_banners limit 1);

select pg_notify('pgrst','reload schema');