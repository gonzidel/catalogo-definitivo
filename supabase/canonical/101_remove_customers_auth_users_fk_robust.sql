-- 101_remove_customers_auth_users_fk_robust.sql
-- Script robusto para eliminar foreign key de customers.id a auth.users
-- Usa pg_constraint directamente para mayor precisión

-- 1. Eliminar TODAS las foreign keys de customers.id que referencien auth.users
-- Usando pg_constraint para mayor precisión que information_schema
DO $$
DECLARE
  constraint_record record;
  constraint_name text;
  constraints_found int := 0;
BEGIN
  RAISE NOTICE 'Buscando foreign keys de customers.id a auth.users...';
  
  -- Buscar todas las foreign keys usando pg_constraint (más preciso)
  FOR constraint_record IN
    SELECT 
      conname as constraint_name,
      conrelid::regclass::text as table_name
    FROM pg_constraint
    WHERE conrelid = 'public.customers'::regclass
      AND contype = 'f'  -- Foreign key
      AND confrelid = 'auth.users'::regclass  -- Referencia a auth.users
  LOOP
    constraint_name := constraint_record.constraint_name;
    constraints_found := constraints_found + 1;
    
    RAISE NOTICE 'Encontrada foreign key: % en tabla %', constraint_name, constraint_record.table_name;
    
    -- Eliminar la foreign key con CASCADE para eliminar dependencias
    BEGIN
      EXECUTE format('ALTER TABLE public.customers DROP CONSTRAINT %I CASCADE', constraint_name);
      RAISE NOTICE '✓ Foreign key eliminada exitosamente: %', constraint_name;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '✗ Error al eliminar foreign key %: %', constraint_name, SQLERRM;
    END;
  END LOOP;
  
  IF constraints_found = 0 THEN
    RAISE NOTICE 'No se encontraron foreign keys de customers.id a auth.users (puede que ya estén eliminadas)';
  ELSE
    RAISE NOTICE 'Total de foreign keys procesadas: %', constraints_found;
  END IF;
  
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Error general al buscar/eliminar foreign keys: %', SQLERRM;
END $$;

-- 2. Verificar que customers.id sigue siendo primary key
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 
    FROM pg_constraint
    WHERE conrelid = 'public.customers'::regclass
      AND contype = 'p'  -- Primary key
  ) THEN
    -- Si no existe primary key, recrearla
    ALTER TABLE public.customers 
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);
    
    RAISE NOTICE '✓ Primary key de customers.id recreada';
  ELSE
    RAISE NOTICE '✓ Primary key de customers.id ya existe';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Error al verificar/recrear primary key: %', SQLERRM;
END $$;

-- 3. Eliminar y recrear la foreign key de orders.customer_id a customers.id
-- Esto asegura que no haya validación indirecta contra auth.users
DO $$
DECLARE
  fk_name text;
  fk_exists boolean;
BEGIN
  -- Buscar el nombre de la foreign key actual
  SELECT conname INTO fk_name
  FROM pg_constraint
  WHERE conrelid = 'public.orders'::regclass
    AND contype = 'f'  -- Foreign key
    AND confrelid = 'public.customers'::regclass  -- Referencia a customers
    AND array_length(conkey, 1) = 1
    AND conkey[1] = (
      SELECT attnum 
      FROM pg_attribute 
      WHERE attrelid = 'public.orders'::regclass 
      AND attname = 'customer_id'
    )
  LIMIT 1;
  
  IF fk_name IS NOT NULL THEN
    RAISE NOTICE 'Eliminando foreign key existente: %', fk_name;
    EXECUTE format('ALTER TABLE public.orders DROP CONSTRAINT %I', fk_name);
    RAISE NOTICE '✓ Foreign key eliminada: %', fk_name;
  END IF;
  
  -- Recrear la foreign key directamente a customers.id (sin validación indirecta)
  RAISE NOTICE 'Recreando foreign key de orders.customer_id a customers.id...';
  ALTER TABLE public.orders
  ADD CONSTRAINT orders_customer_id_fkey 
  FOREIGN KEY (customer_id) 
  REFERENCES public.customers(id) 
  ON DELETE CASCADE;
  
  RAISE NOTICE '✓ Foreign key de orders.customer_id a customers.id recreada correctamente';
  
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Error al recrear foreign key de orders: %', SQLERRM;
END $$;

-- 4. DIAGNÓSTICO: Listar todas las foreign keys relacionadas con customers
DO $$
DECLARE
  fk_record record;
BEGIN
  RAISE NOTICE '--- DIAGNÓSTICO: Foreign keys relacionadas con customers ---';
  
  FOR fk_record IN
    SELECT 
      conname as constraint_name,
      conrelid::regclass::text as source_table,
      confrelid::regclass::text as target_table,
      pg_get_constraintdef(oid) as definition
    FROM pg_constraint
    WHERE (conrelid = 'public.customers'::regclass OR confrelid = 'public.customers'::regclass)
      AND contype = 'f'
  LOOP
    RAISE NOTICE 'FK: % | % → % | %', 
      fk_record.constraint_name,
      fk_record.source_table,
      fk_record.target_table,
      fk_record.definition;
  END LOOP;
  
  RAISE NOTICE '--- FIN DIAGNÓSTICO ---';
END $$;

-- 5. Recargar esquema del API REST
SELECT pg_notify('pgrst', 'reload schema');

DO $$
BEGIN
  RAISE NOTICE '═══════════════════════════════════════════════════════════';
  RAISE NOTICE 'Script completado: customers.id ya no requiere referencia a auth.users';
  RAISE NOTICE '═══════════════════════════════════════════════════════════';
END $$;
