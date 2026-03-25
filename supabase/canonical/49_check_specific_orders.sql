-- 49_check_specific_orders.sql — Verificar pedidos específicos #A50021 y #A50020
-- Este script verifica el estado exacto de estos pedidos y los inserta en daily_sales si es necesario

-- PASO 1: Verificar los pedidos específicos #A50021 y #A50020
SELECT 
  o.id,
  o.order_number,
  o.status,
  o.sent_at,
  o.sent_at::date as fecha_envio,
  o.sent_at::time as hora_envio,
  o.total_amount,
  COALESCE(c.full_name, 'Cliente sin nombre') as cliente,
  (SELECT COUNT(*) FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status != 'cancelled') as cantidad_items,
  (SELECT COALESCE(SUM(quantity * COALESCE(price_snapshot, 0)), 0) FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status != 'cancelled') as monto_calculado,
  CASE 
    WHEN EXISTS (
      SELECT 1 FROM public.daily_sales ds
      WHERE ds.sale_date = o.sent_at::date
        AND ds.sale_type = 'envios'
        AND ds.customer_name = COALESCE(c.full_name, 'Cliente sin nombre')
    ) THEN '✅ En daily_sales'
    ELSE '❌ FALTA'
  END as en_daily_sales
FROM public.orders o
LEFT JOIN public.customers c ON c.id = o.customer_id
WHERE o.order_number IN ('A50021', 'A50020')
ORDER BY o.sent_at DESC;

-- PASO 2: Ver TODOS los pedidos con status "sent" o "devolución" del 30 de diciembre
SELECT 
  o.id,
  o.order_number,
  o.status,
  o.sent_at,
  o.sent_at::date as fecha_envio,
  o.sent_at::time as hora_envio,
  o.total_amount,
  COALESCE(c.full_name, 'Cliente sin nombre') as cliente
FROM public.orders o
LEFT JOIN public.customers c ON c.id = o.customer_id
WHERE o.status IN ('sent', 'devolución')
  AND o.sent_at IS NOT NULL
  AND o.sent_at::date = '2025-12-30'  -- Fecha específica del 30
ORDER BY o.sent_at DESC;

-- PASO 3: Insertar pedidos "sent" o "devolución" del 30 de diciembre que no están en daily_sales
-- NOTA: Los pedidos con status "devolución" también deberían aparecer en daily_sales como envíos
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
WHERE o.status IN ('sent', 'devolución')  -- Incluir también "devolución"
  AND o.sent_at IS NOT NULL
  AND o.sent_at::date = '2025-12-30'
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

-- PASO 4: Verificar que se insertaron
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

-- PASO 5: También insertar pedidos del 27 de diciembre
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
  AND o.sent_at::date = '2025-12-27'
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

