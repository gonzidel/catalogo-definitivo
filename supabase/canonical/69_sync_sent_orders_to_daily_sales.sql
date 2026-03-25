-- 69_sync_sent_orders_to_daily_sales.sql — Sincronizar pedidos 'sent' que no están en daily_sales
-- Este script inserta en daily_sales los pedidos que ya están en 'sent' pero no están registrados

-- PASO 1: Ver pedidos 'sent' que NO están en daily_sales
DO $$
DECLARE
  v_pedidos_sent int;
  v_registros_daily int;
BEGIN
  -- Contar pedidos sent
  SELECT COUNT(*) INTO v_pedidos_sent
  FROM public.orders
  WHERE status = 'sent';
  
  -- Contar registros en daily_sales de tipo envios
  SELECT COUNT(*) INTO v_registros_daily
  FROM public.daily_sales
  WHERE sale_type = 'envios';
  
  RAISE NOTICE '📊 Pedidos sent: %, Registros en daily_sales (envios): %', v_pedidos_sent, v_registros_daily;
  
  IF v_pedidos_sent = v_registros_daily THEN
    RAISE NOTICE '✅ Todos los pedidos sent están en daily_sales';
  ELSE
    RAISE WARNING '⚠️ Faltan % pedidos en daily_sales', (v_pedidos_sent - v_registros_daily);
  END IF;
END $$;

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
  COALESCE(o.sent_at, o.closed_at, o.updated_at)::date as sale_date,
  'envios' as sale_type,
  (COALESCE(o.sent_at, o.closed_at, o.updated_at)::time) as sale_time,
  COALESCE(c.full_name, 'Cliente sin nombre') as customer_name,
  GREATEST(COUNT(oi.id), 1) as product_quantity,  -- Mínimo 1
  -- IMPORTANTE: Usar total_amount directamente porque ya incluye extras (shipping, discount, extras)
  COALESCE(o.total_amount, 0) as sale_amount,
  NULL as created_by
FROM public.orders o
LEFT JOIN public.customers c ON c.id = o.customer_id
LEFT JOIN public.order_items oi ON oi.order_id = o.id AND oi.status != 'cancelled'
WHERE o.status = 'sent'
  -- Verificar que no exista ya un registro similar en daily_sales
  AND NOT EXISTS (
    SELECT 1 FROM public.daily_sales ds
    WHERE ds.sale_date = COALESCE(o.sent_at, o.closed_at, o.updated_at)::date
      AND ds.sale_type = 'envios'
      AND ds.sale_time = (COALESCE(o.sent_at, o.closed_at, o.updated_at)::time)
      -- IMPORTANTE: Comparar con total_amount directamente porque ya incluye extras
      AND ABS(ds.sale_amount - COALESCE(o.total_amount, 0)) < 0.01
      AND ds.customer_name = COALESCE(c.full_name, 'Cliente sin nombre')
  )
GROUP BY 
  o.id,
  o.sent_at,
  o.closed_at,
  o.updated_at,
  o.total_amount,
  c.full_name
ON CONFLICT DO NOTHING;

-- PASO 3: Mostrar resumen
DO $$
DECLARE
  v_insertados int;
  v_total_sent int;
  v_total_daily int;
BEGIN
  -- Contar cuántos se insertaron (aproximado)
  SELECT COUNT(*) INTO v_total_sent
  FROM public.orders
  WHERE status = 'sent';
  
  SELECT COUNT(*) INTO v_total_daily
  FROM public.daily_sales
  WHERE sale_type = 'envios';
  
  v_insertados := v_total_daily;
  
  RAISE NOTICE '📊 Resumen de sincronización:';
  RAISE NOTICE '   - Pedidos sent: %', v_total_sent;
  RAISE NOTICE '   - Registros en daily_sales (envios): %', v_total_daily;
  
  IF v_total_sent <= v_total_daily THEN
    RAISE NOTICE '✅ Sincronización completada. Todos los pedidos sent deberían estar en daily_sales.';
  ELSE
    RAISE WARNING '⚠️ Aún faltan algunos pedidos. Verifica manualmente.';
  END IF;
END $$;

-- PASO 4: Ver los últimos registros insertados
SELECT 
  'Últimos registros en daily_sales (envios)' as descripcion,
  COUNT(*) as total
FROM public.daily_sales
WHERE sale_type = 'envios';

-- PASO 5: Recargar esquema
SELECT pg_notify('pgrst', 'reload schema');

