-- 103_fix_orders_customer_id_fk.sql
-- Corregir foreign key de orders.customer_id para que referencie customers.id en lugar de auth.users
-- Script idempotente y seguro

DO $$
DECLARE
  fk_record record;
  fk_name text;
  fk_found boolean := false;
  needs_fix boolean := false;
BEGIN
  RAISE NOTICE '═══════════════════════════════════════════════════════════';
  RAISE NOTICE 'CORRECCIÓN: Foreign Key de orders.customer_id';
  RAISE NOTICE '═══════════════════════════════════════════════════════════';
  RAISE NOTICE '';

  -- 1. Verificar si orders.customer_id tiene foreign key que referencia auth.users (INCORRECTO)
  RAISE NOTICE '1. Verificando foreign keys de orders.customer_id...';
  
  FOR fk_record IN
    SELECT 
      conname as constraint_name,
      confrelid::regclass::text as target_table
    FROM pg_constraint
    WHERE conrelid = 'public.orders'::regclass
      AND contype = 'f'  -- Foreign key
      AND array_length(conkey, 1) = 1
      AND conkey[1] = (
        SELECT attnum 
        FROM pg_attribute 
        WHERE attrelid = 'public.orders'::regclass 
        AND attname = 'customer_id'
      )
  LOOP
    fk_found := true;
    fk_name := fk_record.constraint_name;
    
    RAISE NOTICE '  Encontrada FK: % → %', fk_name, fk_record.target_table;
    
    IF fk_record.target_table = 'auth.users' THEN
      needs_fix := true;
      RAISE NOTICE '  ⚠️  PROBLEMA: Esta FK referencia auth.users (incorrecto)';
      RAISE NOTICE '  → Eliminando foreign key incorrecta...';
      
      BEGIN
        EXECUTE format('ALTER TABLE public.orders DROP CONSTRAINT %I', fk_name);
        RAISE NOTICE '  ✓ Foreign key eliminada: %', fk_name;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING '  ✗ Error al eliminar FK %: %', fk_name, SQLERRM;
      END;
      
    ELSIF fk_record.target_table = 'public.customers' THEN
      RAISE NOTICE '  ✓ Correcto: Esta FK ya referencia customers';
    ELSE
      RAISE NOTICE '  ⚠️  Referencia inesperada: %', fk_record.target_table;
    END IF;
  END LOOP;
  
  IF NOT fk_found THEN
    RAISE NOTICE '  ⚠️  No se encontró foreign key para orders.customer_id';
    needs_fix := true;
  END IF;

  -- 2. Crear foreign key correcta si es necesario
  IF needs_fix THEN
    RAISE NOTICE '';
    RAISE NOTICE '2. Creando foreign key correcta (orders.customer_id → customers.id)...';
    
    BEGIN
      -- Verificar que no exista ya una FK correcta
      IF NOT EXISTS (
        SELECT 1 
        FROM pg_constraint
        WHERE conrelid = 'public.orders'::regclass
          AND contype = 'f'
          AND confrelid = 'public.customers'::regclass
          AND array_length(conkey, 1) = 1
          AND conkey[1] = (
            SELECT attnum 
            FROM pg_attribute 
            WHERE attrelid = 'public.orders'::regclass 
            AND attname = 'customer_id'
          )
      ) THEN
        ALTER TABLE public.orders
        ADD CONSTRAINT orders_customer_id_fkey 
        FOREIGN KEY (customer_id) 
        REFERENCES public.customers(id) 
        ON DELETE CASCADE;
        
        RAISE NOTICE '  ✓ Foreign key correcta creada: orders_customer_id_fkey';
      ELSE
        RAISE NOTICE '  ✓ Foreign key correcta ya existe';
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '  ✗ Error al crear FK: %', SQLERRM;
    END;
  END IF;

  -- 3. Verificar que customers.id NO tenga foreign key a auth.users
  RAISE NOTICE '';
  RAISE NOTICE '3. Verificando que customers.id NO referencia auth.users...';
  
  IF EXISTS (
    SELECT 1 
    FROM pg_constraint
    WHERE conrelid = 'public.customers'::regclass
      AND contype = 'f'
      AND confrelid = 'auth.users'::regclass
      AND array_length(conkey, 1) = 1
      AND conkey[1] = (
        SELECT attnum 
        FROM pg_attribute 
        WHERE attrelid = 'public.customers'::regclass 
        AND attname = 'id'
      )
  ) THEN
    RAISE NOTICE '  ⚠️  PROBLEMA: customers.id todavía referencia auth.users';
    RAISE NOTICE '  → Ejecutar primero: 101_remove_customers_auth_users_fk_robust.sql';
  ELSE
    RAISE NOTICE '  ✓ customers.id no referencia auth.users (correcto)';
  END IF;

  -- 4. Verificación final
  RAISE NOTICE '';
  RAISE NOTICE '4. Verificación final...';
  
  IF EXISTS (
    SELECT 1 
    FROM pg_constraint
    WHERE conrelid = 'public.orders'::regclass
      AND contype = 'f'
      AND confrelid = 'public.customers'::regclass
      AND array_length(conkey, 1) = 1
      AND conkey[1] = (
        SELECT attnum 
        FROM pg_attribute 
        WHERE attrelid = 'public.orders'::regclass 
        AND attname = 'customer_id'
      )
  ) THEN
    RAISE NOTICE '  ✓ orders.customer_id → customers.id: CORRECTO';
  ELSE
    RAISE WARNING '  ✗ orders.customer_id → customers.id: NO EXISTE';
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 
    FROM pg_constraint
    WHERE conrelid = 'public.orders'::regclass
      AND contype = 'f'
      AND confrelid = 'auth.users'::regclass
      AND array_length(conkey, 1) = 1
      AND conkey[1] = (
        SELECT attnum 
        FROM pg_attribute 
        WHERE attrelid = 'public.orders'::regclass 
        AND attname = 'customer_id'
      )
  ) THEN
    RAISE NOTICE '  ✓ orders.customer_id NO referencia auth.users: CORRECTO';
  ELSE
    RAISE WARNING '  ✗ orders.customer_id todavía referencia auth.users: PROBLEMA';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '═══════════════════════════════════════════════════════════';
  RAISE NOTICE 'Script completado';
  RAISE NOTICE '═══════════════════════════════════════════════════════════';

EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Error durante corrección: %', SQLERRM;
END $$;

-- Recargar esquema del API REST
SELECT pg_notify('pgrst', 'reload schema');
