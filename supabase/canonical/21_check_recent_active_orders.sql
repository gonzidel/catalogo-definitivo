-- 21_check_recent_active_orders.sql — Verificar pedidos activos recientes
-- Este script verifica si hay pedidos activos recientes y por qué no aparecen

-- Ver pedidos "active" recientes con sus items y customers
SELECT 
  o.id,
  o.order_number,
  o.status,
  o.customer_id,
  o.total_amount,
  o.created_at,
  c.full_name as customer_name,
  c.is_temporary,
  c.pending_customer_email,
  (SELECT COUNT(*) FROM public.order_items oi WHERE oi.order_id = o.id) as items_count,
  (SELECT json_agg(json_build_object('status', status, 'product_name', product_name)) 
   FROM public.order_items oi WHERE oi.order_id = o.id) as items_status
FROM public.orders o
LEFT JOIN public.customers c ON c.id = o.customer_id
WHERE o.status = 'active'
ORDER BY o.created_at DESC
LIMIT 10;

-- Ver todos los pedidos recientes (cualquier status)
SELECT 
  o.id,
  o.order_number,
  o.status,
  o.customer_id,
  o.total_amount,
  o.created_at,
  c.full_name as customer_name,
  c.is_temporary,
  (SELECT COUNT(*) FROM public.order_items oi WHERE oi.order_id = o.id) as items_count
FROM public.orders o
LEFT JOIN public.customers c ON c.id = o.customer_id
ORDER BY o.created_at DESC
LIMIT 20;


