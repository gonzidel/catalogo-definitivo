-- Recargar API después de todos los cambios
select pg_notify('pgrst','reload schema');

-- Verificar que las funciones del carrito persistente estén disponibles
DO $$
BEGIN
    -- Verificar función get_or_create_user_cart
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc 
        WHERE proname = 'get_or_create_user_cart'
    ) THEN
        RAISE NOTICE 'Función get_or_create_user_cart no encontrada';
    ELSE
        RAISE NOTICE 'Función get_or_create_user_cart disponible';
    END IF;
    
    -- Verificar función sync_cart_from_local
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc 
        WHERE proname = 'sync_cart_from_local'
    ) THEN
        RAISE NOTICE 'Función sync_cart_from_local no encontrada';
    ELSE
        RAISE NOTICE 'Función sync_cart_from_local disponible';
    END IF;
    
    -- Verificar función get_user_cart_complete
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc 
        WHERE proname = 'get_user_cart_complete'
    ) THEN
        RAISE NOTICE 'Función get_user_cart_complete no encontrada';
    ELSE
        RAISE NOTICE 'Función get_user_cart_complete disponible';
    END IF;
END $$;

