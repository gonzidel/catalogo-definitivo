-- Script para verificar y corregir permisos de administrador
-- Ejecuta este script en Supabase SQL Editor si recibes error 403 al subir imágenes

-- 1. Verificar si el usuario actual es super_admin
-- Reemplaza 'fylenvios@gmail.com' con tu email
SELECT 
  u.id as user_id,
  u.email,
  a.role,
  CASE 
    WHEN a.role = 'super_admin' THEN '✅ Es super_admin'
    WHEN a.role IS NOT NULL THEN '⚠️ Es admin pero no super_admin'
    ELSE '❌ No es admin'
  END as status
FROM auth.users u
LEFT JOIN public.admins a ON a.user_id = u.id
WHERE u.email = 'fylenvios@gmail.com';

-- 2. Si el usuario no existe en la tabla admins, agregarlo como super_admin
-- Reemplaza 'fylenvios@gmail.com' con tu email
INSERT INTO public.admins (user_id, email, role, created_at, updated_at)
SELECT 
  u.id,
  u.email,
  'super_admin',
  now(),
  now()
FROM auth.users u
WHERE u.email = 'fylenvios@gmail.com'
  AND NOT EXISTS (
    SELECT 1 FROM public.admins a WHERE a.user_id = u.id
  );

-- 3. Si el usuario existe pero no es super_admin, actualizarlo
-- Reemplaza 'fylenvios@gmail.com' con tu email
UPDATE public.admins
SET role = 'super_admin',
    updated_at = now()
WHERE email = 'fylenvios@gmail.com'
  AND role != 'super_admin';

-- 4. Verificar que la función is_super_admin existe y funciona
SELECT public.is_super_admin(auth.uid()) as is_current_user_super_admin;

-- 5. Verificar todos los admins
SELECT 
  a.id,
  a.email,
  a.role,
  a.created_at,
  u.id as user_id
FROM public.admins a
JOIN auth.users u ON u.id = a.user_id
ORDER BY a.created_at DESC;
