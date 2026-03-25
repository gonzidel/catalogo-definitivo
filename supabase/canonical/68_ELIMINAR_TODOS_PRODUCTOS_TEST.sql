-- 68_ELIMINAR_TODOS_PRODUCTOS_TEST.sql
-- ⚠️ ADVERTENCIA: Este script elimina TODOS los productos y sus datos relacionados
-- ⚠️ Solo ejecutar si estás seguro de que quieres eliminar todos los productos de prueba

-- Este script elimina:
-- - Todos los productos (products)
-- - Todas las variantes (product_variants) 
-- - Todas las imágenes de variantes (variant_images)
-- - Todas las etiquetas de productos (product_tags)
-- - Todos los detalles de etiquetas (product_tag_details)
-- - Todos los items del carrito relacionados (cart_items)
-- - Todas las ofertas y promociones relacionadas (offers, promotion_products)
-- - Todos los items de pedidos relacionados (order_items)
-- - Todos los items de ventas públicas relacionadas (public_sale_items)
-- - Todos los items de pedidos locales relacionados (local_order_items)
-- - Todos los stocks en almacenes relacionados (warehouse_stocks, stock_movements)

-- PASO 1: Verificar qué productos existen antes de eliminar
DO $$
DECLARE
  product_count int;
  variant_count int;
  image_count int;
BEGIN
  SELECT COUNT(*) INTO product_count FROM public.products;
  SELECT COUNT(*) INTO variant_count FROM public.product_variants;
  SELECT COUNT(*) INTO image_count FROM public.variant_images;
  
  RAISE NOTICE '📊 Productos a eliminar: %', product_count;
  RAISE NOTICE '📊 Variantes a eliminar: %', variant_count;
  RAISE NOTICE '📊 Imágenes a eliminar: %', image_count;
END $$;

-- PASO 2: Eliminar datos en tablas que pueden tener RESTRICT (sin CASCADE)
-- PRIMERO: Eliminar cart_items (debe hacerse antes de product_variants)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables 
             WHERE table_schema = 'public' AND table_name = 'cart_items') THEN
    DELETE FROM public.cart_items 
    WHERE variant_id IN (SELECT id FROM public.product_variants);
    RAISE NOTICE '✅ Eliminados items del carrito';
  END IF;
END $$;

-- Segundo: Eliminar public_sale_items que referencian variants (nombre correcto sin 's')
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables 
             WHERE table_schema = 'public' AND table_name = 'public_sale_items') THEN
    DELETE FROM public.public_sale_items 
    WHERE variant_id IN (SELECT id FROM public.product_variants);
    RAISE NOTICE '✅ Eliminados items de ventas públicas';
  END IF;
END $$;

-- Eliminar local_order_items que pueden referenciar variants
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables 
             WHERE table_schema = 'public' AND table_name = 'local_order_items') THEN
    DELETE FROM public.local_order_items 
    WHERE variant_id IN (SELECT id FROM public.product_variants);
    RAISE NOTICE '✅ Eliminados items de pedidos locales';
  END IF;
END $$;

-- Eliminar order_items que pueden referenciar variants
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables 
             WHERE table_schema = 'public' AND table_name = 'order_items') THEN
    DELETE FROM public.order_items 
    WHERE variant_id IN (SELECT id FROM public.product_variants);
    RAISE NOTICE '✅ Eliminados items de pedidos';
  END IF;
END $$;

-- Eliminar warehouse_stocks y stock_movements
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables 
             WHERE table_schema = 'public' AND table_name = 'warehouse_stocks') THEN
    DELETE FROM public.warehouse_stocks 
    WHERE variant_id IN (SELECT id FROM public.product_variants);
    RAISE NOTICE '✅ Eliminados stocks de almacenes';
  END IF;
  
  IF EXISTS (SELECT 1 FROM information_schema.tables 
             WHERE table_schema = 'public' AND table_name = 'stock_movements') THEN
    DELETE FROM public.stock_movements 
    WHERE variant_id IN (SELECT id FROM public.product_variants);
    RAISE NOTICE '✅ Eliminados movimientos de stock';
  END IF;
END $$;

-- Eliminar variant_sizes si existe
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables 
             WHERE table_schema = 'public' AND table_name = 'variant_sizes') THEN
    DELETE FROM public.variant_sizes 
    WHERE variant_id IN (SELECT id FROM public.product_variants);
    RAISE NOTICE '✅ Eliminados tamaños de variantes';
  END IF;
END $$;

-- Eliminar promotion_products y offers relacionadas
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables 
             WHERE table_schema = 'public' AND table_name = 'promotion_products') THEN
    DELETE FROM public.promotion_products 
    WHERE product_id IN (SELECT id FROM public.products)
       OR variant_id IN (SELECT id FROM public.product_variants);
    RAISE NOTICE '✅ Eliminados productos de promociones';
  END IF;
  
  IF EXISTS (SELECT 1 FROM information_schema.tables 
             WHERE table_schema = 'public' AND table_name = 'offers') THEN
    DELETE FROM public.offers 
    WHERE product_id IN (SELECT id FROM public.products);
    RAISE NOTICE '✅ Eliminadas ofertas';
  END IF;
END $$;

-- PASO 3: Eliminar productos (esto eliminará automáticamente con CASCADE):
-- - product_variants (si tiene CASCADE)
-- - variant_images (si tiene CASCADE)
-- - product_tags (tiene CASCADE)
-- - product_tag_details (tiene CASCADE)
-- - cart_items (tiene CASCADE con variants)

-- Eliminar todas las imágenes de variantes primero (por si no tienen CASCADE)
DELETE FROM public.variant_images 
WHERE variant_id IN (SELECT id FROM public.product_variants);

-- Eliminar todas las variantes (por si no tienen CASCADE con products)
DELETE FROM public.product_variants;

-- Eliminar todas las etiquetas de productos (tienen CASCADE, pero por seguridad)
DELETE FROM public.product_tags;
DELETE FROM public.product_tag_details;

-- Finalmente, eliminar todos los productos
DELETE FROM public.products;

-- PASO 4: Verificar que se eliminó todo
DO $$
DECLARE
  product_count int;
  variant_count int;
  image_count int;
BEGIN
  SELECT COUNT(*) INTO product_count FROM public.products;
  SELECT COUNT(*) INTO variant_count FROM public.product_variants;
  SELECT COUNT(*) INTO image_count FROM public.variant_images;
  
  IF product_count = 0 AND variant_count = 0 AND image_count = 0 THEN
    RAISE NOTICE '✅ ÉXITO: Todos los productos, variantes e imágenes han sido eliminados';
  ELSE
    RAISE WARNING '⚠️ ADVERTENCIA: Quedan algunos registros - Productos: %, Variantes: %, Imágenes: %', 
                  product_count, variant_count, image_count;
  END IF;
END $$;

-- Recargar el esquema del API REST
SELECT pg_notify('pgrst','reload schema');

-- Mensaje final
DO $$
BEGIN
  RAISE NOTICE '🎉 Proceso completado. La base de datos está lista para cargar productos reales.';
END $$;

