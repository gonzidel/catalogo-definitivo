-- 66_TEST_TRIGGER_ENVIOS.sql — Probar que el trigger funciona correctamente
-- Este script prueba el trigger después de aplicar la corrección

-- PASO 1: Verificar estado del trigger
SELECT 
  tgname as trigger_name,
  CASE tgenabled
    WHEN 'O' THEN '✅ Activo'
    WHEN 'D' THEN '❌ Deshabilitado'
    ELSE '⚠️ Estado: ' || tgenabled::text
  END as estado
FROM pg_trigger
WHERE tgname = 'trigger_register_envio_sale'
  AND tgrelid = 'public.orders'::regclass;

-- PASO 2: Obtener un pedido cerrado para probar
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

-- PASO 3: Probar el trigger (simular finalizar un pedido)
-- NOTA: Reemplaza 'PEDIDO_ID_AQUI' con el ID del pedido de arriba, o déjalo NULL para usar el primero
DO $$
DECLARE
  v_order_id uuid;
  v_order_number text;
  v_before_count int;
  v_after_count int;
  v_test_id uuid := NULL; -- Cambia esto al ID del pedido que quieres probar
BEGIN
  -- Si no se especifica un ID, obtener el primer pedido cerrado
  IF v_test_id IS NULL THEN
    SELECT id, order_number INTO v_order_id, v_order_number
    FROM public.orders
    WHERE status = 'closed'
      AND sent_at IS NULL
    ORDER BY updated_at DESC
    LIMIT 1;
  ELSE
    SELECT id, order_number INTO v_order_id, v_order_number
    FROM public.orders
    WHERE id = v_test_id;
  END IF;
  
  IF v_order_id IS NULL THEN
    RAISE NOTICE '⚠️ No hay pedidos cerrados para probar';
    RAISE NOTICE '   Usa un pedido cerrado o cambia v_test_id en el script';
    RETURN;
  END IF;
  
  RAISE NOTICE '🧪 ========================================';
  RAISE NOTICE '🧪 PROBANDO TRIGGER CON PEDIDO: % (%)', v_order_number, v_order_id;
  RAISE NOTICE '🧪 ========================================';
  
  -- Contar registros antes
  SELECT COUNT(*) INTO v_before_count
  FROM public.daily_sales
  WHERE sale_type = 'envios'
    AND sale_date = CURRENT_DATE;
  
  RAISE NOTICE '📊 Registros en daily_sales ANTES: %', v_before_count;
  
  -- Simular lo que hace rpc_mark_order_as_sent
  -- Esto debería disparar el trigger
  BEGIN
    UPDATE public.orders
    SET status = 'sent',
        sent_at = now(),
        updated_at = now()
    WHERE id = v_order_id;
    
    RAISE NOTICE '✅ UPDATE ejecutado. Esperando que el trigger se ejecute...';
    
    -- Esperar un momento para que el trigger se ejecute
    PERFORM pg_sleep(1);
    
    -- Contar registros después
    SELECT COUNT(*) INTO v_after_count
    FROM public.daily_sales
    WHERE sale_type = 'envios'
      AND sale_date = CURRENT_DATE;
    
    RAISE NOTICE '📊 Registros en daily_sales DESPUÉS: %', v_after_count;
    
    IF v_after_count > v_before_count THEN
      RAISE NOTICE '✅ ✅ ✅ ÉXITO: El trigger funcionó! Se creó un nuevo registro';
      RAISE NOTICE '✅ El pedido ahora está en daily_sales y debería aparecer en daily-sales.html';
    ELSE
      RAISE WARNING '❌ ❌ ❌ PROBLEMA: El trigger NO creó un registro';
      RAISE WARNING '   Posibles causas:';
      RAISE WARNING '   1. La política RLS está bloqueando la inserción';
      RAISE WARNING '   2. El trigger no se está ejecutando';
      RAISE WARNING '   3. Hay un error en la función del trigger (revisa logs de Supabase)';
      RAISE WARNING '   4. Ya existe un registro similar (verifica duplicados)';
    END IF;
    
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '❌ ERROR al ejecutar UPDATE: %', SQLERRM;
  END;
  
  RAISE NOTICE '🧪 ========================================';
  RAISE NOTICE '📝 NOTA: El pedido quedó en estado "sent". Si quieres revertirlo, ejecuta:';
  RAISE NOTICE '   UPDATE public.orders SET status = ''closed'', sent_at = NULL WHERE id = ''%'';', v_order_id;
  
END $$;

-- PASO 4: Ver los últimos registros en daily_sales de hoy
SELECT 
  ds.sale_date,
  ds.sale_time,
  ds.sale_type,
  ds.customer_name,
  ds.product_quantity,
  ds.sale_amount,
  ds.created_at,
  ds.created_by
FROM public.daily_sales ds
WHERE ds.sale_type = 'envios'
  AND ds.sale_date = CURRENT_DATE
ORDER BY ds.created_at DESC
LIMIT 5;

-- PASO 5: Verificar pedidos sent que NO están en daily_sales (si hay alguno)
SELECT 
  o.id,
  o.order_number,
  o.status,
  o.sent_at,
  o.total_amount,
  CASE 
    WHEN EXISTS (
      SELECT 1 FROM public.daily_sales ds
      WHERE ds.sale_date = o.sent_at::date
        AND ds.sale_type = 'envios'
        AND ds.sale_time = o.sent_at::time
        AND ABS(ds.sale_amount - COALESCE(o.total_amount, 0)) < 0.01
    ) THEN '✅ En daily_sales'
    ELSE '❌ NO en daily_sales'
  END as estado
FROM public.orders o
WHERE o.status IN ('sent', 'devolución')
  AND o.sent_at IS NOT NULL
  AND o.sent_at::date = CURRENT_DATE
ORDER BY o.sent_at DESC
LIMIT 10;

