-- 51_sync_daily_sales_day_30.sql — Sincronizar pedidos del día 30 con daily_sales
-- Este script verifica y sincroniza los pedidos enviados del día 30 de diciembre de 2025

-- PASO 1: Verificar pedidos "sent" o "devolución" del día 30
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
  AND (
    (o.sent_at IS NOT NULL AND o.sent_at::date = '2025-12-30')
    OR (o.sent_at IS NULL AND o.updated_at::date = '2025-12-30')
    OR (o.sent_at IS NULL AND o.created_at::date = '2025-12-30')
  )
ORDER BY COALESCE(o.sent_at, o.updated_at, o.created_at) DESC;

-- PASO 2: Corregir pedidos con sent_at NULL del día 30
UPDATE public.orders
SET sent_at = COALESCE(updated_at, created_at, now())
WHERE status IN ('sent', 'devolución')
  AND sent_at IS NULL
  AND (
    updated_at::date = '2025-12-30'
    OR created_at::date = '2025-12-30'
  );

-- PASO 3: Ejecutar función de sincronización
-- Esta función sincroniza todos los pedidos "sent" o "devolución" que no están en daily_sales
SELECT rpc_sync_sent_orders_to_daily_sales();

-- PASO 4: Verificar registros en daily_sales para el día 30
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
  AND ds.sale_date = '2025-12-30'
ORDER BY ds.sale_time DESC;

-- PASO 5: Resumen final
SELECT 
  'Pedidos enviados del día 30' as descripcion,
  COUNT(*) as cantidad
FROM public.orders o
WHERE o.status IN ('sent', 'devolución')
  AND o.sent_at IS NOT NULL
  AND o.sent_at::date = '2025-12-30'
UNION ALL
SELECT 
  'Registros en daily_sales del día 30' as descripcion,
  COUNT(*) as cantidad
FROM public.daily_sales ds
WHERE ds.sale_type = 'envios'
  AND ds.sale_date = '2025-12-30';

