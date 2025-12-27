-- 34_fix_customers_admin_rls.sql — Corregir políticas RLS para admins en customers
-- Este script corrige las políticas para usar el nombre de columna correcto de la tabla admins

-- 1. Verificar qué columna tiene la tabla admins
DO $$
DECLARE
  v_column_name text;
BEGIN
  SELECT column_name INTO v_column_name
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'admins'
    AND column_name IN ('user_id', 'admin_user_id')
  LIMIT 1;
  
  RAISE NOTICE 'Columna encontrada en admins: %', COALESCE(v_column_name, 'NINGUNA');
END $$;

-- 2. Eliminar políticas existentes que usan el nombre incorrecto
DROP POLICY IF EXISTS customers_admin_select ON public.customers;
DROP POLICY IF EXISTS customers_admin_insert ON public.customers;
DROP POLICY IF EXISTS customers_admin_update ON public.customers;
DROP POLICY IF EXISTS customers_admin_all ON public.customers;
DROP POLICY IF EXISTS customers_admin_manage ON public.customers;

-- 3. Crear políticas usando solo user_id (que es el nombre correcto de la columna)

-- Política de SELECT para admins
CREATE POLICY customers_admin_select
ON public.customers
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.admins 
    WHERE user_id = auth.uid()
  )
);

-- Política de INSERT para admins
CREATE POLICY customers_admin_insert
ON public.customers
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.admins 
    WHERE user_id = auth.uid()
  )
);

-- Política de UPDATE para admins
CREATE POLICY customers_admin_update
ON public.customers
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.admins 
    WHERE user_id = auth.uid()
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.admins 
    WHERE user_id = auth.uid()
  )
);

-- 4. Asegurar que las políticas de usuarios normales existan
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname='public' 
    AND tablename='customers' 
    AND policyname='customers_self_select'
  ) THEN
    CREATE POLICY customers_self_select ON public.customers
      FOR SELECT TO authenticated USING (id = auth.uid());
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname='public' 
    AND tablename='customers' 
    AND policyname='customers_self_insert'
  ) THEN
    CREATE POLICY customers_self_insert ON public.customers
      FOR INSERT TO authenticated WITH CHECK (id = auth.uid());
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname='public' 
    AND tablename='customers' 
    AND policyname='customers_self_update'
  ) THEN
    CREATE POLICY customers_self_update ON public.customers
      FOR UPDATE TO authenticated 
      USING (id = auth.uid()) 
      WITH CHECK (id = auth.uid());
  END IF;
END $$;

-- 5. Verificar que RLS está habilitado
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

-- 6. Recargar esquema de PostgREST
SELECT pg_notify('pgrst', 'reload schema');

-- 7. Verificar políticas finales
SELECT 
    policyname as "Nombre de Política",
    cmd as "Comando",
    CASE 
        WHEN with_check IS NOT NULL THEN 'WITH CHECK: ' || with_check
        WHEN qual IS NOT NULL THEN 'USING: ' || qual
        ELSE 'Sin condición'
    END as "Condición"
FROM pg_policies
WHERE schemaname = 'public' 
  AND tablename = 'customers'
ORDER BY policyname;

-- 8. Verificar si el usuario actual es admin
SELECT 
  auth.uid() as user_id,
  EXISTS (
    SELECT 1 FROM public.admins 
    WHERE user_id = auth.uid()
  ) as is_admin;

