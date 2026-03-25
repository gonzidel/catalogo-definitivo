-- 45_force_insert_today_orders.sql — Forzar inserción de pedidos de hoy en daily_sales
-- Este script inserta manualmente los pedidos "sent" de hoy que no están en daily_sales
-- incluso si la función de sincronización los detecta como duplicados

-- Insertar pedidos "sent" de hoy que no están en daily_sales
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
  o.sent_at::date as sale_date,
  'envios' as sale_type,
  o.sent_at::time as sale_time,
  COALESCE(c.full_name, 'Cliente sin nombre') as customer_name,
  COALESCE(
    (SELECT COUNT(*) FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status != 'cancelled'),
    0
  ) as product_quantity,
  COALESCE(
    (SELECT SUM(quantity * COALESCE(price_snapshot, 0)) FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status != 'cancelled'),
    o.total_amount,
    0
  ) as sale_amount,
  NULL as created_by
FROM public.orders o
LEFT JOIN public.customers c ON c.id = o.customer_id
WHERE o.status = 'sent'
  AND o.sent_at IS NOT NULL
  AND o.sent_at::date = CURRENT_DATE  -- Solo pedidos de hoy
  AND NOT EXISTS (
    -- Verificar que NO existe ya un registro similar
    SELECT 1 FROM public.daily_sales ds
    WHERE ds.sale_date = o.sent_at::date
      AND ds.sale_type = 'envios'
      AND ds.customer_name = COALESCE(c.full_name, 'Cliente sin nombre')
      AND ABS(EXTRACT(EPOCH FROM (ds.sale_time - o.sent_at::time))) < 300  -- Dentro de 5 minutos
      AND ABS(ds.sale_amount - COALESCE(
        (SELECT SUM(quantity * COALESCE(price_snapshot, 0)) FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status != 'cancelled'),
        o.total_amount,
        0
      )) < 0.01
  )
ON CONFLICT DO NOTHING;  -- Si hay conflicto (aunque no hay unique constraint), no hacer nada

-- Verificar que se insertaron
SELECT 
  COUNT(*) as registros_insertados_hoy
FROM public.daily_sales
WHERE sale_type = 'envios'
  AND sale_date = CURRENT_DATE;

-- Mostrar los registros de hoy
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

