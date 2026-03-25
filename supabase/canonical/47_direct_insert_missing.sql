-- 47_direct_insert_missing.sql — Inserción directa de pedidos faltantes
-- Este script primero muestra qué pedidos hay y luego los inserta directamente

-- PASO 1: Ver TODOS los pedidos "sent" con detalles
SELECT 
  o.id,
  o.order_number,
  o.sent_at::date as fecha,
  o.sent_at::time as hora,
  o.total_amount,
  COALESCE(c.full_name, 'Cliente sin nombre') as cliente,
  (SELECT COUNT(*) FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status != 'cancelled') as items,
  (SELECT COALESCE(SUM(quantity * COALESCE(price_snapshot, 0)), 0) FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status != 'cancelled') as monto_calculado
FROM public.orders o
LEFT JOIN public.customers c ON c.id = o.customer_id
WHERE o.status = 'sent'
  AND o.sent_at IS NOT NULL
ORDER BY o.sent_at DESC;

-- PASO 2: Insertar directamente TODOS los pedidos "sent" (sin verificar duplicados primero)
-- Esto asegura que se inserten incluso si hay algún problema con la verificación
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
  COALESCE(
    (SELECT COUNT(*) FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status != 'cancelled'),
    0
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
  AND o.sent_at IS NOT NULL
  AND NOT EXISTS (
    -- Verificación simple: mismo pedido, misma fecha, mismo cliente
    SELECT 1 FROM public.daily_sales ds
    WHERE ds.sale_date = o.sent_at::date
      AND ds.sale_type = 'envios'
      AND ds.customer_name = COALESCE(c.full_name, 'Cliente sin nombre')
      AND ds.sale_time = o.sent_at::time
      AND ds.sale_amount = COALESCE(
        (SELECT SUM(quantity * COALESCE(price_snapshot, 0)) FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status != 'cancelled'),
        o.total_amount,
        0
      )
  );

-- PASO 3: Verificar qué se insertó
SELECT 
  'Registros insertados' as accion,
  COUNT(*) as cantidad
FROM public.daily_sales
WHERE sale_type = 'envios'
  AND created_at >= NOW() - INTERVAL '5 minutes';

-- PASO 4: Mostrar TODOS los registros de "envios" por fecha
SELECT 
  sale_date,
  COUNT(*) as cantidad,
  SUM(sale_amount) as total_monto,
  STRING_AGG(customer_name, ', ' ORDER BY sale_time) as clientes
FROM public.daily_sales
WHERE sale_type = 'envios'
GROUP BY sale_date
ORDER BY sale_date DESC;

-- PASO 5: Si hay duplicados, eliminarlos (mantener solo el más reciente)
DELETE FROM public.daily_sales ds1
WHERE ds1.sale_type = 'envios'
  AND EXISTS (
    SELECT 1 FROM public.daily_sales ds2
    WHERE ds2.sale_type = 'envios'
      AND ds2.sale_date = ds1.sale_date
      AND ds2.sale_time = ds1.sale_time
      AND ds2.customer_name = ds1.customer_name
      AND ds2.sale_amount = ds1.sale_amount
      AND ds2.id != ds1.id
      AND ds2.created_at > ds1.created_at  -- Mantener el más reciente
  );

-- PASO 6: Resultado final
SELECT 
  sale_date,
  COUNT(*) as cantidad_envios,
  SUM(sale_amount) as total_monto
FROM public.daily_sales
WHERE sale_type = 'envios'
GROUP BY sale_date
ORDER BY sale_date DESC;

