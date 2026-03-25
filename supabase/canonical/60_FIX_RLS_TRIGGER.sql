-- 60_FIX_RLS_TRIGGER.sql — Corregir política RLS para permitir inserciones desde el trigger
-- El problema: La política RLS actual requiere auth.uid() sea admin, pero en triggers puede ser NULL

-- PASO 1: Verificar política actual
SELECT 
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual,
  with_check
FROM pg_policies
WHERE tablename = 'daily_sales'
ORDER BY policyname;

-- PASO 2: Eliminar política restrictiva actual
DROP POLICY IF EXISTS daily_sales_admin_all ON public.daily_sales;

-- PASO 3: Crear política que permita:
-- 1. Admins autenticados (para operaciones manuales)
-- 2. Funciones SECURITY DEFINER (para triggers) - permitir cuando created_by es NULL
-- IMPORTANTE: Permitir tanto a 'authenticated' como a funciones SECURITY DEFINER
CREATE POLICY daily_sales_admin_all ON public.daily_sales
  FOR ALL
  USING (
    -- Permitir si es admin autenticado
    (auth.role() = 'authenticated' AND EXISTS (SELECT 1 FROM public.admins a WHERE a.user_id = auth.uid()))
    OR
    -- Permitir si created_by es NULL (inserción desde trigger con SECURITY DEFINER)
    -- Esto permite que el trigger inserte sin necesidad de auth.uid()
    -- Las funciones SECURITY DEFINER pueden tener auth.uid() NULL
    created_by IS NULL
  )
  WITH CHECK (
    -- Permitir si es admin autenticado
    (auth.role() = 'authenticated' AND EXISTS (SELECT 1 FROM public.admins a WHERE a.user_id = auth.uid()))
    OR
    -- Permitir si created_by es NULL (inserción desde trigger)
    -- Cuando el trigger inserta, created_by será NULL porque auth.uid() no está disponible
    created_by IS NULL
  );

-- PASO 4: Verificar que la política se creó correctamente
SELECT 
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd
FROM pg_policies
WHERE tablename = 'daily_sales'
ORDER BY policyname;

-- PASO 5: Mensaje final
DO $$
BEGIN
  RAISE NOTICE '✅ Política RLS actualizada';
  RAISE NOTICE '✅ Ahora permite inserciones desde triggers (created_by NULL)';
  RAISE NOTICE '✅ También permite operaciones de admins autenticados';
END $$;

