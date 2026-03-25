-- 55_sync_today_orders.sql — Sincronizar pedidos de HOY que no están en daily_sales
-- Ejecuta este script para sincronizar los pedidos finalizados hoy

-- PASO 0: Verificar fecha actual y zona horaria
SELECT 
  CURRENT_DATE as fecha_actual,
  CURRENT_TIMESTAMP as timestamp_actual,
  NOW() as ahora;

-- PASO 1: Ver pedidos enviados de HOY que NO están en daily_sales
-- Buscar por sent_at de hoy O por updated_at de hoy (por si sent_at no está establecido)
SELECT 
  o.id,
  o.order_number,
  o.status,
  o.sent_at,
  o.sent_at::date as fecha_envio,
  o.sent_at::time as hora_envio,
  o.updated_at::date as fecha_update,
  o.total_amount,
  COALESCE(c.full_name, 'Cliente sin nombre') as cliente,
  CASE 
    WHEN o.sent_at IS NOT NULL AND o.sent_at::date = CURRENT_DATE THEN '✅ Tiene sent_at de hoy'
    WHEN o.sent_at IS NULL AND o.updated_at::date = CURRENT_DATE THEN '⚠️ Sin sent_at pero actualizado hoy'
    ELSE '❌ No es de hoy'
  END as diagnostico,
  CASE 
    WHEN EXISTS (
      SELECT 1 FROM public.daily_sales ds
      WHERE ds.sale_date = COALESCE(o.sent_at::date, o.updated_at::date)
        AND ds.sale_type = 'envios'
        AND ds.customer_name = COALESCE(c.full_name, 'Cliente sin nombre')
        AND ABS(EXTRACT(EPOCH FROM (ds.sale_time - COALESCE(o.sent_at::time, o.updated_at::time)))) < 60
        AND ABS(ds.sale_amount - COALESCE(o.total_amount, 0)) < 1.0
    ) THEN '✅ En daily_sales'
    ELSE '❌ NO en daily_sales - SE INSERTARÁ'
  END as estado
FROM public.orders o
LEFT JOIN public.customers c ON c.id = o.customer_id
WHERE o.status IN ('sent', 'devolución')
  AND (
    (o.sent_at IS NOT NULL AND o.sent_at::date = CURRENT_DATE)
    OR (o.sent_at IS NULL AND o.updated_at::date = CURRENT_DATE AND o.status IN ('sent', 'devolución'))
  )
ORDER BY COALESCE(o.sent_at, o.updated_at) DESC;

-- PASO 2: Corregir pedidos que tienen status 'sent' pero sent_at es NULL
-- Usar updated_at como sent_at si sent_at es NULL
UPDATE public.orders
SET sent_at = COALESCE(sent_at, updated_at, created_at, now())
WHERE status IN ('sent', 'devolución')
  AND sent_at IS NULL
  AND updated_at::date = CURRENT_DATE;

-- PASO 3: Insertar pedidos de HOY que no están en daily_sales
-- Usar sent_at si existe, sino usar updated_at
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
  COALESCE(o.sent_at::date, o.updated_at::date),
  'envios',
  COALESCE(o.sent_at::time, o.updated_at::time),
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
  AND (
    (o.sent_at IS NOT NULL AND o.sent_at::date = CURRENT_DATE)
    OR (o.sent_at IS NULL AND o.updated_at::date = CURRENT_DATE)
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.daily_sales ds
    WHERE ds.sale_date = COALESCE(o.sent_at::date, o.updated_at::date)
      AND ds.sale_type = 'envios'
      AND ds.customer_name = COALESCE(c.full_name, 'Cliente sin nombre')
      AND ABS(EXTRACT(EPOCH FROM (ds.sale_time - COALESCE(o.sent_at::time, o.updated_at::time)))) < 60
      AND ABS(ds.sale_amount - COALESCE(
        (SELECT SUM(quantity * COALESCE(price_snapshot, 0)) FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status != 'cancelled'),
        o.total_amount,
        0
      )) < 1.0
  );

-- PASO 4: Verificar resultados
SELECT 
  'Pedidos enviados hoy' as descripcion,
  COUNT(*) as cantidad
FROM public.orders o
WHERE o.status IN ('sent', 'devolución')
  AND o.sent_at IS NOT NULL
  AND o.sent_at::date = CURRENT_DATE
UNION ALL
SELECT 
  'Registros en daily_sales hoy' as descripcion,
  COUNT(*) as cantidad
FROM public.daily_sales ds
WHERE ds.sale_type = 'envios'
  AND ds.sale_date = CURRENT_DATE;

-- PASO 5: Mostrar registros insertados
SELECT 
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

