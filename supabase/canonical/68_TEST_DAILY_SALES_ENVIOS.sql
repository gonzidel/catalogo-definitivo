-- 68_TEST_DAILY_SALES_ENVIOS.sql — Probar que la solución funciona correctamente

-- PASO 1: Verificar función rpc_mark_order_as_sent
SELECT 
  proname as funcion,
  CASE 
    WHEN proname = 'rpc_mark_order_as_sent' THEN '✅ Existe'
    ELSE '❌ No existe'
  END as estado
FROM pg_proc
WHERE proname = 'rpc_mark_order_as_sent';

-- PASO 2: Verificar política RLS
SELECT 
  policyname,
  cmd,
  CASE 
    WHEN with_check LIKE '%created_by IS NULL%' THEN '✅ Permite created_by NULL'
    ELSE '⚠️ Revisar política'
  END as politica_check
FROM pg_policies
WHERE tablename = 'daily_sales'
ORDER BY policyname;

-- PASO 3: Obtener un pedido cerrado para probar
SELECT 
  o.id,
  o.order_number,
  o.status,
  o.sent_at,
  o.total_amount,
  COUNT(oi.id) as items_count,
  'Listo para probar' as estado
FROM public.orders o
LEFT JOIN public.order_items oi ON oi.order_id = o.id AND oi.status != 'cancelled'
WHERE o.status = 'closed'
  AND o.sent_at IS NULL
GROUP BY o.id, o.order_number, o.status, o.sent_at, o.total_amount
ORDER BY o.updated_at DESC
LIMIT 1;

-- PASO 4: Ver registros actuales en daily_sales de hoy (envios)
SELECT 
  COUNT(*) as total_envios_hoy,
  COALESCE(SUM(sale_amount), 0) as monto_total_envios_hoy
FROM public.daily_sales
WHERE sale_type = 'envios'
  AND sale_date = CURRENT_DATE;

-- PASO 5: Ver los últimos 5 registros de envíos de hoy
SELECT 
  ds.sale_date,
  ds.sale_time,
  ds.customer_name,
  ds.product_quantity,
  ds.sale_amount,
  ds.created_at
FROM public.daily_sales ds
WHERE ds.sale_type = 'envios'
  AND ds.sale_date = CURRENT_DATE
ORDER BY ds.created_at DESC
LIMIT 5;

-- PASO 6: Instrucciones para probar manualmente
DO $$
BEGIN
  RAISE NOTICE '🧪 ========================================';
  RAISE NOTICE '🧪 INSTRUCCIONES PARA PROBAR:';
  RAISE NOTICE '🧪 ========================================';
  RAISE NOTICE '';
  RAISE NOTICE '1. Ve a http://localhost:5500/admin/orders.html';
  RAISE NOTICE '2. Busca un pedido con status "Cerrado"';
  RAISE NOTICE '3. Haz clic en el botón "TERMINADO"';
  RAISE NOTICE '4. Ve a http://localhost:5500/admin/daily-sales.html';
  RAISE NOTICE '5. Verifica que el pedido aparece en la lista de envíos';
  RAISE NOTICE '';
  RAISE NOTICE '✅ Si aparece, la solución funciona correctamente';
  RAISE NOTICE '❌ Si no aparece, revisa los logs de Supabase para ver errores';
  RAISE NOTICE '';
END $$;

