-- 08_cart_items_flexible.sql - Versión corregida sin errores de columnas
-- Solo agrega las columnas necesarias sin recrear la tabla

-- Verificar y agregar columnas flexibles a cart_items
DO $$
BEGIN
    -- Agregar columna product_name si no existe
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'cart_items' 
        AND column_name = 'product_name'
        AND table_schema = 'public'
    ) THEN
        ALTER TABLE public.cart_items 
        ADD COLUMN product_name text;
        RAISE NOTICE 'Columna product_name agregada';
    ELSE
        RAISE NOTICE 'Columna product_name ya existe';
    END IF;

    -- Agregar columna color si no existe
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'cart_items' 
        AND column_name = 'color'
        AND table_schema = 'public'
    ) THEN
        ALTER TABLE public.cart_items 
        ADD COLUMN color text;
        RAISE NOTICE 'Columna color agregada';
    ELSE
        RAISE NOTICE 'Columna color ya existe';
    END IF;

    -- Agregar columna size si no existe
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'cart_items' 
        AND column_name = 'size'
        AND table_schema = 'public'
    ) THEN
        ALTER TABLE public.cart_items 
        ADD COLUMN size text;
        RAISE NOTICE 'Columna size agregada';
    ELSE
        RAISE NOTICE 'Columna size ya existe';
    END IF;

    -- Agregar columna quantity si no existe (para compatibilidad con qty)
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'cart_items' 
        AND column_name = 'quantity'
        AND table_schema = 'public'
    ) THEN
        ALTER TABLE public.cart_items 
        ADD COLUMN quantity int;
        RAISE NOTICE 'Columna quantity agregada';
    ELSE
        RAISE NOTICE 'Columna quantity ya existe';
    END IF;

    -- Agregar columna imagen si no existe
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'cart_items' 
        AND column_name = 'imagen'
        AND table_schema = 'public'
    ) THEN
        ALTER TABLE public.cart_items 
        ADD COLUMN imagen text;
        RAISE NOTICE 'Columna imagen agregada';
    ELSE
        RAISE NOTICE 'Columna imagen ya existe';
    END IF;
END $$;

-- Crear función para sincronizar qty con quantity
CREATE OR REPLACE FUNCTION sync_cart_item_quantities()
RETURNS TRIGGER AS $$
BEGIN
    -- Si se actualiza qty, también actualizar quantity
    IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
        IF NEW.qty IS NOT NULL AND NEW.quantity IS NULL THEN
            NEW.quantity = NEW.qty;
        ELSIF NEW.quantity IS NOT NULL AND NEW.qty IS NULL THEN
            NEW.qty = NEW.quantity;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Crear trigger para sincronizar cantidades si no existe
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger 
        WHERE tgname = 'sync_cart_item_quantities_trigger'
    ) THEN
        CREATE TRIGGER sync_cart_item_quantities_trigger
            BEFORE INSERT OR UPDATE ON public.cart_items
            FOR EACH ROW
            EXECUTE FUNCTION sync_cart_item_quantities();
        RAISE NOTICE 'Trigger sync_cart_item_quantities_trigger creado';
    ELSE
        RAISE NOTICE 'Trigger sync_cart_item_quantities_trigger ya existe';
    END IF;
END $$;

-- Función simple para obtener carrito del usuario
CREATE OR REPLACE FUNCTION get_user_cart(user_id uuid)
RETURNS TABLE (
    cart_id uuid,
    status text,
    created_at timestamptz
) AS $$
BEGIN
    RETURN QUERY
    SELECT c.id, c.status, c.created_at
    FROM public.carts c
    WHERE c.customer_id = user_id
    AND c.status = 'open'
    ORDER BY c.created_at DESC
    LIMIT 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Función simple para obtener items del carrito (sin created_at problemático)
CREATE OR REPLACE FUNCTION get_cart_items_simple(cart_uuid uuid)
RETURNS TABLE (
    id uuid,
    product_name text,
    color text,
    size text,
    quantity int,
    price_snapshot numeric,
    status text,
    imagen text
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        ci.id,
        ci.product_name,
        ci.color,
        ci.size,
        COALESCE(ci.quantity, ci.qty) as quantity,
        ci.price_snapshot,
        ci.status,
        ci.imagen
    FROM public.cart_items ci
    WHERE ci.cart_id = cart_uuid
    ORDER BY ci.id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Función para limpiar items del carrito
CREATE OR REPLACE FUNCTION clear_cart_items(cart_uuid uuid)
RETURNS void AS $$
BEGIN
    DELETE FROM public.cart_items WHERE cart_id = cart_uuid;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Función para agregar item al carrito
CREATE OR REPLACE FUNCTION add_cart_item(
    cart_uuid uuid,
    product_name_param text,
    color_param text,
    size_param text,
    quantity_param int,
    price_param numeric
)
RETURNS uuid AS $$
DECLARE
    item_id uuid;
BEGIN
    INSERT INTO public.cart_items (
        cart_id,
        product_name,
        color,
        size,
        quantity,
        qty,
        price_snapshot,
        status
    ) VALUES (
        cart_uuid,
        product_name_param,
        color_param,
        size_param,
        quantity_param,
        quantity_param,
        price_param,
        'reserved'
    ) RETURNING id INTO item_id;
    
    RETURN item_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Crear vista simple para carrito del usuario (sin created_at problemático)
CREATE OR REPLACE VIEW user_cart_view_simple AS
SELECT 
    c.id as cart_id,
    c.customer_id,
    c.status as cart_status,
    c.created_at as cart_created_at,
    ci.id as item_id,
    ci.product_name,
    ci.color,
    ci.size,
    COALESCE(ci.quantity, ci.qty) as quantity,
    ci.price_snapshot,
    ci.status as item_status
FROM public.carts c
LEFT JOIN public.cart_items ci ON c.id = ci.cart_id
WHERE c.customer_id = auth.uid()
AND c.status = 'open';

-- Habilitar RLS en la vista
ALTER VIEW user_cart_view_simple SET (security_invoker = true);

-- Crear índices para mejorar rendimiento
CREATE INDEX IF NOT EXISTS idx_cart_items_cart_id 
ON public.cart_items(cart_id);

CREATE INDEX IF NOT EXISTS idx_cart_items_product_name 
ON public.cart_items(product_name);

-- Verificar estructura final
SELECT 
    column_name,
    data_type,
    is_nullable
FROM information_schema.columns 
WHERE table_name = 'cart_items' 
AND table_schema = 'public'
ORDER BY ordinal_position;

-- Notificar recarga del esquema
SELECT pg_notify('pgrst','reload schema');
