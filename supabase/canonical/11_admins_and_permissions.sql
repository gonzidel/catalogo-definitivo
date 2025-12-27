-- 11_admins_and_permissions.sql — Sistema de administradores y permisos granulares (idempotente)

-- Tabla de administradores
-- Manejar creación o migración de la tabla
do $$
declare
  table_exists boolean;
  has_id_column boolean;
  has_primary_key boolean;
  pk_constraint_name text;
begin
  -- Verificar si la tabla existe
  select exists (
    select 1 from information_schema.tables 
    where table_schema = 'public' 
    and table_name = 'admins'
  ) into table_exists;
  
  if not table_exists then
    -- Crear tabla nueva
    create table public.admins (
      id uuid primary key default gen_random_uuid(),
      user_id uuid references auth.users(id) on delete cascade,
      email text not null,
      role text default 'collaborator',
      created_by uuid references auth.users(id),
      created_at timestamptz default now(),
      updated_at timestamptz default now(),
      unique(user_id),
      unique(email)
    );
  else
    -- La tabla existe, verificar estructura
    select exists (
      select 1 from information_schema.columns 
      where table_schema = 'public' 
      and table_name = 'admins' 
      and column_name = 'id'
    ) into has_id_column;
    
    -- Verificar si tiene primary key
    select exists (
      select 1 from information_schema.table_constraints 
      where table_schema = 'public' 
      and table_name = 'admins' 
      and constraint_type = 'PRIMARY KEY'
    ) into has_primary_key;
    
    if not has_id_column then
      -- Agregar columna id
      alter table public.admins add column id uuid default gen_random_uuid();
      
      -- Si no hay primary key, hacer id la primary key
      if not has_primary_key then
        alter table public.admins add primary key (id);
      else
        -- Si ya hay primary key, obtener su nombre y eliminarlo primero
        select constraint_name into pk_constraint_name
        from information_schema.table_constraints 
        where table_schema = 'public' 
        and table_name = 'admins' 
        and constraint_type = 'PRIMARY KEY'
        limit 1;
        
        if pk_constraint_name is not null then
          execute format('alter table public.admins drop constraint %I', pk_constraint_name);
        end if;
        
        alter table public.admins add primary key (id);
      end if;
      
      -- Actualizar valores NULL con UUIDs generados
      update public.admins set id = gen_random_uuid() where id is null;
    end if;
    
    -- Agregar otras columnas si no existen
    if not exists (
      select 1 from information_schema.columns 
      where table_schema = 'public' 
      and table_name = 'admins' 
      and column_name = 'user_id'
    ) then
      alter table public.admins add column user_id uuid references auth.users(id) on delete cascade;
    end if;
    
    if not exists (
      select 1 from information_schema.columns 
      where table_schema = 'public' 
      and table_name = 'admins' 
      and column_name = 'email'
    ) then
      alter table public.admins add column email text not null default '';
    end if;
    
    if not exists (
      select 1 from information_schema.columns 
      where table_schema = 'public' 
      and table_name = 'admins' 
      and column_name = 'role'
    ) then
      alter table public.admins add column role text default 'collaborator';
    end if;
    
    if not exists (
      select 1 from information_schema.columns 
      where table_schema = 'public' 
      and table_name = 'admins' 
      and column_name = 'created_by'
    ) then
      alter table public.admins add column created_by uuid references auth.users(id);
    end if;
    
    if not exists (
      select 1 from information_schema.columns 
      where table_schema = 'public' 
      and table_name = 'admins' 
      and column_name = 'created_at'
    ) then
      alter table public.admins add column created_at timestamptz default now();
    end if;
    
    if not exists (
      select 1 from information_schema.columns 
      where table_schema = 'public' 
      and table_name = 'admins' 
      and column_name = 'updated_at'
    ) then
      alter table public.admins add column updated_at timestamptz default now();
    end if;
    
    -- Asegurar que user_id tiene la foreign key correcta (solo si la columna existe)
    if exists (
      select 1 from information_schema.columns 
      where table_schema = 'public' 
      and table_name = 'admins' 
      and column_name = 'user_id'
    ) then
      if not exists (
        select 1 from information_schema.table_constraints 
        where table_schema = 'public' 
        and table_name = 'admins' 
        and constraint_name like '%user_id%'
        and constraint_type = 'FOREIGN KEY'
      ) then
        -- Agregar foreign key si no existe
        alter table public.admins 
        add constraint admins_user_id_fkey 
        foreign key (user_id) references auth.users(id) on delete cascade;
      end if;
    end if;
    
    -- Asegurar constraints unique (solo si las columnas existen)
    if exists (
      select 1 from information_schema.columns 
      where table_schema = 'public' 
      and table_name = 'admins' 
      and column_name = 'user_id'
    ) then
      if not exists (
        select 1 from information_schema.table_constraints 
        where table_schema = 'public' 
        and table_name = 'admins' 
        and constraint_name like '%user_id%'
        and constraint_type = 'UNIQUE'
      ) then
        create unique index if not exists admins_user_id_unique on public.admins(user_id);
      end if;
    end if;
    
    if exists (
      select 1 from information_schema.columns 
      where table_schema = 'public' 
      and table_name = 'admins' 
      and column_name = 'email'
    ) then
      if not exists (
        select 1 from information_schema.table_constraints 
        where table_schema = 'public' 
        and table_name = 'admins' 
        and constraint_name like '%email%'
        and constraint_type = 'UNIQUE'
      ) then
        create unique index if not exists admins_email_unique on public.admins(email);
      end if;
    end if;
  end if;
end $$;

-- Tabla de permisos granulares (solo crear si admins tiene id)
create table if not exists public.admin_permissions (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null,
  permission_key text not null, -- 'stock', 'import', 'export', 'orders', 'products', 'publications'
  can_view boolean default false,
  can_edit boolean default false,
  can_delete boolean default false,
  created_at timestamptz default now(),
  unique(admin_id, permission_key)
);

-- Agregar foreign key constraint solo si no existe
do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints 
    where constraint_schema = 'public' 
    and table_name = 'admin_permissions' 
    and constraint_name = 'admin_permissions_admin_id_fkey'
  ) then
    alter table public.admin_permissions 
    add constraint admin_permissions_admin_id_fkey 
    foreign key (admin_id) references public.admins(id) on delete cascade;
  end if;
end $$;

-- Trigger para updated_at en admins
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'admins_set_updated_at') then
    create trigger admins_set_updated_at before update on public.admins
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- Habilitar RLS
alter table public.admins enable row level security;
alter table public.admin_permissions enable row level security;

-- IMPORTANTE: Crear la función is_super_admin ANTES de las políticas
-- Esta función usa security definer para evitar recursión en RLS
create or replace function public.is_super_admin(check_user_id uuid default auth.uid())
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  return exists (
    select 1 from public.admins 
    where user_id = check_user_id 
    and role = 'super_admin'
  );
end;
$$;

-- Eliminar políticas existentes que causan recursión
drop policy if exists admins_super_admin_all on public.admins;
drop policy if exists admins_self_select on public.admins;
drop policy if exists admin_permissions_super_admin_all on public.admin_permissions;
drop policy if exists admin_permissions_self_select on public.admin_permissions;

-- Los super_admins pueden ver y gestionar todos los admins
-- Usar la función is_super_admin que es security definer para evitar recursión
do $$ begin
  create policy admins_super_admin_all on public.admins
    for all to authenticated
    using (public.is_super_admin(auth.uid()))
    with check (public.is_super_admin(auth.uid()));
exception when duplicate_object then
  -- La política ya existe, no hacer nada
  null;
end $$;

-- Los colaboradores pueden ver su propio registro
do $$ begin
  create policy admins_self_select on public.admins
    for select to authenticated
    using (user_id = auth.uid());
exception when duplicate_object then
  -- La política ya existe, no hacer nada
  null;
end $$;

-- Políticas RLS para admin_permissions
-- Los super_admins pueden ver y gestionar todos los permisos
-- Usar la función is_super_admin para evitar recursión
do $$ begin
  create policy admin_permissions_super_admin_all on public.admin_permissions
    for all to authenticated
    using (public.is_super_admin(auth.uid()))
    with check (public.is_super_admin(auth.uid()));
exception when duplicate_object then
  -- La política ya existe, no hacer nada
  null;
end $$;

-- Los colaboradores pueden ver sus propios permisos
-- Usar una función helper para evitar recursión
do $$ begin
  create policy admin_permissions_self_select on public.admin_permissions
    for select to authenticated
    using (
      exists (
        select 1 from public.admins a 
        where a.id = admin_permissions.admin_id 
        and a.user_id = auth.uid()
      )
    );
exception when duplicate_object then
  -- La política ya existe, no hacer nada
  null;
end $$;

-- La función is_super_admin ya fue creada arriba antes de las políticas

-- Función helper para verificar permisos
create or replace function public.has_permission(
  check_user_id uuid,
  permission_key text,
  action text default 'view' -- 'view', 'edit', 'delete'
)
returns boolean
language plpgsql
security definer
as $$
declare
  is_super boolean;
  has_perm boolean;
begin
  -- Super admins tienen todos los permisos
  select public.is_super_admin(check_user_id) into is_super;
  if is_super then
    return true;
  end if;
  
  -- Verificar permiso específico
  select case
    when action = 'view' then can_view
    when action = 'edit' then can_edit
    when action = 'delete' then can_delete
    else false
  end into has_perm
  from public.admin_permissions ap
  join public.admins a on a.id = ap.admin_id
  where a.user_id = check_user_id
  and ap.permission_key = has_permission.permission_key;
  
  return coalesce(has_perm, false);
end;
$$;

-- Crear super_admin inicial para gonzidel@gmail.com
-- Nota: Esto requiere que el usuario ya exista en auth.users
do $$
declare
  super_admin_user_id uuid;
begin
  -- Buscar el user_id del email gonzidel@gmail.com
  select id into super_admin_user_id
  from auth.users
  where email = 'gonzidel@gmail.com'
  limit 1;
  
  -- Si existe, crear el registro de super_admin
  if super_admin_user_id is not null then
    insert into public.admins (user_id, email, role, created_by)
    values (super_admin_user_id, 'gonzidel@gmail.com', 'super_admin', super_admin_user_id)
    on conflict (user_id) do update
    set role = 'super_admin',
        email = 'gonzidel@gmail.com',
        updated_at = now();
    
    raise notice 'Super admin creado/actualizado para gonzidel@gmail.com';
  else
    raise notice 'Usuario gonzidel@gmail.com no encontrado en auth.users. Debe registrarse primero.';
  end if;
end $$;

-- Función RPC para agregar colaborador a la tabla admins (sin requerir sesión activa)
-- Esta función se usa después de que el usuario fue creado con signUp
-- Función para crear colaborador con cuenta nueva
-- Nota: Esta función verifica si el usuario ya existe en auth.users
-- Si no existe, retorna un error indicando que se debe usar signUp desde el cliente
-- Esto evita problemas de permisos al intentar insertar directamente en auth.users
create or replace function public.create_collaborator_with_account(
  p_email text,
  p_password text,
  p_created_by_user_id uuid
)
returns json
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_user_id uuid;
  v_admin_id uuid;
  v_result json;
begin
  -- Verificar que el usuario que creó este colaborador es super_admin
  if not public.is_super_admin(p_created_by_user_id) then
    return json_build_object(
      'success', false,
      'message', 'Solo los super administradores pueden crear colaboradores'
    );
  end if;
  
  -- Verificar que el email no existe ya en admins
  if exists (select 1 from public.admins where email = p_email) then
    return json_build_object(
      'success', false,
      'message', 'Este colaborador ya está registrado'
    );
  end if;
  
  -- Verificar si el usuario ya existe en auth.users
  -- Si existe, podemos agregarlo directamente como colaborador
  select id into v_user_id
  from auth.users
  where email = p_email
  limit 1;
  
  if v_user_id is null then
    -- El usuario no existe en auth.users
    -- No podemos crearlo desde aquí porque requiere permisos especiales
    -- El cliente debe usar signUp primero
    return json_build_object(
      'success', false,
      'message', 'El usuario no existe. Por favor, usa el método de signUp desde el cliente.',
      'requires_signup', true
    );
  end if;
  
  -- El usuario existe, crear registro en customers si no existe
  insert into public.customers (id, email)
  values (v_user_id, p_email)
  on conflict (id) do update set email = p_email;
  
  -- Crear registro en admins
  insert into public.admins (user_id, email, role, created_by)
  values (v_user_id, p_email, 'collaborator', p_created_by_user_id)
  on conflict (user_id) do update set email = p_email
  returning id into v_admin_id;
  
  -- Retornar resultado
  return json_build_object(
    'success', true,
    'admin_id', v_admin_id,
    'user_id', v_user_id,
    'email', p_email,
    'message', 'Colaborador agregado exitosamente'
  );
  
exception when others then
  return json_build_object(
    'success', false,
    'error', sqlerrm,
    'message', 'Error: ' || sqlerrm
  );
end;
$$;

-- Función para agregar colaborador existente (usuario ya creado en auth.users)
create or replace function public.add_collaborator_to_admins(
  p_user_id uuid,
  p_email text,
  p_created_by_user_id uuid
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin_id uuid;
  v_result json;
  v_user_exists boolean;
  v_attempts int := 0;
  v_max_attempts int := 20; -- Aumentar a 20 intentos (4 segundos)
begin
  -- Verificar que el usuario que creó este colaborador es super_admin
  if not public.is_super_admin(p_created_by_user_id) then
    return json_build_object(
      'success', false,
      'message', 'Solo los super administradores pueden agregar colaboradores'
    );
  end if;
  
  -- Verificar que el email no existe ya en admins
  if exists (select 1 from public.admins where email = p_email) then
    return json_build_object(
      'success', false,
      'message', 'Este colaborador ya está registrado'
    );
  end if;
  
  -- Esperar a que el usuario exista en auth.users (puede haber un delay más largo)
  v_user_exists := false;
  while not v_user_exists and v_attempts < v_max_attempts loop
    select exists(select 1 from auth.users where id = p_user_id) into v_user_exists;
    if not v_user_exists then
      perform pg_sleep(0.2); -- Esperar 200ms
      v_attempts := v_attempts + 1;
    end if;
  end loop;
  
  if not v_user_exists then
    return json_build_object(
      'success', false,
      'message', 'El usuario no existe en auth.users después de esperar. Esto puede deberse a que el email requiere confirmación. Por favor, verifica la configuración de Supabase o intenta de nuevo.'
    );
  end if;
  
  -- Crear registro en customers si no existe
  insert into public.customers (id, email)
  values (p_user_id, p_email)
  on conflict (id) do update set email = p_email;
  
  -- Crear registro en admins
  insert into public.admins (user_id, email, role, created_by)
  values (p_user_id, p_email, 'collaborator', p_created_by_user_id)
  returning id into v_admin_id;
  
  -- Retornar resultado
  return json_build_object(
    'success', true,
    'admin_id', v_admin_id,
    'email', p_email,
    'message', 'Colaborador agregado exitosamente'
  );
  
exception when others then
  return json_build_object(
    'success', false,
    'error', sqlerrm,
    'message', 'Error: ' || sqlerrm
  );
end;
$$;

-- Función para agregar colaborador buscando por email (sin requerir user_id)
create or replace function public.add_collaborator_by_email(
  p_email text,
  p_created_by_user_id uuid
)
returns json
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_user_id uuid;
  v_admin_id uuid;
  v_result json;
begin
  -- Verificar que el usuario que creó este colaborador es super_admin
  if not public.is_super_admin(p_created_by_user_id) then
    return json_build_object(
      'success', false,
      'message', 'Solo los super administradores pueden agregar colaboradores'
    );
  end if;
  
  -- Verificar que el email no existe ya en admins
  if exists (select 1 from public.admins where email = p_email) then
    return json_build_object(
      'success', false,
      'message', 'Este colaborador ya está registrado'
    );
  end if;
  
  -- Buscar el usuario por email en auth.users
  select id into v_user_id
  from auth.users
  where email = p_email
  limit 1;
  
  if v_user_id is null then
    return json_build_object(
      'success', false,
      'message', 'El usuario no existe en el sistema. El usuario debe registrarse primero o usar la opción "Crear cuenta nueva con contraseña".'
    );
  end if;
  
  -- Crear registro en customers si no existe
  insert into public.customers (id, email)
  values (v_user_id, p_email)
  on conflict (id) do update set email = p_email;
  
  -- Crear registro en admins
  insert into public.admins (user_id, email, role, created_by)
  values (v_user_id, p_email, 'collaborator', p_created_by_user_id)
  returning id into v_admin_id;
  
  -- Retornar resultado
  return json_build_object(
    'success', true,
    'admin_id', v_admin_id,
    'user_id', v_user_id,
    'email', p_email,
    'message', 'Colaborador agregado exitosamente'
  );
  
exception when others then
  return json_build_object(
    'success', false,
    'error', sqlerrm,
    'message', 'Error: ' || sqlerrm
  );
end;
$$;

-- Función para enviar email de reset de contraseña a un colaborador
-- Útil para usuarios que fueron creados con OAuth y necesitan establecer una contraseña
create or replace function public.send_password_reset_to_collaborator(
  p_email text,
  p_created_by_user_id uuid
)
returns json
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_user_id uuid;
  v_user_exists boolean;
begin
  -- Verificar que el usuario que solicita esto es super_admin
  if not public.is_super_admin(p_created_by_user_id) then
    return json_build_object(
      'success', false,
      'message', 'Solo los super administradores pueden enviar reset de contraseña'
    );
  end if;
  
  -- Verificar que el usuario existe en auth.users
  select id into v_user_id
  from auth.users
  where email = p_email
  limit 1;
  
  if v_user_id is null then
    return json_build_object(
      'success', false,
      'message', 'El usuario no existe en el sistema'
    );
  end if;
  
  -- Verificar que el usuario es colaborador
  if not exists (select 1 from public.admins where email = p_email) then
    return json_build_object(
      'success', false,
      'message', 'Este usuario no es un colaborador autorizado'
    );
  end if;
  
  -- Retornar éxito (el envío del email se hace desde el cliente)
  return json_build_object(
    'success', true,
    'user_id', v_user_id,
    'email', p_email,
    'message', 'El colaborador puede usar "Olvidé mi contraseña" para establecer su contraseña'
  );
  
exception when others then
  return json_build_object(
    'success', false,
    'error', sqlerrm,
    'message', 'Error: ' || sqlerrm
  );
end;
$$;

-- Recargar esquema
select pg_notify('pgrst','reload schema');

