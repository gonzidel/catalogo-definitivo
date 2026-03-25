-- 43_quick_fix_today_orders.sql — Sincronizar rápidamente los pedidos de hoy (30/12/2025)
-- Este script sincroniza específicamente los pedidos marcados como "sent" del día de hoy

-- Verificar pedidos "sent" de hoy que no están en daily_sales
SELECT 
  o.id,
  o.order_number,
  o.sent_at,
  o.sent_at::date as fecha_envio,
  o.total_amount,
  c.full_name as cliente,
  CASE 
    WHEN EXISTS (
      SELECT 1 FROM public.daily_sales ds
      WHERE ds.sale_date = o.sent_at::date
        AND ds.sale_type = 'envios'
        AND ds.customer_name = COALESCE(c.full_name, 'Cliente sin nombre')
        AND ABS(EXTRACT(EPOCH FROM (ds.sale_time - o.sent_at::time))) < 60
    ) THEN '✅ Ya registrado'
    ELSE '❌ FALTA REGISTRAR'
  END as estado
FROM public.orders o
LEFT JOIN public.customers c ON c.id = o.customer_id
WHERE o.status = 'sent'
  AND o.sent_at IS NOT NULL
  AND o.sent_at::date = CURRENT_DATE  -- Solo pedidos de hoy
ORDER BY o.sent_at DESC;

-- Sincronizar todos los pedidos "sent" (incluyendo los de hoy)
SELECT rpc_sync_sent_orders_to_daily_sales();

-- Verificar que se registraron los pedidos de hoy
SELECT 
  ds.id,
  ds.sale_date,
  ds.sale_time,
  ds.customer_name,
  ds.product_quantity,
  ds.sale_amount,
  ds.sale_type
FROM public.daily_sales ds
WHERE ds.sale_type = 'envios'
  AND ds.sale_date = CURRENT_DATE
ORDER BY ds.sale_time DESC;

