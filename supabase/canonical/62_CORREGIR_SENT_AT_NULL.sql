-- 62_CORREGIR_SENT_AT_NULL.sql — Corregir pedidos con status 'sent' pero sent_at NULL
-- Este script corrige pedidos que tienen status 'sent' pero sent_at es NULL

-- PASO 1: Ver pedidos con problema
SELECT 
  o.id,
  o.order_number,
  o.status,
  o.sent_at,
  o.updated_at,
  o.updated_at::date as fecha_update,
  o.total_amount,
  COALESCE(c.full_name, 'Cliente sin nombre') as cliente,
  '❌ Problema: status sent pero sent_at NULL' as diagnostico
FROM public.orders o
LEFT JOIN public.customers c ON c.id = o.customer_id
WHERE o.status IN ('sent', 'devolución')
  AND o.sent_at IS NULL
ORDER BY o.updated_at DESC;

-- PASO 2: Corregir pedidos con status 'sent' pero sent_at NULL
-- Usar updated_at como sent_at si sent_at es NULL
UPDATE public.orders
SET sent_at = COALESCE(sent_at, updated_at, created_at, now())
WHERE status IN ('sent', 'devolución')
  AND sent_at IS NULL;

-- PASO 3: Verificar corrección
SELECT 
  o.id,
  o.order_number,
  o.status,
  o.sent_at,
  o.updated_at,
  CASE 
    WHEN o.sent_at IS NOT NULL THEN '✅ Corregido'
    ELSE '❌ Aún tiene problema'
  END as estado
FROM public.orders o
WHERE o.status IN ('sent', 'devolución')
  AND o.updated_at::date >= CURRENT_DATE - INTERVAL '7 days'
ORDER BY o.updated_at DESC
LIMIT 10;

-- PASO 4: Mensaje final
DO $$
DECLARE
  v_corregidos int;
BEGIN
  SELECT COUNT(*) INTO v_corregidos
  FROM public.orders
  WHERE status IN ('sent', 'devolución')
    AND sent_at IS NOT NULL
    AND updated_at::date >= CURRENT_DATE - INTERVAL '7 days';
  
  RAISE NOTICE '✅ Pedidos corregidos. Total de pedidos sent con sent_at: %', v_corregidos;
END $$;

