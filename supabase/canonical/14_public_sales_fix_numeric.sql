-- 14_public_sales_fix_numeric.sql — Fix numérico urgente para overflow
-- Este script corrige TODOS los campos numéricos que pueden causar overflow

-- ============================================
-- PARTE 1: Verificar y corregir campos en public_sales
-- ============================================

-- Aumentar precisión de total_amount
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'public_sales' 
    AND column_name = 'total_amount'
  ) THEN
    ALTER TABLE public.public_sales 
      ALTER COLUMN total_amount TYPE numeric(15,2);
    RAISE NOTICE '✅ total_amount actualizado a numeric(15,2)';
  END IF;
END $$;

-- Aumentar precisión de credit_used
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'public_sales' 
    AND column_name = 'credit_used'
  ) THEN
    ALTER TABLE public.public_sales 
      ALTER COLUMN credit_used TYPE numeric(15,2);
    RAISE NOTICE '✅ credit_used actualizado a numeric(15,2)';
  END IF;
END $$;

-- ============================================
-- PARTE 2: Verificar y corregir campos en public_sales_customer_credits
-- ============================================

-- Aumentar precisión de amount
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'public_sales_customer_credits' 
    AND column_name = 'amount'
  ) THEN
    ALTER TABLE public.public_sales_customer_credits 
      ALTER COLUMN amount TYPE numeric(15,2);
    RAISE NOTICE '✅ amount en public_sales_customer_credits actualizado a numeric(15,2)';
  END IF;
END $$;

-- ============================================
-- PARTE 3: Verificar y corregir campos en public_sale_items
-- ============================================

-- Aumentar precisión de price_snapshot
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'public_sale_items' 
    AND column_name = 'price_snapshot'
  ) THEN
    ALTER TABLE public.public_sale_items 
      ALTER COLUMN price_snapshot TYPE numeric(15,2);
    RAISE NOTICE '✅ price_snapshot actualizado a numeric(15,2)';
  END IF;
END $$;

-- ============================================
-- PARTE 4: Verificar tipos de datos actuales (para diagnóstico)
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
  
  RAISE NOTICE '📊 Tipos de datos actuales:';
  RAISE NOTICE '   public_sales.total_amount: %', v_total_amount_type;
  RAISE NOTICE '   public_sales.credit_used: %', v_credit_used_type;
  RAISE NOTICE '   public_sales_customer_credits.amount: %', v_amount_type;
  RAISE NOTICE '   public_sale_items.price_snapshot: %', v_price_snapshot_type;
END $$;

