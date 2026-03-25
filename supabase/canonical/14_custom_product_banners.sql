-- 14_custom_product_banners.sql — Banner de productos personalizable (idempotente)

-- Crear tabla custom_product_banners si no existe
create table if not exists public.custom_product_banners (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  tag_filter text, -- Deprecado: ya no se usa, se busca en todos los filtros
  tag_value text not null, -- Valor del tag (ej: "colegiales") - se busca en Filtro1, Filtro2 y Filtro3
  enabled boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Eliminar la restricción check antigua si existe
do $$
begin
  if exists (
    select 1 from pg_constraint 
    where conname = 'custom_product_banners_tag_filter_check'
  ) then
    alter table public.custom_product_banners 
    drop constraint if exists custom_product_banners_tag_filter_check;
  end if;
end $$;

-- Índice para búsqueda rápida de banners habilitados
create index if not exists idx_custom_product_banners_enabled 
on public.custom_product_banners(enabled) 
where enabled = true;

alter table public.custom_product_banners enable row level security;

-- Políticas RLS: lectura pública (todos pueden ver banners habilitados)
do $$
begin
  if not exists (
    select 1 from pg_policies 
    where schemaname='public' 
    and tablename='custom_product_banners' 
    and policyname='anon_select_custom_product_banners'
  ) then
    create policy anon_select_custom_product_banners on public.custom_product_banners
      for select to anon
      using (enabled = true);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies 
    where schemaname='public' 
    and tablename='custom_product_banners' 
    and policyname='authenticated_select_custom_product_banners'
  ) then
    create policy authenticated_select_custom_product_banners on public.custom_product_banners
      for select to authenticated
      using (true); -- Autenticados pueden ver todas (para admin preview)
  end if;
end $$;

-- Políticas RLS: escritura solo para admins
do $$
begin
  if not exists (
    select 1 from pg_policies 
    where schemaname='public' 
    and tablename='custom_product_banners' 
    and policyname='admin_write_custom_product_banners'
  ) then
    create policy admin_write_custom_product_banners on public.custom_product_banners
      for all to authenticated
      using (exists (select 1 from public.admins a where a.user_id = auth.uid()))
      with check (exists (select 1 from public.admins a where a.user_id = auth.uid()));
  end if;
end $$;

-- Trigger para actualizar updated_at automáticamente
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'custom_product_banners_set_updated_at') then
    create trigger custom_product_banners_set_updated_at
      before update on public.custom_product_banners
      for each row
      execute function public.set_updated_at();
  end if;
end $$;
