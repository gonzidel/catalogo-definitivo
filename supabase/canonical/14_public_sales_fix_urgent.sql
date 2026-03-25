-- 14_public_sales_fix_urgent.sql — Fix URGENTE para overflow numérico
-- Este script verifica y corrige TODOS los campos numéricos que pueden causar overflow
-- Ejecutar INMEDIATAMENTE si el error persiste

-- ============================================
-- PARTE 1: Verificar y corregir TODOS los campos numéricos
-- ============================================

-- Verificar y corregir public_sales.total_amount
DO $$
BEGIN
  -- Verificar tipo actual
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'public_sales' 
    AND column_name = 'total_amount'
    AND (
      data_type != 'numeric' 
      OR numeric_precision IS NULL 
      OR numeric_precision < 15
    )
  ) THEN
    ALTER TABLE public.public_sales 
      ALTER COLUMN total_amount TYPE numeric(15,2);
    RAISE NOTICE '✅ public_sales.total_amount actualizado a numeric(15,2)';
  ELSE
    RAISE NOTICE 'ℹ️ public_sales.total_amount ya tiene precisión correcta';
  END IF;
END $$;

-- Verificar y corregir public_sales.credit_used
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'public_sales' 
    AND column_name = 'credit_used'
    AND (
      data_type != 'numeric' 
      OR numeric_precision IS NULL 
      OR numeric_precision < 15
    )
  ) THEN
    ALTER TABLE public.public_sales 
      ALTER COLUMN credit_used TYPE numeric(15,2);
    RAISE NOTICE '✅ public_sales.credit_used actualizado a numeric(15,2)';
  ELSE
    RAISE NOTICE 'ℹ️ public_sales.credit_used ya tiene precisión correcta';
  END IF;
END $$;

-- Verificar y corregir public_sales_customer_credits.amount
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'public_sales_customer_credits' 
    AND column_name = 'amount'
    AND (
      data_type != 'numeric' 
      OR numeric_precision IS NULL 
      OR numeric_precision < 15
    )
  ) THEN
    ALTER TABLE public.public_sales_customer_credits 
      ALTER COLUMN amount TYPE numeric(15,2);
    RAISE NOTICE '✅ public_sales_customer_credits.amount actualizado a numeric(15,2)';
  ELSE
    RAISE NOTICE 'ℹ️ public_sales_customer_credits.amount ya tiene precisión correcta';
  END IF;
END $$;

-- Verificar y corregir public_sale_items.price_snapshot
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'public_sale_items' 
    AND column_name = 'price_snapshot'
    AND (
      data_type != 'numeric' 
      OR numeric_precision IS NULL 
      OR numeric_precision < 15
    )
  ) THEN
    ALTER TABLE public.public_sale_items 
      ALTER COLUMN price_snapshot TYPE numeric(15,2);
    RAISE NOTICE '✅ public_sale_items.price_snapshot actualizado a numeric(15,2)';
  ELSE
    RAISE NOTICE 'ℹ️ public_sale_items.price_snapshot ya tiene precisión correcta';
  END IF;
END $$;

-- ============================================
-- PARTE 2: Verificar tipos de datos actuales (DIAGNÓSTICO COMPLETO)
-- ============================================

DO $$
DECLARE
  v_total_amount_type text;
  v_credit_used_type text;
  v_amount_type text;
  v_price_snapshot_type text;
  v_total_amount_precision int;
  v_credit_used_precision int;
  v_amount_precision int;
  v_price_snapshot_precision int;
BEGIN
  -- Verificar tipo de total_amount
  SELECT 
    data_type || COALESCE('(' || numeric_precision || ',' || numeric_scale || ')', ''),
    numeric_precision
  INTO v_total_amount_type, v_total_amount_precision
  FROM information_schema.columns 
  WHERE table_schema = 'public' 
    AND table_name = 'public_sales' 
    AND column_name = 'total_amount';
  
  -- Verificar tipo de credit_used
  SELECT 
    data_type || COALESCE('(' || numeric_precision || ',' || numeric_scale || ')', ''),
    numeric_precision
  INTO v_credit_used_type, v_credit_used_precision
  FROM information_schema.columns 
  WHERE table_schema = 'public' 
    AND table_name = 'public_sales' 
    AND column_name = 'credit_used';
  
  -- Verificar tipo de amount
  SELECT 
    data_type || COALESCE('(' || numeric_precision || ',' || numeric_scale || ')', ''),
    numeric_precision
  INTO v_amount_type, v_amount_precision
  FROM information_schema.columns 
  WHERE table_schema = 'public' 
    AND table_name = 'public_sales_customer_credits' 
    AND column_name = 'amount';
  
  -- Verificar tipo de price_snapshot
  SELECT 
    data_type || COALESCE('(' || numeric_precision || ',' || numeric_scale || ')', ''),
    numeric_precision
  INTO v_price_snapshot_type, v_price_snapshot_precision
  FROM information_schema.columns 
  WHERE table_schema = 'public' 
    AND table_name = 'public_sale_items' 
    AND column_name = 'price_snapshot';
  
  RAISE NOTICE '========================================';
  RAISE NOTICE '📊 DIAGNÓSTICO DE TIPOS DE DATOS:';
  RAISE NOTICE '========================================';
  RAISE NOTICE '   public_sales.total_amount: % (precisión: %)', 
    v_total_amount_type, 
    COALESCE(v_total_amount_precision::text, 'NULL');
  RAISE NOTICE '   public_sales.credit_used: % (precisión: %)', 
    v_credit_used_type, 
    COALESCE(v_credit_used_precision::text, 'NULL');
  RAISE NOTICE '   public_sales_customer_credits.amount: % (precisión: %)', 
    v_amount_type, 
    COALESCE(v_amount_precision::text, 'NULL');
  RAISE NOTICE '   public_sale_items.price_snapshot: % (precisión: %)', 
    v_price_snapshot_type, 
    COALESCE(v_price_snapshot_precision::text, 'NULL');
  RAISE NOTICE '========================================';
  
  -- Verificar si hay campos con precisión insuficiente
  IF v_total_amount_precision IS NOT NULL AND v_total_amount_precision < 15 THEN
    RAISE WARNING '⚠️ ADVERTENCIA: total_amount tiene precisión insuficiente (%)', v_total_amount_precision;
  END IF;
  
  IF v_credit_used_precision IS NOT NULL AND v_credit_used_precision < 15 THEN
    RAISE WARNING '⚠️ ADVERTENCIA: credit_used tiene precisión insuficiente (%)', v_credit_used_precision;
  END IF;
  
  IF v_amount_precision IS NOT NULL AND v_amount_precision < 15 THEN
    RAISE WARNING '⚠️ ADVERTENCIA: amount tiene precisión insuficiente (%)', v_amount_precision;
  END IF;
  
  IF v_price_snapshot_precision IS NOT NULL AND v_price_snapshot_precision < 15 THEN
    RAISE WARNING '⚠️ ADVERTENCIA: price_snapshot tiene precisión insuficiente (%)', v_price_snapshot_precision;
  END IF;
END $$;

-- ============================================
-- PARTE 3: Forzar actualización de campos (si es necesario)
-- ============================================

-- Forzar actualización de total_amount (sin verificar, directamente)
DO $$
BEGIN
  BEGIN
    ALTER TABLE public.public_sales 
      ALTER COLUMN total_amount TYPE numeric(15,2);
    RAISE NOTICE '✅ total_amount forzado a numeric(15,2)';
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '⚠️ Error actualizando total_amount: %', SQLERRM;
  END;
END $$;

-- Forzar actualización de credit_used
DO $$
BEGIN
  BEGIN
    ALTER TABLE public.public_sales 
      ALTER COLUMN credit_used TYPE numeric(15,2);
    RAISE NOTICE '✅ credit_used forzado a numeric(15,2)';
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '⚠️ Error actualizando credit_used: %', SQLERRM;
  END;
END $$;

-- Forzar actualización de amount
DO $$
BEGIN
  BEGIN
    ALTER TABLE public.public_sales_customer_credits 
      ALTER COLUMN amount TYPE numeric(15,2);
    RAISE NOTICE '✅ amount forzado a numeric(15,2)';
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '⚠️ Error actualizando amount: %', SQLERRM;
  END;
END $$;

-- Forzar actualización de price_snapshot
DO $$
BEGIN
  BEGIN
    ALTER TABLE public.public_sale_items 
      ALTER COLUMN price_snapshot TYPE numeric(15,2);
    RAISE NOTICE '✅ price_snapshot forzado a numeric(15,2)';
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '⚠️ Error actualizando price_snapshot: %', SQLERRM;
  END;
END $$;

-- ============================================
-- PARTE 4: Verificar tipos después de la actualización
-- ============================================

DO $$
DECLARE
  v_total_amount_type text;
  v_credit_used_type text;
  v_amount_type text;
  v_price_snapshot_type text;
BEGIN
  -- Verificar tipo de total_amount
  SELECT data_type || '(' || numeric_precision || ',' || numeric_scale || ')' 
  INTO v_total_amount_type
  FROM information_schema.columns 
  WHERE table_schema = 'public' 
    AND table_name = 'public_sales' 
    AND column_name = 'total_amount';
  
  -- Verificar tipo de credit_used
  SELECT data_type || '(' || numeric_precision || ',' || numeric_scale || ')' 
  INTO v_credit_used_type
  FROM information_schema.columns 
  WHERE table_schema = 'public' 
    AND table_name = 'public_sales' 
    AND column_name = 'credit_used';
  
  -- Verificar tipo de amount
  SELECT data_type || '(' || numeric_precision || ',' || numeric_scale || ')' 
  INTO v_amount_type
  FROM information_schema.columns 
  WHERE table_schema = 'public' 
    AND table_name = 'public_sales_customer_credits' 
    AND column_name = 'amount';
  
  -- Verificar tipo de price_snapshot
  SELECT data_type || '(' || numeric_precision || ',' || numeric_scale || ')' 
  INTO v_price_snapshot_type
  FROM information_schema.columns 
  WHERE table_schema = 'public' 
    AND table_name = 'public_sale_items' 
    AND column_name = 'price_snapshot';
  
  RAISE NOTICE '========================================';
  RAISE NOTICE '✅ TIPOS DE DATOS DESPUÉS DEL FIX:';
  RAISE NOTICE '========================================';
  RAISE NOTICE '   public_sales.total_amount: %', v_total_amount_type;
  RAISE NOTICE '   public_sales.credit_used: %', v_credit_used_type;
  RAISE NOTICE '   public_sales_customer_credits.amount: %', v_amount_type;
  RAISE NOTICE '   public_sale_items.price_snapshot: %', v_price_snapshot_type;
  RAISE NOTICE '========================================';
  
  -- Verificar que todos tienen precisión 15
  IF v_total_amount_type NOT LIKE 'numeric(15,2)%' THEN
    RAISE EXCEPTION '❌ ERROR: total_amount NO tiene numeric(15,2). Tipo actual: %', v_total_amount_type;
  END IF;
  
  IF v_credit_used_type NOT LIKE 'numeric(15,2)%' THEN
    RAISE EXCEPTION '❌ ERROR: credit_used NO tiene numeric(15,2). Tipo actual: %', v_credit_used_type;
  END IF;
  
  IF v_amount_type NOT LIKE 'numeric(15,2)%' THEN
    RAISE EXCEPTION '❌ ERROR: amount NO tiene numeric(15,2). Tipo actual: %', v_amount_type;
  END IF;
  
  IF v_price_snapshot_type NOT LIKE 'numeric(15,2)%' THEN
    RAISE EXCEPTION '❌ ERROR: price_snapshot NO tiene numeric(15,2). Tipo actual: %', v_price_snapshot_type;
  END IF;
  
  RAISE NOTICE '✅ TODOS los campos tienen numeric(15,2) correctamente';
END $$;

