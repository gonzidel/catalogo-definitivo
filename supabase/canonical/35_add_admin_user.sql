-- 35_add_admin_user.sql — Agregar usuario como administrador
-- Este script agrega el usuario con email 'gonzidel@gmail.com' como super_admin

-- 1. Buscar el user_id del usuario por email
DO $$
DECLARE
  v_user_id uuid;
  v_user_email text := 'gonzidel@gmail.com';
BEGIN
  -- Buscar el user_id en auth.users
  SELECT id INTO v_user_id
  FROM auth.users
  WHERE lower(trim(email)) = lower(trim(v_user_email))
  LIMIT 1;
  
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Usuario con email % no encontrado en auth.users', v_user_email;
  END IF;
  
  RAISE NOTICE 'Usuario encontrado: % (ID: %)', v_user_email, v_user_id;
  
  -- 2. Insertar o actualizar en la tabla admins
  INSERT INTO public.admins (user_id, email, role, created_by)
  VALUES (
    v_user_id,
    v_user_email,
    'super_admin',
    v_user_id  -- Se crea a sí mismo como admin
  )
  ON CONFLICT (user_id) DO UPDATE SET
    email = EXCLUDED.email,
    role = 'super_admin',
    updated_at = now();
  
  RAISE NOTICE 'Usuario agregado/actualizado como super_admin en la tabla admins';
END $$;

-- 3. Verificar que se agregó correctamente
SELECT 
  a.id,
  a.user_id,
  a.email,
  a.role,
  a.created_at,
  au.email as auth_email,
  CASE 
    WHEN au.id IS NOT NULL THEN '✅ Usuario existe en auth.users'
    ELSE '❌ Usuario NO existe en auth.users'
  END as estado_auth
FROM public.admins a
LEFT JOIN auth.users au ON au.id = a.user_id
WHERE lower(trim(a.email)) = lower(trim('gonzidel@gmail.com'));

-- 4. Verificar que el usuario se agregó correctamente
SELECT 
  a.id as admin_id,
  a.user_id,
  a.email,
  a.role,
  au.id as auth_user_id,
  au.email as auth_email,
  CASE 
    WHEN au.id IS NOT NULL THEN '✅ Usuario existe en auth.users y está en admins'
    ELSE '❌ Usuario NO existe en auth.users'
  END as estado
FROM public.admins a
LEFT JOIN auth.users au ON au.id = a.user_id
WHERE lower(trim(a.email)) = lower(trim('gonzidel@gmail.com'));

-- 5. Listar todos los admins para verificar
SELECT 
  id,
  user_id,
  email,
  role,
  created_at
FROM public.admins
ORDER BY created_at DESC;

