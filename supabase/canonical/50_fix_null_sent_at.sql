-- 50_fix_null_sent_at.sql — Corregir pedidos con sent_at NULL y registrarlos en daily_sales
-- Este script actualiza los pedidos que tienen status "sent" pero sent_at es NULL

-- PASO 1: Ver todos los pedidos "sent" o "devolución" con sent_at NULL
SELECT 
  o.id,
  o.order_number,
  o.status,
  o.sent_at,
  o.updated_at,
  o.created_at,
  o.total_amount,
  COALESCE(c.full_name, 'Cliente sin nombre') as cliente
FROM public.orders o
LEFT JOIN public.customers c ON c.id = o.customer_id
WHERE o.status IN ('sent', 'devolución')
  AND o.sent_at IS NULL
ORDER BY o.updated_at DESC;

-- PASO 2: Actualizar pedidos "sent" o "devolución" que tienen sent_at NULL
-- Usar updated_at como fecha de envío si existe, sino usar created_at
UPDATE public.orders
SET sent_at = COALESCE(updated_at, created_at, now())
WHERE status IN ('sent', 'devolución')
  AND sent_at IS NULL;

-- PASO 3: Verificar que se actualizaron
SELECT 
  o.id,
  o.order_number,
  o.status,
  o.sent_at,
  o.sent_at::date as fecha_envio,
  o.sent_at::time as hora_envio,
  COALESCE(c.full_name, 'Cliente sin nombre') as cliente
FROM public.orders o
LEFT JOIN public.customers c ON c.id = o.customer_id
WHERE o.status IN ('sent', 'devolución')
  AND o.sent_at IS NOT NULL
  AND o.order_number IN ('A50021', 'A50020')
ORDER BY o.sent_at DESC;

-- PASO 4: Insertar TODOS los pedidos "sent" o "devolución" que tienen sent_at y no están en daily_sales
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
  AND NOT EXISTS (
    SELECT 1 FROM public.daily_sales ds
    WHERE ds.sale_date = o.sent_at::date
      AND ds.sale_type = 'envios'
      AND ds.customer_name = COALESCE(c.full_name, 'Cliente sin nombre')
      AND ds.sale_time = o.sent_at::time
      AND ABS(ds.sale_amount - COALESCE(
        (SELECT SUM(quantity * COALESCE(price_snapshot, 0)) FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status != 'cancelled'),
        o.total_amount,
        0
      )) < 1.0
  );

-- PASO 5: Verificar registros insertados para el 30 de diciembre
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

-- PASO 6: Resumen final por fecha
SELECT 
  sale_date,
  COUNT(*) as cantidad_envios,
  SUM(sale_amount) as total_monto
FROM public.daily_sales
WHERE sale_type = 'envios'
  AND sale_date IN ('2025-12-27', '2025-12-30')
GROUP BY sale_date
ORDER BY sale_date DESC;

