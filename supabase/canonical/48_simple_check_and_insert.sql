-- 48_simple_check_and_insert.sql — Verificación simple e inserción directa
-- Este script primero verifica qué pedidos hay y luego los inserta sin verificación compleja

-- PASO 1: Ver TODOS los pedidos "sent" - esto es lo más importante
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
WHERE o.status = 'sent'
  AND o.sent_at IS NOT NULL
ORDER BY o.sent_at DESC;

-- PASO 2: Contar cuántos pedidos "sent" hay por fecha
SELECT 
  o.sent_at::date as fecha,
  COUNT(*) as cantidad_pedidos
FROM public.orders o
WHERE o.status = 'sent'
  AND o.sent_at IS NOT NULL
GROUP BY o.sent_at::date
ORDER BY fecha DESC;

-- PASO 3: Insertar SIN verificar duplicados (insertar todos y luego limpiar duplicados)
-- Esto fuerza la inserción de todos los pedidos "sent"
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
    1  -- Mínimo 1 si no hay items
  ),
  COALESCE(
    (SELECT SUM(quantity * COALESCE(price_snapshot, 0)) FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status != 'cancelled'),
    o.total_amount,
    0
  ),
  NULL
FROM public.orders o
LEFT JOIN public.customers c ON c.id = o.customer_id
WHERE o.status = 'sent'
  AND o.sent_at IS NOT NULL;

-- PASO 4: Eliminar duplicados (mantener solo el más antiguo de cada grupo)
DELETE FROM public.daily_sales ds1
WHERE ds1.sale_type = 'envios'
  AND ds1.id IN (
    SELECT ds2.id
    FROM public.daily_sales ds2
    WHERE ds2.sale_type = 'envios'
      AND ds2.sale_date = ds1.sale_date
      AND ds2.sale_time = ds1.sale_time
      AND ds2.customer_name = ds1.customer_name
      AND ds2.sale_amount = ds1.sale_amount
      AND ds2.id > ds1.id  -- Mantener el más antiguo (menor ID)
  );

-- PASO 5: Ver resultado final por fecha
SELECT 
  sale_date,
  COUNT(*) as cantidad_envios,
  SUM(sale_amount) as total_monto
FROM public.daily_sales
WHERE sale_type = 'envios'
GROUP BY sale_date
ORDER BY sale_date DESC;

-- PASO 6: Ver registros específicos del 27 y 30 de diciembre
SELECT 
  ds.id,
  ds.sale_date,
  ds.sale_time,
  ds.customer_name,
  ds.product_quantity,
  ds.sale_amount
FROM public.daily_sales ds
WHERE ds.sale_type = 'envios'
  AND ds.sale_date IN ('2025-12-27', '2025-12-30', CURRENT_DATE)
ORDER BY ds.sale_date DESC, ds.sale_time DESC;

