-- Agregar el usuario como super_admin
-- MÉTODO 1: Por email (reemplaza 'gonzidel@gmail.com' con tu email)

-- Primero, verificar que el usuario existe
SELECT id, email FROM auth.users WHERE email = 'gonzidel@gmail.com';

-- Luego, insertar en admins (reemplaza el UUID con el que obtuviste arriba)
INSERT INTO public.admins (user_id, email, role, created_by, created_at, updated_at)
SELECT 
  id,
  email,
  'super_admin',
  id, -- Se crea a sí mismo
  now(),
  now()
FROM auth.users
WHERE email = 'gonzidel@gmail.com'
ON CONFLICT (user_id) 
DO UPDATE SET
  role = 'super_admin',
  email = EXCLUDED.email,
  updated_at = now();

-- Verificar que se agregó correctamente
SELECT 
  a.id,
  a.user_id,
  a.email,
  a.role,
  a.created_at,
  u.email as auth_email
FROM public.admins a
JOIN auth.users u ON u.id = a.user_id
WHERE a.email = 'gonzidel@gmail.com';

-- ============================================
-- MÉTODO 2: Si conoces el UUID directamente
-- ============================================
-- INSERT INTO public.admins (user_id, email, role, created_by)
-- VALUES (
--   'TU_UUID_AQUI'::uuid,
--   'gonzidel@gmail.com',
--   'super_admin',
--   'TU_UUID_AQUI'::uuid
-- )
-- ON CONFLICT (user_id) 
-- DO UPDATE SET role = 'super_admin';

