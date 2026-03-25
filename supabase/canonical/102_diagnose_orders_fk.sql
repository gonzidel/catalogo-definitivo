-- 102_diagnose_orders_fk.sql
-- Script de diagnóstico para verificar foreign keys relacionadas con orders y customers
-- NO MODIFICA NADA, solo muestra información

DO $$
DECLARE
  fk_record record;
BEGIN
  RAISE NOTICE '═══════════════════════════════════════════════════════════';
  RAISE NOTICE 'DIAGNÓSTICO: Foreign Keys Relacionadas con orders y customers';
  RAISE NOTICE '═══════════════════════════════════════════════════════════';
  RAISE NOTICE '';

  -- 1. Foreign keys de orders.customer_id
  RAISE NOTICE '1. FOREIGN KEYS DE orders.customer_id:';
  RAISE NOTICE '───────────────────────────────────────────────────────────';
  
  FOR fk_record IN
    SELECT 
      conname as constraint_name,
      conrelid::regclass::text as source_table,
      confrelid::regclass::text as target_table,
      pg_get_constraintdef(oid) as definition
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
    RAISE NOTICE '  Constraint: %', fk_record.constraint_name;
    RAISE NOTICE '  Tabla origen: %', fk_record.source_table;
    RAISE NOTICE '  Tabla destino: %', fk_record.target_table;
    RAISE NOTICE '  Definición: %', fk_record.definition;
    
    -- Verificar si referencia auth.users (PROBLEMA)
    IF fk_record.target_table = 'auth.users' THEN
      RAISE NOTICE '  ⚠️  PROBLEMA DETECTADO: Esta FK referencia auth.users directamente';
    ELSIF fk_record.target_table = 'public.customers' THEN
      RAISE NOTICE '  ✓ Correcto: Esta FK referencia customers';
    END IF;
    RAISE NOTICE '';
  END LOOP;
  
  IF NOT FOUND THEN
    RAISE NOTICE '  ⚠️  No se encontró foreign key para orders.customer_id';
    RAISE NOTICE '';
  END IF;

  -- 2. Foreign keys de customers.id
  RAISE NOTICE '2. FOREIGN KEYS DE customers.id:';
  RAISE NOTICE '───────────────────────────────────────────────────────────';
  
  FOR fk_record IN
    SELECT 
      conname as constraint_name,
      conrelid::regclass::text as source_table,
      confrelid::regclass::text as target_table,
      pg_get_constraintdef(oid) as definition
    FROM pg_constraint
    WHERE conrelid = 'public.customers'::regclass
      AND contype = 'f'  -- Foreign key
      AND array_length(conkey, 1) = 1
      AND conkey[1] = (
        SELECT attnum 
        FROM pg_attribute 
        WHERE attrelid = 'public.customers'::regclass 
        AND attname = 'id'
      )
  LOOP
    RAISE NOTICE '  Constraint: %', fk_record.constraint_name;
    RAISE NOTICE '  Tabla origen: %', fk_record.source_table;
    RAISE NOTICE '  Tabla destino: %', fk_record.target_table;
    RAISE NOTICE '  Definición: %', fk_record.definition;
    
    -- Verificar si referencia auth.users (PROBLEMA)
    IF fk_record.target_table = 'auth.users' THEN
      RAISE NOTICE '  ⚠️  PROBLEMA DETECTADO: customers.id referencia auth.users';
    ELSE
      RAISE NOTICE '  ✓ customers.id no referencia auth.users';
    END IF;
    RAISE NOTICE '';
  END LOOP;
  
  IF NOT FOUND THEN
    RAISE NOTICE '  ✓ No hay foreign keys en customers.id (correcto para clientes sin usuario)';
    RAISE NOTICE '';
  END IF;

  -- 3. Todas las foreign keys que referencian customers
  RAISE NOTICE '3. TODAS LAS FOREIGN KEYS QUE REFERENCIAN customers:';
  RAISE NOTICE '───────────────────────────────────────────────────────────';
  
  FOR fk_record IN
    SELECT 
      conname as constraint_name,
      conrelid::regclass::text as source_table,
      confrelid::regclass::text as target_table,
      pg_get_constraintdef(oid) as definition
    FROM pg_constraint
    WHERE confrelid = 'public.customers'::regclass
      AND contype = 'f'  -- Foreign key
  LOOP
    RAISE NOTICE '  Constraint: %', fk_record.constraint_name;
    RAISE NOTICE '  Tabla origen: %', fk_record.source_table;
    RAISE NOTICE '  Tabla destino: %', fk_record.target_table;
    RAISE NOTICE '  Definición: %', fk_record.definition;
    RAISE NOTICE '';
  END LOOP;
  
  IF NOT FOUND THEN
    RAISE NOTICE '  ⚠️  No se encontraron foreign keys que referencien customers';
    RAISE NOTICE '';
  END IF;

  -- 4. Resumen y recomendaciones
  RAISE NOTICE '═══════════════════════════════════════════════════════════';
  RAISE NOTICE 'RESUMEN Y RECOMENDACIONES:';
  RAISE NOTICE '═══════════════════════════════════════════════════════════';
  RAISE NOTICE '';
  RAISE NOTICE 'Si orders.customer_id referencia auth.users directamente:';
  RAISE NOTICE '  → Ejecutar: 103_fix_orders_customer_id_fk.sql';
  RAISE NOTICE '';
  RAISE NOTICE 'Si customers.id todavía referencia auth.users:';
  RAISE NOTICE '  → Ejecutar: 101_remove_customers_auth_users_fk_robust.sql';
  RAISE NOTICE '';
  RAISE NOTICE 'Si ambas están correctas pero el error persiste:';
  RAISE NOTICE '  → Revisar triggers, funciones o políticas RLS';
  RAISE NOTICE '';

EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Error durante diagnóstico: %', SQLERRM;
END $$;
