-- supabase/fix_cart_items_schema.sql - Corregir esquema de cart_items

-- Verificar si la columna status existe
DO $$
BEGIN
    -- Verificar si la columna status existe en cart_items
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'cart_items' 
        AND column_name = 'status'
        AND table_schema = 'public'
    ) THEN
        -- Agregar la columna status si no existe
        ALTER TABLE public.cart_items 
        ADD COLUMN status text NOT NULL DEFAULT 'reserved';
        
        RAISE NOTICE 'Columna status agregada a cart_items';
    ELSE
        RAISE NOTICE 'Columna status ya existe en cart_items';
    END IF;
END $$;

-- Verificar si la columna price_snapshot existe
DO $$
BEGIN
    -- Verificar si la columna price_snapshot existe en cart_items
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'cart_items' 
        AND column_name = 'price_snapshot'
        AND table_schema = 'public'
    ) THEN
        -- Agregar la columna price_snapshot si no existe
        ALTER TABLE public.cart_items 
        ADD COLUMN price_snapshot numeric;
        
        RAISE NOTICE 'Columna price_snapshot agregada a cart_items';
    ELSE
        RAISE NOTICE 'Columna price_snapshot ya existe en cart_items';
    END IF;
END $$;

-- Verificar si la columna reserved_qty existe en product_variants
DO $$
BEGIN
    -- Verificar si la columna reserved_qty existe en product_variants
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'product_variants' 
        AND column_name = 'reserved_qty'
        AND table_schema = 'public'
    ) THEN
        -- Agregar la columna reserved_qty si no existe
        ALTER TABLE public.product_variants 
        ADD COLUMN reserved_qty int DEFAULT 0;
        
        RAISE NOTICE 'Columna reserved_qty agregada a product_variants';
    ELSE
        RAISE NOTICE 'Columna reserved_qty ya existe en product_variants';
    END IF;
END $$;

-- Verificar estructura completa de cart_items
SELECT 
    column_name,
    data_type,
    is_nullable,
    column_default
FROM information_schema.columns 
WHERE table_name = 'cart_items' 
AND table_schema = 'public'
ORDER BY ordinal_position;
