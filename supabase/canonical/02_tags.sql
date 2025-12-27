-- 02_tags.sql — Tags y relación producto‑tag + RLS (idempotente)

-- Crear tabla tags si no existe
create table if not exists public.tags (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  created_at timestamptz default now()
);

-- Migración: agregar columnas nuevas si no existen
do $$
begin
  -- Agregar level si no existe
  if not exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' 
    and table_name = 'tags' 
    and column_name = 'level'
  ) then
    alter table public.tags add column level integer;
    -- Establecer un valor por defecto para tags existentes (serán obsoletos)
    update public.tags set level = 1 where level is null;
    alter table public.tags alter column level set not null;
    alter table public.tags add constraint tags_level_check check (level in (1, 2, 3));
  end if;

  -- Agregar parent_id si no existe
  if not exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' 
    and table_name = 'tags' 
    and column_name = 'parent_id'
  ) then
    alter table public.tags add column parent_id uuid references public.tags(id) on delete cascade;
  end if;

  -- Agregar category si no existe
  if not exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' 
    and table_name = 'tags' 
    and column_name = 'category'
  ) then
    alter table public.tags add column category text;
    -- Establecer un valor por defecto para tags existentes
    update public.tags set category = 'Calzado' where category is null;
    alter table public.tags alter column category set not null;
    alter table public.tags add constraint tags_category_check check (category in ('Calzado', 'Ropa', 'Otros'));
  end if;

  -- Eliminar constraint unique antiguo si existe y crear el nuevo
  if exists (
    select 1 from pg_constraint 
    where conname = 'tags_name_key' 
    and conrelid = 'public.tags'::regclass
  ) then
    alter table public.tags drop constraint if exists tags_name_key;
  end if;

  -- Crear constraint unique nuevo si no existe
  if not exists (
    select 1 from pg_constraint 
    where conname = 'tags_name_category_level_parent_id_key' 
    and conrelid = 'public.tags'::regclass
  ) then
    alter table public.tags add constraint tags_name_category_level_parent_id_key 
      unique (name, category, level, parent_id);
  end if;
end $$;

-- Crear o modificar tabla product_tags
create table if not exists public.product_tags (
  product_id uuid not null references public.products(id) on delete cascade,
  tag_id uuid references public.tags(id) on delete cascade,
  primary key (product_id, tag_id)
);

-- Migración: convertir product_tags a nueva estructura
do $$
begin
  -- Agregar nuevas columnas si no existen
  if not exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' 
    and table_name = 'product_tags' 
    and column_name = 'tag1_id'
  ) then
    alter table public.product_tags add column tag1_id uuid references public.tags(id) on delete set null;
  end if;

  if not exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' 
    and table_name = 'product_tags' 
    and column_name = 'tag2_id'
  ) then
    alter table public.product_tags add column tag2_id uuid references public.tags(id) on delete set null;
  end if;

  if not exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' 
    and table_name = 'product_tags' 
    and column_name = 'tag3_ids'
  ) then
    alter table public.product_tags add column tag3_ids uuid[] default '{}';
  end if;

  -- PRIMERO: Eliminar primary key antigua si existe (debe hacerse antes de hacer nullable)
  -- Simplificar: eliminar cualquier primary key existente y recrearla después
  if exists (
    select 1 from pg_constraint c
    where c.conname = 'product_tags_pkey' 
    and c.conrelid = 'public.product_tags'::regclass
  ) then
    -- Eliminar foreign key de tag_id si existe (puede depender de la primary key)
    alter table public.product_tags drop constraint if exists product_tags_tag_id_fkey;
    -- Eliminar primary key antigua
    alter table public.product_tags drop constraint if exists product_tags_pkey;
  end if;

  -- SEGUNDO: Hacer tag_id nullable si existe (ahora que no es parte de primary key)
  if exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' 
    and table_name = 'product_tags' 
    and column_name = 'tag_id'
    and is_nullable = 'NO'
  ) then
    alter table public.product_tags alter column tag_id drop not null;
  end if;

  -- TERCERO: Consolidar registros duplicados antes de cambiar primary key
  -- Verificar si hay columnas nuevas (estructura nueva) o solo tag_id (estructura antigua)
  if exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' 
    and table_name = 'product_tags' 
    and column_name = 'tag_id'
  ) and not exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' 
    and table_name = 'product_tags' 
    and column_name = 'tag1_id'
  ) then
    -- Estructura antigua: eliminar duplicados manteniendo solo un registro por product_id
    -- Los tags antiguos quedarán obsoletos, así que simplemente eliminamos duplicados
    delete from public.product_tags pt1
    where exists (
      select 1 from public.product_tags pt2
      where pt2.product_id = pt1.product_id
      and pt2.ctid < pt1.ctid
    );
  elsif exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' 
    and table_name = 'product_tags' 
    and column_name = 'tag1_id'
  ) then
    -- Estructura nueva: consolidar si hay duplicados
    if exists (
      select 1 from public.product_tags
      group by product_id
      having count(*) > 1
    ) then
      -- Crear tabla temporal con un registro por product_id
      create temp table if not exists product_tags_consolidated as
      select distinct on (product_id)
        product_id,
        tag1_id,
        tag2_id,
        tag3_ids
      from public.product_tags
      order by product_id, 
        case when tag1_id is not null then 1 else 2 end,
        case when tag2_id is not null then 1 else 2 end,
        case when tag3_ids is not null and array_length(tag3_ids, 1) > 0 then 1 else 2 end;
      
      -- Eliminar todos los registros
      delete from public.product_tags;
      
      -- Insertar registros consolidados (tag_id será NULL, que ahora está permitido)
      insert into public.product_tags (product_id, tag1_id, tag2_id, tag3_ids)
      select product_id, tag1_id, tag2_id, tag3_ids
      from product_tags_consolidated;
      
      -- Limpiar tabla temporal
      drop table if exists product_tags_consolidated;
    end if;
  end if;

  -- CUARTO: Crear nueva primary key solo con product_id (si no existe)
  if not exists (
    select 1 from pg_constraint 
    where conname = 'product_tags_pkey' 
    and conrelid = 'public.product_tags'::regclass
  ) then
    -- Verificar que no haya duplicados antes de crear la primary key
    if not exists (
      select 1 from public.product_tags
      group by product_id
      having count(*) > 1
    ) then
      alter table public.product_tags add constraint product_tags_pkey primary key (product_id);
    end if;
  end if;

  -- Eliminar columna tag_id si existe y ya no se necesita (después de migración)
  -- PRIMERO eliminar la vista que depende de ella
  if exists (
    select 1 from information_schema.views 
    where table_schema = 'public' 
    and table_name = 'catalog_public_view'
  ) then
    drop view if exists public.catalog_public_view;
  end if;

  -- Ahora eliminar la columna tag_id
  if exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' 
    and table_name = 'product_tags' 
    and column_name = 'tag_id'
  ) and exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' 
    and table_name = 'product_tags' 
    and column_name = 'tag1_id'
  ) then
    -- Eliminar foreign key si existe
    alter table public.product_tags drop constraint if exists product_tags_tag_id_fkey;
    -- Eliminar columna tag_id (la vista ya fue eliminada)
    alter table public.product_tags drop column if exists tag_id;
  end if;

  -- NOTA: No podemos usar subconsultas en CHECK constraints en PostgreSQL
  -- La validación de que tag2 sea hijo de tag1 se hará en la aplicación
  -- Solo agregamos el constraint simple de límite de tag3

  if not exists (
    select 1 from pg_constraint 
    where conname = 'tag3_max_2'
    and conrelid = 'public.product_tags'::regclass
  ) then
    alter table public.product_tags add constraint tag3_max_2 check (
      array_length(tag3_ids, 1) is null or array_length(tag3_ids, 1) <= 2
    );
  end if;
end $$;

alter table public.tags enable row level security;
alter table public.product_tags enable row level security;

-- Lectura pública opcional de tags (compatibilidad con IF NOT EXISTS)
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='tags' and policyname='anon_select_tags'
  ) then
    create policy anon_select_tags on public.tags for select to anon using (true);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='tags' and policyname='authenticated_select_tags'
  ) then
    create policy authenticated_select_tags on public.tags for select to authenticated using (true);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='product_tags' and policyname='authenticated_select_product_tags'
  ) then
    create policy authenticated_select_product_tags on public.product_tags for select to authenticated using (true);
  end if;
end $$;

-- Escritura solo admins (basado en public.admins)
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

-- Índices para búsquedas eficientes
create index if not exists idx_tags_category_level on public.tags(category, level);
create index if not exists idx_tags_parent_id on public.tags(parent_id);
create index if not exists idx_tags_category_level_parent on public.tags(category, level, parent_id);

-- Semillas útiles (ejemplos de tags1 por categoría)
insert into public.tags(name, level, category, parent_id) values 
  ('Sandalia', 1, 'Calzado', null),
  ('Bota', 1, 'Calzado', null),
  ('Zapatilla', 1, 'Calzado', null),
  ('Remera', 1, 'Ropa', null),
  ('Pantalón', 1, 'Ropa', null),
  ('Camisa', 1, 'Ropa', null),
  ('Lenceria', 1, 'Otros', null),
  ('Marroquineria', 1, 'Otros', null)
on conflict (name, category, level, parent_id) do nothing;

select pg_notify('pgrst','reload schema');
