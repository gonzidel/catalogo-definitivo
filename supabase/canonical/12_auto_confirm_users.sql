-- 12_auto_confirm_users.sql — Configuración automática de usuarios (idempotente)
-- Este script configura funciones para:
-- 1. Confirmar automáticamente el email cuando se crea un usuario (para desarrollo)
-- 2. Crear automáticamente el registro en customers cuando se crea un usuario en auth.users

-- NOTA: Los triggers en auth.users requieren permisos de service_role
-- Si no puedes crear triggers, usa las funciones RPC manualmente o configura
-- en Supabase Dashboard: Authentication → Settings → Disable email confirmations

-- ============================================================================
-- 1. FUNCIÓN RPC: Confirmar email de un usuario específico
-- ============================================================================
-- Esta función puede ser llamada después de crear un usuario para confirmar su email
create or replace function public.confirm_user_email(p_user_id uuid)
returns json
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  -- Confirmar el email del usuario
  update auth.users
  set email_confirmed_at = now()
  where id = p_user_id
  and email_confirmed_at is null;
  
  -- Crear registro en customers si no existe
  insert into public.customers (id, email)
  select id, email
  from auth.users
  where id = p_user_id
  on conflict (id) do update
  set email = excluded.email,
      updated_at = now();
  
  return json_build_object(
    'success', true,
    'message', 'Email confirmado y registro en customers creado'
  );
exception when others then
  return json_build_object(
    'success', false,
    'error', sqlerrm
  );
end;
$$;

-- ============================================================================
-- 2. FUNCIÓN RPC: Confirmar email por dirección de email
-- ============================================================================
create or replace function public.confirm_user_email_by_address(p_email text)
returns json
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_user_id uuid;
begin
  -- Buscar el usuario por email
  select id into v_user_id
  from auth.users
  where email = p_email
  limit 1;
  
  if v_user_id is null then
    return json_build_object(
      'success', false,
      'message', 'Usuario no encontrado'
    );
  end if;
  
  -- Confirmar el email
  update auth.users
  set email_confirmed_at = now()
  where id = v_user_id
  and email_confirmed_at is null;
  
  -- Crear registro en customers si no existe
  insert into public.customers (id, email)
  values (v_user_id, p_email)
  on conflict (id) do update
  set email = excluded.email,
      updated_at = now();
  
  return json_build_object(
    'success', true,
    'user_id', v_user_id,
    'message', 'Email confirmado y registro en customers creado'
  );
exception when others then
  return json_build_object(
    'success', false,
    'error', sqlerrm
  );
end;
$$;

-- ============================================================================
-- 3. INTENTAR CREAR TRIGGER EN auth.users (requiere permisos especiales)
-- ============================================================================
-- NOTA: Esto puede fallar si no tienes permisos de service_role
-- Si falla, usa las funciones RPC manualmente después de crear usuarios

-- Crear función trigger (fuera del bloque do para evitar errores de sintaxis)
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  -- Confirmar el email automáticamente si no está confirmado
  if new.email_confirmed_at is null then
    new.email_confirmed_at := now();
  end if;
  
  -- Crear registro en customers automáticamente
  insert into public.customers (id, email)
  values (new.id, new.email)
  on conflict (id) do update
  set email = excluded.email,
      updated_at = now();
  
  return new;
end;
$$;

-- Intentar crear trigger (puede fallar sin permisos)
do $$
begin
  if not exists (
    select 1 from pg_trigger 
    where tgname = 'on_auth_user_created'
  ) then
    execute 'create trigger on_auth_user_created
      after insert on auth.users
      for each row
      execute function public.handle_new_user()';
    
    raise notice '✅ Trigger on_auth_user_created creado exitosamente';
  else
    raise notice 'ℹ️ Trigger on_auth_user_created ya existe';
  end if;
exception when insufficient_privilege then
  raise warning '⚠️ No se pudo crear el trigger (requiere permisos de service_role). Usa las funciones RPC confirm_user_email() o confirm_user_email_by_address() manualmente.';
when others then
  raise warning '⚠️ Error al crear trigger: %. Usa las funciones RPC manualmente.', sqlerrm;
end $$;

-- ============================================================================
-- 4. ACTUALIZAR USUARIOS EXISTENTES SIN EMAIL CONFIRMADO
-- ============================================================================
-- Esta función actualiza usuarios existentes que no tienen email confirmado
-- Útil para corregir usuarios que ya fueron creados antes de este script
create or replace function public.confirm_existing_unconfirmed_users()
returns void
language plpgsql
security definer
set search_path = auth
as $$
begin
  -- Confirmar emails de usuarios existentes que no están confirmados
  update auth.users
  set email_confirmed_at = now()
  where email_confirmed_at is null
  and email is not null;
  
  raise notice 'Usuarios existentes actualizados: emails confirmados automáticamente';
end;
$$;

-- Ejecutar una vez para confirmar usuarios existentes
do $$
begin
  perform public.confirm_existing_unconfirmed_users();
exception when others then
  raise warning 'Error al confirmar usuarios existentes: %', sqlerrm;
end $$;

-- ============================================================================
-- 5. VERIFICACIÓN: Mostrar estado de la configuración
-- ============================================================================
do $$
declare
  trigger_exists boolean;
  function_exists boolean;
begin
  -- Verificar si el trigger existe
  select exists (
    select 1 from pg_trigger 
    where tgname = 'on_auth_user_created'
  ) into trigger_exists;
  
  -- Verificar si la función existe
  select exists (
    select 1 from pg_proc 
    where proname = 'handle_new_user'
    and pronamespace = (select oid from pg_namespace where nspname = 'public')
  ) into function_exists;
  
  if trigger_exists and function_exists then
    raise notice '✅ Configuración completa: Trigger y función creados exitosamente';
  else
    raise warning '⚠️ Configuración incompleta: Trigger=% | Función=%', trigger_exists, function_exists;
  end if;
end $$;

-- Recargar esquema
select pg_notify('pgrst','reload schema');

