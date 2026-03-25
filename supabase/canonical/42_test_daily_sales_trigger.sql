-- 42_test_daily_sales_trigger.sql — Script de diagnóstico para el trigger de daily_sales
-- Este script ayuda a diagnosticar por qué los envíos no se registran en daily_sales

-- 1. Verificar que el trigger existe
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger 
    WHERE tgname = 'trigger_register_envio_sale'
  ) THEN
    RAISE NOTICE '✅ El trigger trigger_register_envio_sale existe';
  ELSE
    RAISE WARNING '❌ El trigger trigger_register_envio_sale NO existe';
  END IF;
END $$;

-- 2. Verificar que la función existe
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc 
    WHERE proname = 'register_envio_to_daily_sales'
    AND pronamespace = 'public'::regnamespace
  ) THEN
    RAISE NOTICE '✅ La función register_envio_to_daily_sales existe';
  ELSE
    RAISE WARNING '❌ La función register_envio_to_daily_sales NO existe';
  END IF;
END $$;

-- 3. Verificar pedidos marcados como "sent" que no están en daily_sales
SELECT 
  o.id,
  o.order_number,
  o.status,
  o.sent_at,
  o.sent_at::date as sent_date,
  o.total_amount,
  CASE 
    WHEN EXISTS (
      SELECT 1 FROM public.daily_sales ds
      WHERE ds.sale_date = o.sent_at::date
        AND ds.sale_type = 'envios'
        AND ds.customer_name = COALESCE(c.full_name, 'Cliente sin nombre')
    ) THEN '✅ Registrado'
    ELSE '❌ NO registrado'
  END as en_daily_sales,
  c.full_name as customer_name
FROM public.orders o
LEFT JOIN public.customers c ON c.id = o.customer_id
WHERE o.status = 'sent'
  AND o.sent_at IS NOT NULL
ORDER BY o.sent_at DESC
LIMIT 10;

-- 4. Contar pedidos "sent" vs registros en daily_sales
SELECT 
  (SELECT COUNT(*) FROM public.orders WHERE status = 'sent' AND sent_at IS NOT NULL) as pedidos_sent,
  (SELECT COUNT(*) FROM public.daily_sales WHERE sale_type = 'envios') as registros_daily_sales,
  (SELECT COUNT(*) FROM public.orders WHERE status = 'sent' AND sent_at IS NOT NULL) - 
  (SELECT COUNT(*) FROM public.daily_sales WHERE sale_type = 'envios') as diferencia;

-- 5. Mostrar los últimos 5 pedidos "sent" con detalles
SELECT 
  o.id,
  o.order_number,
  o.sent_at,
  o.sent_at::date as fecha_envio,
  o.sent_at::time as hora_envio,
  o.total_amount,
  (SELECT COUNT(*) FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status != 'cancelled') as cantidad_items,
  c.full_name as cliente
FROM public.orders o
LEFT JOIN public.customers c ON c.id = o.customer_id
WHERE o.status = 'sent'
  AND o.sent_at IS NOT NULL
ORDER BY o.sent_at DESC
LIMIT 5;

-- 6. Mostrar los últimos 5 registros en daily_sales de tipo "envios"
SELECT 
  ds.id,
  ds.sale_date,
  ds.sale_time,
  ds.customer_name,
  ds.product_quantity,
  ds.sale_amount,
  ds.created_at
FROM public.daily_sales ds
WHERE ds.sale_type = 'envios'
ORDER BY ds.sale_date DESC, ds.sale_time DESC
LIMIT 5;

-- 7. Instrucciones
DO $$
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '📋 DIAGNÓSTICO COMPLETADO';
  RAISE NOTICE '';
  RAISE NOTICE 'Si ves pedidos "sent" que NO están registrados en daily_sales:';
  RAISE NOTICE '  1. Ejecuta: SELECT rpc_sync_sent_orders_to_daily_sales();';
  RAISE NOTICE '  2. Esto sincronizará los pedidos que faltan';
  RAISE NOTICE '';
  RAISE NOTICE 'Para verificar que el trigger funciona:';
  RAISE NOTICE '  1. Marca un pedido como "sent" desde orders.html';
  RAISE NOTICE '  2. Verifica en daily_sales.html que aparezca automáticamente';
  RAISE NOTICE '  3. Si no aparece, revisa los logs de Supabase para ver los RAISE NOTICE del trigger';
END $$;

