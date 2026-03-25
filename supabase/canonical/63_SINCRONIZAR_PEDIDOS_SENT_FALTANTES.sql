-- 63_SINCRONIZAR_PEDIDOS_SENT_FALTANTES.sql — Sincronizar pedidos 'sent' que no están en daily_sales
-- Este script inserta en daily_sales los pedidos que ya están en 'sent' pero no están registrados

-- PASO 1: Ver pedidos 'sent' que NO están en daily_sales
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
        AND ABS(ds.sale_amount - COALESCE(
          (SELECT SUM(quantity * COALESCE(price_snapshot, 0)) FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status != 'cancelled'),
          o.total_amount,
          0
        )) < 1.0
    ) THEN '✅ Ya está en daily_sales'
    ELSE '❌ NO está en daily_sales - SE INSERTARÁ'
  END as estado
FROM public.orders o
LEFT JOIN public.customers c ON c.id = o.customer_id
WHERE o.status IN ('sent', 'devolución')
  AND o.sent_at IS NOT NULL
ORDER BY o.sent_at DESC
LIMIT 20;

-- PASO 2: Insertar pedidos 'sent' que NO están en daily_sales
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
      AND ABS(EXTRACT(EPOCH FROM (ds.sale_time - o.sent_at::time))) < 60
      AND ABS(ds.sale_amount - COALESCE(
        (SELECT SUM(quantity * COALESCE(price_snapshot, 0)) FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status != 'cancelled'),
        o.total_amount,
        0
      )) < 1.0
  );

-- PASO 3: Verificar resultados
SELECT 
  'Pedidos sent totales' as descripcion,
  COUNT(*) as cantidad
FROM public.orders o
WHERE o.status IN ('sent', 'devolución')
  AND o.sent_at IS NOT NULL
UNION ALL
SELECT 
  'Registros en daily_sales (envios)' as descripcion,
  COUNT(*) as cantidad
FROM public.daily_sales ds
WHERE ds.sale_type = 'envios';

-- PASO 4: Ver registros insertados recientemente
SELECT 
  ds.sale_date,
  ds.sale_time,
  ds.customer_name,
  ds.product_quantity,
  ds.sale_amount,
  ds.created_at
FROM public.daily_sales ds
WHERE ds.sale_type = 'envios'
ORDER BY ds.created_at DESC
LIMIT 10;

-- PASO 5: Mensaje final
DO $$
DECLARE
  v_pedidos_sent int;
  v_registros_daily int;
BEGIN
  SELECT COUNT(*) INTO v_pedidos_sent
  FROM public.orders
  WHERE status IN ('sent', 'devolución')
    AND sent_at IS NOT NULL;
  
  SELECT COUNT(*) INTO v_registros_daily
  FROM public.daily_sales
  WHERE sale_type = 'envios';
  
  RAISE NOTICE '✅ Sincronización completada';
  RAISE NOTICE '📊 Pedidos sent: %, Registros en daily_sales: %', v_pedidos_sent, v_registros_daily;
  
  IF v_registros_daily >= v_pedidos_sent THEN
    RAISE NOTICE '✅ Todos los pedidos sent están en daily_sales';
  ELSE
    RAISE WARNING '⚠️ Faltan % pedidos en daily_sales', (v_pedidos_sent - v_registros_daily);
  END IF;
END $$;

