-- 61_DIAGNOSTICO_TRIGGER_COMPLETO.sql — Diagnóstico completo del trigger
-- Este script verifica si el trigger se ejecuta y por qué puede fallar

-- PASO 1: Verificar que el trigger existe y está activo
SELECT 
  tgname as trigger_name,
  tgrelid::regclass as table_name,
  tgenabled as enabled,
  CASE tgenabled
    WHEN 'O' THEN '✅ Activo'
    WHEN 'D' THEN '❌ Deshabilitado'
    ELSE '⚠️ Estado desconocido: ' || tgenabled::text
  END as estado,
  tgtype::text as trigger_type
FROM pg_trigger
WHERE tgname = 'trigger_register_envio_sale'
  AND tgrelid = 'public.orders'::regclass;

-- PASO 2: Verificar la función del trigger
SELECT 
  proname as function_name,
  prosrc as function_source_preview,
  CASE 
    WHEN prosecdef THEN '✅ SECURITY DEFINER'
    ELSE '❌ SECURITY INVOKER'
  END as security_type
FROM pg_proc
WHERE proname = 'register_envio_to_daily_sales';

-- PASO 3: Verificar política RLS de daily_sales
SELECT 
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  CASE 
    WHEN qual LIKE '%created_by IS NULL%' THEN '✅ Permite created_by NULL'
    ELSE '⚠️ Revisar política'
  END as politica_check
FROM pg_policies
WHERE tablename = 'daily_sales'
ORDER BY policyname;

-- PASO 4: Ver un pedido cerrado reciente para probar
SELECT 
  o.id,
  o.order_number,
  o.status,
  o.sent_at,
  o.updated_at,
  o.total_amount,
  COALESCE(c.full_name, 'Cliente sin nombre') as cliente,
  CASE 
    WHEN o.status = 'closed' AND o.sent_at IS NULL THEN '✅ Listo para probar'
    WHEN o.status = 'sent' THEN '⚠️ Ya está en sent'
    ELSE '❌ Estado: ' || COALESCE(o.status::text, 'NULL')
  END as estado_para_prueba
FROM public.orders o
LEFT JOIN public.customers c ON c.id = o.customer_id
WHERE o.status = 'closed'
ORDER BY o.updated_at DESC
LIMIT 3;

-- PASO 5: Verificar registros en daily_sales de hoy
SELECT 
  COUNT(*) as registros_hoy,
  MAX(created_at) as ultimo_registro,
  STRING_AGG(DISTINCT customer_name, ', ') as clientes
FROM public.daily_sales
WHERE sale_type = 'envios'
  AND sale_date = CURRENT_DATE;

-- PASO 6: Probar el trigger manualmente con logging detallado
DO $$
DECLARE
  v_order_id uuid;
  v_order_number text;
  v_before_count int;
  v_after_count int;
  v_error_text text;
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
  
  -- Intentar el UPDATE que debería disparar el trigger
  BEGIN
    UPDATE public.orders
    SET status = 'sent',
        sent_at = now(),
        updated_at = now()
    WHERE id = v_order_id;
    
    RAISE NOTICE '✅ UPDATE ejecutado correctamente';
    
    -- Esperar un momento
    PERFORM pg_sleep(0.5);
    
    -- Contar registros después
    SELECT COUNT(*) INTO v_after_count
    FROM public.daily_sales
    WHERE sale_type = 'envios'
      AND sale_date = CURRENT_DATE;
    
    RAISE NOTICE '📊 Registros en daily_sales DESPUÉS: %', v_after_count;
    
    IF v_after_count > v_before_count THEN
      RAISE NOTICE '✅ ✅ ✅ ÉXITO: El trigger funcionó! Se creó un nuevo registro';
    ELSE
      RAISE WARNING '❌ ❌ ❌ PROBLEMA: El trigger NO creó un registro';
      RAISE WARNING '   - Revisa los logs de Supabase para ver si el trigger se ejecutó';
      RAISE WARNING '   - Verifica que la política RLS permita la inserción';
      RAISE WARNING '   - Verifica que no haya errores en la función del trigger';
    END IF;
    
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error_text = MESSAGE_TEXT;
    RAISE WARNING '❌ ERROR al ejecutar UPDATE: %', v_error_text;
  END;
  
  -- Revertir el cambio
  UPDATE public.orders
  SET status = 'closed',
      sent_at = NULL,
      updated_at = now()
  WHERE id = v_order_id;
  
  RAISE NOTICE '🔄 Pedido revertido a estado "closed"';
  RAISE NOTICE '🧪 ========================================';
  
END $$;

-- PASO 7: Verificar si hay errores recientes en los logs (si es posible)
-- Nota: Esto requiere acceso a pg_stat_statements o logs del servidor
SELECT 
  'Para ver logs detallados, revisa la consola de Supabase' as instruccion,
  'Dashboard > Logs > Postgres Logs' as donde_buscar;

-- PASO 8: Verificar la estructura de daily_sales
SELECT 
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'daily_sales'
ORDER BY ordinal_position;

