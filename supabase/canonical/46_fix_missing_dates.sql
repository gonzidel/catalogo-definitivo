-- 46_fix_missing_dates.sql — Corregir pedidos faltantes del 27 y 30 de diciembre
-- Este script verifica y fuerza la inserción de pedidos "sent" que no están en daily_sales

-- 1. Ver todos los pedidos "sent" con sus fechas
SELECT 
  o.id,
  o.order_number,
  o.status,
  o.sent_at,
  o.sent_at::date as fecha_envio,
  o.sent_at::time as hora_envio,
  o.total_amount,
  c.full_name as cliente,
  (SELECT COUNT(*) FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status != 'cancelled') as cantidad_items,
  CASE 
    WHEN EXISTS (
      SELECT 1 FROM public.daily_sales ds
      WHERE ds.sale_date = o.sent_at::date
        AND ds.sale_type = 'envios'
        AND ds.customer_name = COALESCE(c.full_name, 'Cliente sin nombre')
    ) THEN '✅ En daily_sales'
    ELSE '❌ FALTA'
  END as estado
FROM public.orders o
LEFT JOIN public.customers c ON c.id = o.customer_id
WHERE o.status = 'sent'
  AND o.sent_at IS NOT NULL
ORDER BY o.sent_at DESC;

-- 2. Insertar TODOS los pedidos "sent" que NO están en daily_sales
-- (sin importar la fecha, para asegurar que no falte ninguno)
INSERT INTO public.daily_sales (
  sale_date,
  sale_type,
  sale_time,
  customer_name,
  product_quantity,
  sale_amount,
  created_by
)
SELECT DISTINCT ON (o.id)  -- Evitar duplicados por pedido
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
  AND NOT EXISTS (
    -- Verificar que NO existe ya un registro para este pedido
    -- Usamos una comparación más flexible
    SELECT 1 FROM public.daily_sales ds
    WHERE ds.sale_date = o.sent_at::date
      AND ds.sale_type = 'envios'
      AND ds.customer_name = COALESCE(c.full_name, 'Cliente sin nombre')
      AND ABS(EXTRACT(EPOCH FROM (ds.sale_time - o.sent_at::time))) < 300  -- Dentro de 5 minutos
      AND ABS(ds.sale_amount - COALESCE(
        (SELECT SUM(quantity * COALESCE(price_snapshot, 0)) FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status != 'cancelled'),
        o.total_amount,
        0
      )) < 1.0  -- Dentro de 1 peso (más flexible)
      AND ds.product_quantity = COALESCE(
        (SELECT COUNT(*) FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status != 'cancelled'),
        0
      )
  )
ORDER BY o.id;

-- 3. Verificar cuántos registros se insertaron
SELECT 
  COUNT(*) as total_insertados,
  COUNT(DISTINCT sale_date) as fechas_diferentes
FROM public.daily_sales
WHERE sale_type = 'envios'
  AND created_at >= NOW() - INTERVAL '1 minute';  -- Registros insertados en el último minuto

-- 4. Mostrar todos los registros de "envios" ordenados por fecha
SELECT 
  ds.sale_date,
  ds.sale_time,
  ds.customer_name,
  ds.product_quantity,
  ds.sale_amount,
  ds.created_at
FROM public.daily_sales ds
WHERE ds.sale_type = 'envios'
ORDER BY ds.sale_date DESC, ds.sale_time DESC;

-- 5. Resumen por fecha
SELECT 
  ds.sale_date,
  COUNT(*) as cantidad_envios,
  SUM(ds.sale_amount) as total_monto
FROM public.daily_sales ds
WHERE ds.sale_type = 'envios'
GROUP BY ds.sale_date
ORDER BY ds.sale_date DESC;

