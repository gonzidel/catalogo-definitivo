-- 59_TEST_TRIGGER_DIRECTO.sql — Probar el trigger directamente
-- Este script prueba que el trigger se ejecute cuando se actualiza un pedido

-- PASO 1: Verificar que el trigger existe y está activo
SELECT 
  tgname as trigger_name,
  tgrelid::regclass as table_name,
  tgenabled as enabled,
  CASE tgenabled
    WHEN 'O' THEN '✅ Activo'
    WHEN 'D' THEN '❌ Deshabilitado'
    ELSE '⚠️ Estado desconocido: ' || tgenabled::text
  END as estado
FROM pg_trigger
WHERE tgname = 'trigger_register_envio_sale'
  AND tgrelid = 'public.orders'::regclass;

-- PASO 2: Ver un pedido cerrado reciente para probar
SELECT 
  o.id,
  o.order_number,
  o.status,
  o.sent_at,
  o.updated_at,
  o.total_amount,
  COALESCE(c.full_name, 'Cliente sin nombre') as cliente
FROM public.orders o
LEFT JOIN public.customers c ON c.id = o.customer_id
WHERE o.status = 'closed'
ORDER BY o.updated_at DESC
LIMIT 5;

-- PASO 3: Verificar registros en daily_sales antes de la prueba
SELECT 
  COUNT(*) as registros_antes,
  MAX(created_at) as ultimo_registro
FROM public.daily_sales
WHERE sale_type = 'envios'
  AND sale_date = CURRENT_DATE;

-- PASO 4: Simular lo que hace rpc_mark_order_as_sent (ACTUALIZAR UN PEDIDO DE PRUEBA)
-- NOTA: Esto actualizará el primer pedido cerrado que encuentre
-- Si quieres probar con un pedido específico, reemplaza el WHERE con: WHERE id = 'tu-pedido-id'
DO $$
DECLARE
  v_order_id uuid;
  v_order_number text;
  v_before_count int;
  v_after_count int;
BEGIN
  -- Obtener un pedido cerrado para probar
  SELECT id, order_number INTO v_order_id, v_order_number
  FROM public.orders
  WHERE status = 'closed'
    AND sent_at IS NULL
  ORDER BY updated_at DESC
  LIMIT 1;
  
  IF v_order_id IS NULL THEN
    RAISE NOTICE '⚠️ No hay pedidos cerrados sin sent_at para probar';
    RAISE NOTICE '   Buscando cualquier pedido cerrado...';
    
    SELECT id, order_number INTO v_order_id, v_order_number
    FROM public.orders
    WHERE status = 'closed'
    ORDER BY updated_at DESC
    LIMIT 1;
  END IF;
  
  IF v_order_id IS NULL THEN
    RAISE EXCEPTION '❌ No hay pedidos cerrados para probar';
  END IF;
  
  RAISE NOTICE '🧪 Probando trigger con pedido: % (%)', v_order_number, v_order_id;
  
  -- Contar registros antes
  SELECT COUNT(*) INTO v_before_count
  FROM public.daily_sales
  WHERE sale_type = 'envios'
    AND sale_date = CURRENT_DATE;
  
  RAISE NOTICE '📊 Registros en daily_sales antes: %', v_before_count;
  
  -- Simular el UPDATE que hace rpc_mark_order_as_sent
  -- Esto debería disparar el trigger
  UPDATE public.orders
  SET status = 'sent',
      sent_at = now(),
      updated_at = now()
  WHERE id = v_order_id;
  
  RAISE NOTICE '✅ UPDATE ejecutado. El trigger debería haberse ejecutado.';
  
  -- Esperar un momento para que el trigger se ejecute
  PERFORM pg_sleep(0.5);
  
  -- Contar registros después
  SELECT COUNT(*) INTO v_after_count
  FROM public.daily_sales
  WHERE sale_type = 'envios'
    AND sale_date = CURRENT_DATE;
  
  RAISE NOTICE '📊 Registros en daily_sales después: %', v_after_count;
  
  IF v_after_count > v_before_count THEN
    RAISE NOTICE '✅ ÉXITO: El trigger funcionó! Se creó un nuevo registro en daily_sales';
  ELSE
    RAISE WARNING '❌ PROBLEMA: El trigger NO creó un registro. Revisa los logs de Supabase.';
  END IF;
  
  -- Revertir el cambio (volver a 'closed' y NULL sent_at)
  UPDATE public.orders
  SET status = 'closed',
      sent_at = NULL,
      updated_at = now()
  WHERE id = v_order_id;
  
  RAISE NOTICE '🔄 Pedido revertido a estado "closed" para que puedas probarlo manualmente';
  
END $$;

-- PASO 5: Ver los últimos registros en daily_sales
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

