-- 99_remove_fylenvios_super_admin.sql
-- Remover permiso de super_admin de fylenvios@gmail.com y cambiarlo a collaborator
-- Solo gonzidel@gmail.com debe ser super_admin

-- 1. Verificar estado actual de super_admins
SELECT 
  a.email,
  a.role,
  a.created_at
FROM public.admins a
WHERE a.role = 'super_admin'
ORDER BY a.created_at;

-- 2. Cambiar fylenvios@gmail.com de super_admin a collaborator
UPDATE public.admins
SET role = 'collaborator',
    updated_at = now()
WHERE email = 'fylenvios@gmail.com'
  AND role = 'super_admin';

-- 3. Asegurar que gonzidel@gmail.com sea super_admin
INSERT INTO public.admins (user_id, email, role, created_by)
SELECT 
  u.id,
  u.email,
  'super_admin',
  u.id
FROM auth.users u
WHERE u.email = 'gonzidel@gmail.com'
ON CONFLICT (user_id) 
DO UPDATE SET
  role = 'super_admin',
  email = EXCLUDED.email,
  updated_at = now();

-- 4. Verificación final: solo gonzidel@gmail.com debe ser super_admin
SELECT 
  a.email,
  a.role,
  CASE 
    WHEN a.role = 'super_admin' AND a.email = 'gonzidel@gmail.com' THEN '✅ Correcto'
    WHEN a.role = 'super_admin' THEN '❌ Error: No debería ser super_admin'
    ELSE '✅ Correcto (collaborator)'
  END as status
FROM public.admins a
ORDER BY a.role DESC, a.email;
