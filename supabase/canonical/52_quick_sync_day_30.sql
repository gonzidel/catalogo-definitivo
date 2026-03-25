-- 52_quick_sync_day_30.sql — Sincronización rápida de pedidos del día 30
-- Ejecuta este script completo en el SQL Editor de Supabase

-- PASO 1: Corregir pedidos con sent_at NULL del día 30
UPDATE public.orders
SET sent_at = COALESCE(updated_at, created_at, now())
WHERE status IN ('sent', 'devolución')
  AND sent_at IS NULL
  AND (
    updated_at::date = '2025-12-30'
    OR created_at::date = '2025-12-30'
  );

-- PASO 2: Sincronizar todos los pedidos enviados con daily_sales
SELECT rpc_sync_sent_orders_to_daily_sales();

-- PASO 3: Verificar resultados para el día 30
SELECT 
  ds.sale_date,
  ds.sale_time,
  ds.customer_name,
  ds.product_quantity,
  ds.sale_amount
FROM public.daily_sales ds
WHERE ds.sale_type = 'envios'
  AND ds.sale_date = '2025-12-30'
ORDER BY ds.sale_time DESC;

