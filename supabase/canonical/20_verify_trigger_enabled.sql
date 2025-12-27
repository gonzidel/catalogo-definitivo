-- 20_verify_trigger_enabled.sql — Verificar estado del trigger (idempotente)
-- Este script verifica y muestra el estado del trigger de números de pedido

-- Verificar estado del trigger
SELECT 
  tgname as trigger_name,
  CASE tgenabled
    WHEN 'O' THEN 'ENABLED (Habilitado) ✅'
    WHEN 'D' THEN 'DISABLED (Deshabilitado) ❌'
    WHEN 'R' THEN 'REPLICA'
    WHEN 'A' THEN 'ALWAYS'
    ELSE 'UNKNOWN: ' || tgenabled::text
  END as estado,
  tgenabled::text as codigo_estado,
  tgrelid::regclass as tabla
FROM pg_trigger
WHERE tgname = 'assign_order_number_trigger';

-- Verificar últimos pedidos creados
SELECT 
  id,
  order_number,
  status,
  total_amount,
  customer_id,
  created_at
FROM public.orders
ORDER BY created_at DESC
LIMIT 10;

-- Contar pedidos por estado
SELECT 
  status,
  COUNT(*) as cantidad,
  COUNT(order_number) as con_numero,
  COUNT(*) - COUNT(order_number) as sin_numero
FROM public.orders
GROUP BY status;

