-- 100_remove_customers_auth_users_fk.sql
-- Eliminar foreign key de customers.id a auth.users para permitir clientes sin usuario
-- Esto permite clientes importados y manuales sin correo electrónico

-- 1. Eliminar todas las foreign keys de customers.id que referencien auth.users
DO $$
DECLARE
  constraint_record record;
  constraint_name text;
BEGIN
  -- Buscar todas las foreign keys de customers.id que referencien auth.users
  FOR constraint_record IN
    SELECT 
      tc.constraint_name,
      tc.table_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu 
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu 
      ON ccu.constraint_name = tc.constraint_name
      AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      AND tc.table_name = 'customers'
      AND kcu.column_name = 'id'
      AND ccu.table_schema = 'auth'
      AND ccu.table_name = 'users'
  LOOP
    constraint_name := constraint_record.constraint_name;
    
    -- Eliminar la foreign key
    EXECUTE format('ALTER TABLE public.customers DROP CONSTRAINT IF EXISTS %I CASCADE', constraint_name);
    
    RAISE NOTICE 'Foreign key eliminada: %', constraint_name;
  END LOOP;
  
  -- Verificar si se eliminó alguna constraint
  IF NOT FOUND THEN
    RAISE NOTICE 'No se encontraron foreign keys de customers.id a auth.users';
  END IF;
  
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Error al eliminar foreign keys: %', SQLERRM;
END $$;

-- 2. Verificar que customers.id sigue siendo primary key (no debe eliminarse)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 
    FROM information_schema.table_constraints 
    WHERE constraint_schema = 'public' 
    AND table_name = 'customers' 
    AND constraint_type = 'PRIMARY KEY'
    AND constraint_name LIKE '%customers%id%'
  ) THEN
    -- Si no existe primary key, recrearla
    ALTER TABLE public.customers 
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);
    
    RAISE NOTICE 'Primary key de customers.id recreada';
  ELSE
    RAISE NOTICE 'Primary key de customers.id ya existe';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Error al verificar/recrear primary key: %', SQLERRM;
END $$;

-- 3. Verificar que orders.customer_id sigue referenciando customers.id correctamente
DO $$
BEGIN
  -- Verificar que la foreign key de orders a customers existe
  IF EXISTS (
    SELECT 1 
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu 
      ON tc.constraint_name = kcu.constraint_name
    JOIN information_schema.constraint_column_usage ccu 
      ON ccu.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      AND tc.table_name = 'orders'
      AND kcu.column_name = 'customer_id'
      AND ccu.table_schema = 'public'
      AND ccu.table_name = 'customers'
      AND ccu.column_name = 'id'
  ) THEN
    RAISE NOTICE 'Foreign key de orders.customer_id a customers.id está correcta';
  ELSE
    RAISE WARNING 'Foreign key de orders.customer_id a customers.id NO existe - puede requerir recreación';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Error al verificar foreign key de orders: %', SQLERRM;
END $$;

-- 4. Recargar esquema del API REST
SELECT pg_notify('pgrst', 'reload schema');

DO $$
BEGIN
  RAISE NOTICE 'Script completado: customers.id ya no requiere referencia a auth.users';
END $$;
