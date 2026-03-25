-- 58_DIAGNOSTICO_PEDIDOS.sql — Diagnosticar por qué no se reconocen los pedidos enviados
-- Este script muestra TODOS los pedidos recientes para ver qué está pasando

-- PASO 1: Ver TODOS los pedidos recientes (últimos 7 días) sin filtrar por fecha
SELECT 
  o.id,
  o.order_number,
  o.status,
  o.sent_at,
  o.sent_at::date as fecha_envio,
  o.sent_at::time as hora_envio,
  o.created_at::date as fecha_creacion,
  o.updated_at::date as fecha_actualizacion,
  o.total_amount,
  COALESCE(c.full_name, 'Cliente sin nombre') as cliente,
  CASE 
    WHEN o.status IN ('sent', 'devolución') AND o.sent_at IS NOT NULL THEN '✅ Tiene sent_at'
    WHEN o.status IN ('sent', 'devolución') AND o.sent_at IS NULL THEN '❌ Status sent pero sin sent_at'
    ELSE '⚠️ Status: ' || COALESCE(o.status::text, 'NULL')
  END as diagnostico
FROM public.orders o
LEFT JOIN public.customers c ON c.id = o.customer_id
WHERE o.updated_at >= CURRENT_DATE - INTERVAL '7 days'
  OR o.created_at >= CURRENT_DATE - INTERVAL '7 days'
ORDER BY COALESCE(o.sent_at, o.updated_at, o.created_at) DESC
LIMIT 50;

-- PASO 2: Ver pedidos con status 'sent' o 'devolución' (sin filtrar por fecha)
SELECT 
  o.id,
  o.order_number,
  o.status,
  o.sent_at,
  o.sent_at::date as fecha_envio,
  o.sent_at::time as hora_envio,
  o.total_amount,
  COALESCE(c.full_name, 'Cliente sin nombre') as cliente,
  CURRENT_DATE as fecha_hoy,
  CASE 
    WHEN o.sent_at IS NOT NULL AND o.sent_at::date = CURRENT_DATE THEN '✅ Es de HOY'
    WHEN o.sent_at IS NOT NULL THEN '⚠️ Es de otro día: ' || o.sent_at::date::text
    ELSE '❌ No tiene sent_at'
  END as diagnostico_fecha
FROM public.orders o
LEFT JOIN public.customers c ON c.id = o.customer_id
WHERE o.status IN ('sent', 'devolución')
ORDER BY COALESCE(o.sent_at, o.updated_at) DESC
LIMIT 20;

-- PASO 3: Verificar CURRENT_DATE y zona horaria
SELECT 
  CURRENT_DATE as fecha_actual,
  CURRENT_TIMESTAMP as timestamp_actual,
  NOW() as ahora,
  CURRENT_DATE::text || ' ' || CURRENT_TIME::text as fecha_hora_completa;

-- PASO 4: Ver pedidos que fueron actualizados HOY (sin importar sent_at)
SELECT 
  o.id,
  o.order_number,
  o.status,
  o.sent_at,
  o.updated_at,
  o.updated_at::date as fecha_update,
  o.total_amount,
  COALESCE(c.full_name, 'Cliente sin nombre') as cliente
FROM public.orders o
LEFT JOIN public.customers c ON c.id = o.customer_id
WHERE o.updated_at::date = CURRENT_DATE
  AND o.status IN ('sent', 'devolución')
ORDER BY o.updated_at DESC;

