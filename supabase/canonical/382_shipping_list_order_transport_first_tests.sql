-- Verificación post-382 (solo lectura).

-- 1) Las tres funciones tienen el criterio nuevo.
SELECT p.proname,
       pg_get_functiondef(p.oid) ILIKE '%COALESCE(o.transport_id, c.transport_id) = p_transport_id%' AS lista_un_transporte,
       pg_get_functiondef(p.oid) ILIKE '%o.transport_id = p_transport_id OR c.transport_id%' AS conserva_or_viejo
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('rpc_get_shipping_orders', 'rpc_get_shipping_orders_range');
-- Esperado: lista_un_transporte = true, conserva_or_viejo = false en ambas.

SELECT pg_get_functiondef('public.rpc_mark_labels_printed'::regproc) ILIKE '%transport_id = coalesce(%' AS snapshot_transporte;
-- Esperado: true.

-- 2) Grants sin cambios (sin anon).
SELECT p.proname, array_to_string(p.proacl::text[], ',') AS acl
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('rpc_get_shipping_orders', 'rpc_get_shipping_orders_range', 'rpc_mark_labels_printed');
-- Esperado: postgres, authenticated, service_role.

-- 3) Ningún pedido enviado cae en dos transportes con el criterio nuevo
--    (cada pedido resuelve a un único transport_id).
SELECT o.order_number,
       (o.sent_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date AS dia,
       t.name AS planilla
FROM public.orders o
LEFT JOIN public.customers c ON c.id = o.customer_id
LEFT JOIN public.transports t ON t.id = COALESCE(o.transport_id, c.transport_id)
WHERE o.customer_id = '3da030bb-0f5d-4147-8022-9a462e7cc4a8' -- Laura Beatriz Sotelo
  AND o.status = 'sent'
ORDER BY o.sent_at DESC
LIMIT 6;
-- Esperado: A57731 → Expreso Norte; A57476 / A57219 / A56950 → SEDE (una sola planilla cada uno).
