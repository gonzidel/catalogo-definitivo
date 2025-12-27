-- 09_cart_persistent_functions.sql - Funciones corregidas para carrito persistente
-- Sin referencias a columnas que pueden no existir

-- Función para obtener o crear carrito del usuario
CREATE OR REPLACE FUNCTION get_or_create_user_cart(user_id uuid)
RETURNS uuid AS $$
DECLARE
    cart_id uuid;
BEGIN
    -- Buscar carrito abierto existente
    SELECT id INTO cart_id
    FROM public.carts
    WHERE customer_id = user_id
    AND status = 'open'
    ORDER BY created_at DESC
    LIMIT 1;
    
    -- Si no existe, crear uno nuevo
    IF cart_id IS NULL THEN
        INSERT INTO public.carts (customer_id, status)
        VALUES (user_id, 'open')
        RETURNING id INTO cart_id;
    END IF;
    
    RETURN cart_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Función para sincronizar carrito desde localStorage
CREATE OR REPLACE FUNCTION sync_cart_from_local(
    user_id uuid,
    cart_data jsonb
)
RETURNS void AS $$
DECLARE
    cart_id uuid;
    item_data jsonb;
BEGIN
    -- Obtener o crear carrito
    cart_id := get_or_create_user_cart(user_id);
    
    -- Limpiar items existentes
    DELETE FROM public.cart_items WHERE cart_id = cart_id;
    
    -- Insertar nuevos items
    FOR item_data IN SELECT * FROM jsonb_array_elements(cart_data)
    LOOP
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
            cart_id,
            item_data->>'articulo',
            item_data->>'color',
            item_data->>'talle',
            (item_data->>'cantidad')::int,
            (item_data->>'cantidad')::int,
            (item_data->>'precio')::numeric,
            'reserved'
        );
    END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Función para obtener carrito completo del usuario
CREATE OR REPLACE FUNCTION get_user_cart_complete(user_id uuid)
RETURNS TABLE (
    cart_id uuid,
    item_id uuid,
    product_name text,
    color text,
    size text,
    quantity int,
    price_snapshot numeric,
    status text
) AS $$
DECLARE
    user_cart_id uuid;
BEGIN
    -- Obtener carrito abierto del usuario
    SELECT id INTO user_cart_id
    FROM public.carts
    WHERE customer_id = user_id
    AND status = 'open'
    ORDER BY created_at DESC
    LIMIT 1;
    
    -- Si no hay carrito, retornar vacío
    IF user_cart_id IS NULL THEN
        RETURN;
    END IF;
    
    -- Retornar items del carrito
    RETURN QUERY
    SELECT 
        ci.cart_id,
        ci.id,
        ci.product_name,
        ci.color,
        ci.size,
        COALESCE(ci.quantity, ci.qty) as quantity,
        ci.price_snapshot,
        ci.status
    FROM public.cart_items ci
    WHERE ci.cart_id = user_cart_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Función para actualizar cantidad de item
CREATE OR REPLACE FUNCTION update_cart_item_quantity(
    item_id uuid,
    new_quantity int
)
RETURNS boolean AS $$
BEGIN
    UPDATE public.cart_items
    SET 
        quantity = new_quantity,
        qty = new_quantity,
        updated_at = now()
    WHERE id = item_id;
    
    RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Función para eliminar item del carrito
CREATE OR REPLACE FUNCTION remove_cart_item(item_id uuid)
RETURNS boolean AS $$
BEGIN
    DELETE FROM public.cart_items WHERE id = item_id;
    RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Función para obtener resumen del carrito
CREATE OR REPLACE FUNCTION get_cart_summary(user_id uuid)
RETURNS TABLE (
    total_items int,
    unique_products int,
    total_price numeric
) AS $$
DECLARE
    user_cart_id uuid;
BEGIN
    -- Obtener carrito abierto del usuario
    SELECT id INTO user_cart_id
    FROM public.carts
    WHERE customer_id = user_id
    AND status = 'open'
    ORDER BY created_at DESC
    LIMIT 1;
    
    -- Si no hay carrito, retornar ceros
    IF user_cart_id IS NULL THEN
        RETURN QUERY SELECT 0, 0, 0::numeric;
        RETURN;
    END IF;
    
    -- Calcular resumen
    RETURN QUERY
    SELECT 
        COALESCE(SUM(COALESCE(ci.quantity, ci.qty)), 0)::int as total_items,
        COUNT(ci.id)::int as unique_products,
        COALESCE(SUM(COALESCE(ci.quantity, ci.qty) * ci.price_snapshot), 0) as total_price
    FROM public.cart_items ci
    WHERE ci.cart_id = user_cart_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Función para limpiar carrito del usuario
CREATE OR REPLACE FUNCTION clear_user_cart(user_id uuid)
RETURNS boolean AS $$
DECLARE
    user_cart_id uuid;
BEGIN
    -- Obtener carrito abierto del usuario
    SELECT id INTO user_cart_id
    FROM public.carts
    WHERE customer_id = user_id
    AND status = 'open'
    ORDER BY created_at DESC
    LIMIT 1;
    
    -- Si no hay carrito, retornar false
    IF user_cart_id IS NULL THEN
        RETURN false;
    END IF;
    
    -- Eliminar todos los items
    DELETE FROM public.cart_items WHERE cart_id = user_cart_id;
    
    RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Función para cambiar estado del carrito
CREATE OR REPLACE FUNCTION change_cart_status(
    user_id uuid,
    new_status text
)
RETURNS boolean AS $$
DECLARE
    user_cart_id uuid;
BEGIN
    -- Obtener carrito abierto del usuario
    SELECT id INTO user_cart_id
    FROM public.carts
    WHERE customer_id = user_id
    AND status = 'open'
    ORDER BY created_at DESC
    LIMIT 1;
    
    -- Si no hay carrito, retornar false
    IF user_cart_id IS NULL THEN
        RETURN false;
    END IF;
    
    -- Actualizar estado
    UPDATE public.carts
    SET 
        status = new_status,
        updated_at = now()
    WHERE id = user_cart_id;
    
    RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Crear índices para mejorar rendimiento
CREATE INDEX IF NOT EXISTS idx_carts_customer_status 
ON public.carts(customer_id, status);

CREATE INDEX IF NOT EXISTS idx_cart_items_cart_id 
ON public.cart_items(cart_id);

-- Verificar que las funciones se crearon correctamente
DO $$
DECLARE
    func_count int;
BEGIN
    SELECT COUNT(*) INTO func_count
    FROM pg_proc 
    WHERE proname IN (
        'get_or_create_user_cart',
        'sync_cart_from_local',
        'get_user_cart_complete',
        'get_cart_summary',
        'clear_user_cart',
        'change_cart_status'
    );
    
    RAISE NOTICE 'Funciones creadas: % de 6', func_count;
    
    IF func_count = 6 THEN
        RAISE NOTICE 'Todas las funciones se crearon correctamente';
    ELSE
        RAISE NOTICE 'Algunas funciones no se pudieron crear';
    END IF;
END $$;

-- Notificar recarga del esquema
SELECT pg_notify('pgrst','reload schema');
