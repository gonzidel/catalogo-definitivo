-- 44_check_today_daily_sales.sql — Verificar registros en daily_sales para hoy (30/12/2025)
-- Este script verifica qué registros hay en daily_sales para la fecha de hoy

-- 1. Ver todos los registros de daily_sales de tipo "envios" para hoy
SELECT 
  ds.id,
  ds.sale_date,
  ds.sale_time,
  ds.customer_name,
  ds.product_quantity,
  ds.sale_amount,
  ds.sale_type,
  ds.created_at
FROM public.daily_sales ds
WHERE ds.sale_type = 'envios'
  AND ds.sale_date = CURRENT_DATE  -- 30/12/2025
ORDER BY ds.sale_time DESC;

-- 2. Ver todos los pedidos "sent" de hoy
SELECT 
  o.id,
  o.order_number,
  o.status,
  o.sent_at,
  o.sent_at::date as fecha_envio,
  o.sent_at::time as hora_envio,
  o.total_amount,
  c.full_name as cliente,
  (SELECT COUNT(*) FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status != 'cancelled') as cantidad_items
FROM public.orders o
LEFT JOIN public.customers c ON c.id = o.customer_id
WHERE o.status = 'sent'
  AND o.sent_at IS NOT NULL
  AND o.sent_at::date = CURRENT_DATE  -- 30/12/2025
ORDER BY o.sent_at DESC;

-- 3. Comparar pedidos "sent" de hoy vs registros en daily_sales de hoy
SELECT 
  o.id as order_id,
  o.order_number,
  o.sent_at::date as fecha_pedido,
  o.sent_at::time as hora_pedido,
  COALESCE(c.full_name, 'Cliente sin nombre') as cliente_pedido,
  o.total_amount as monto_pedido,
  (SELECT COUNT(*) FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status != 'cancelled') as items_pedido,
  CASE 
    WHEN EXISTS (
      SELECT 1 FROM public.daily_sales ds
      WHERE ds.sale_date = o.sent_at::date
        AND ds.sale_type = 'envios'
        AND ds.customer_name = COALESCE(c.full_name, 'Cliente sin nombre')
        AND ABS(EXTRACT(EPOCH FROM (ds.sale_time - o.sent_at::time))) < 60  -- Misma hora (dentro de 1 minuto)
        AND ABS(ds.sale_amount - COALESCE(o.total_amount, 0)) < 0.01  -- Mismo monto
    ) THEN '✅ En daily_sales'
    ELSE '❌ NO en daily_sales'
  END as estado
FROM public.orders o
LEFT JOIN public.customers c ON c.id = o.customer_id
WHERE o.status = 'sent'
  AND o.sent_at IS NOT NULL
  AND o.sent_at::date = CURRENT_DATE
ORDER BY o.sent_at DESC;

-- 4. Ver todos los registros de daily_sales de tipo "envios" (sin filtrar por fecha)
SELECT 
  ds.sale_date,
  COUNT(*) as cantidad_registros,
  SUM(ds.sale_amount) as total_monto
FROM public.daily_sales ds
WHERE ds.sale_type = 'envios'
GROUP BY ds.sale_date
ORDER BY ds.sale_date DESC
LIMIT 10;

