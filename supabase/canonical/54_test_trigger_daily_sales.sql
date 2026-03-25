-- 54_test_trigger_daily_sales.sql — Verificar que el trigger funciona correctamente
-- Este script verifica el estado del trigger y prueba su funcionamiento

-- PASO 1: Verificar que el trigger existe y está activo
SELECT 
  tgname as trigger_name,
  tgrelid::regclass as table_name,
  tgenabled as is_enabled,
  CASE 
    WHEN tgenabled = 'O' THEN '✅ Activo'
    WHEN tgenabled = 'D' THEN '❌ Deshabilitado'
    ELSE '⚠️ Estado desconocido'
  END as estado
FROM pg_trigger
WHERE tgname = 'trigger_register_envio_sale'
  AND tgrelid = 'public.orders'::regclass;

-- PASO 2: Verificar que la función existe
SELECT 
  proname as function_name,
  CASE 
    WHEN proname = 'register_envio_to_daily_sales' THEN '✅ Existe'
    ELSE '❌ No existe'
  END as estado
FROM pg_proc
WHERE proname = 'register_envio_to_daily_sales'
  AND pronamespace = 'public'::regnamespace;

-- PASO 3: Ver pedidos enviados de hoy que NO están en daily_sales
SELECT 
  o.id,
  o.order_number,
  o.status,
  o.sent_at,
  o.sent_at::date as fecha_envio,
  o.sent_at::time as hora_envio,
  o.total_amount,
  COALESCE(c.full_name, 'Cliente sin nombre') as cliente,
  CASE 
    WHEN EXISTS (
      SELECT 1 FROM public.daily_sales ds
      WHERE ds.sale_date = o.sent_at::date
        AND ds.sale_type = 'envios'
        AND ds.customer_name = COALESCE(c.full_name, 'Cliente sin nombre')
        AND ABS(EXTRACT(EPOCH FROM (ds.sale_time - o.sent_at::time))) < 60
        AND ABS(ds.sale_amount - COALESCE(o.total_amount, 0)) < 1.0
    ) THEN '✅ En daily_sales'
    ELSE '❌ NO en daily_sales'
  END as en_daily_sales
FROM public.orders o
LEFT JOIN public.customers c ON c.id = o.customer_id
WHERE o.status IN ('sent', 'devolución')
  AND o.sent_at IS NOT NULL
  AND o.sent_at::date = CURRENT_DATE
ORDER BY o.sent_at DESC;

-- PASO 4: Ver registros en daily_sales de hoy
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
  AND ds.sale_date = CURRENT_DATE
ORDER BY ds.sale_time DESC;

-- PASO 5: Sincronizar pedidos de hoy que no están en daily_sales
-- Esto insertará los pedidos que el trigger no registró
INSERT INTO public.daily_sales (
  sale_date,
  sale_type,
  sale_time,
  customer_name,
  product_quantity,
  sale_amount,
  created_by
)
SELECT 
  o.sent_at::date,
  'envios',
  o.sent_at::time,
  COALESCE(c.full_name, 'Cliente sin nombre'),
  GREATEST(
    COALESCE((SELECT COUNT(*) FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status != 'cancelled'), 0),
    1
  ),
  COALESCE(
    (SELECT SUM(quantity * COALESCE(price_snapshot, 0)) FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status != 'cancelled'),
    o.total_amount,
    0
  ),
  NULL
FROM public.orders o
LEFT JOIN public.customers c ON c.id = o.customer_id
WHERE o.status IN ('sent', 'devolución')
  AND o.sent_at IS NOT NULL
  AND o.sent_at::date = CURRENT_DATE
  AND NOT EXISTS (
    SELECT 1 FROM public.daily_sales ds
    WHERE ds.sale_date = o.sent_at::date
      AND ds.sale_type = 'envios'
      AND ds.customer_name = COALESCE(c.full_name, 'Cliente sin nombre')
      AND ABS(EXTRACT(EPOCH FROM (ds.sale_time - o.sent_at::time))) < 60
      AND ABS(ds.sale_amount - COALESCE(
        (SELECT SUM(quantity * COALESCE(price_snapshot, 0)) FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status != 'cancelled'),
        o.total_amount,
        0
      )) < 1.0
  );

-- PASO 6: Verificar resultados después de la inserción
SELECT 
  'Pedidos enviados hoy' as descripcion,
  COUNT(*) as cantidad
FROM public.orders o
WHERE o.status IN ('sent', 'devolución')
  AND o.sent_at IS NOT NULL
  AND o.sent_at::date = CURRENT_DATE
UNION ALL
SELECT 
  'Registros en daily_sales hoy' as descripcion,
  COUNT(*) as cantidad
FROM public.daily_sales ds
WHERE ds.sale_type = 'envios'
  AND ds.sale_date = CURRENT_DATE;

