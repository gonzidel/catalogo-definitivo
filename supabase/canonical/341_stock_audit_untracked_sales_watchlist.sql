-- 341_stock_audit_untracked_sales_watchlist.sql
--
-- Auditoria (SOLO LECTURA, sin cambios de comportamiento en checkout/carrito/ventas):
-- expone los eventos donde se confirmo una venta/apartado "como si tuviera stock"
-- sin descontar realmente variant_size_warehouse_stock, que es la unica fuente
-- de verdad que lee el catalogo online / rpc_checkout_cart (331).
--
-- Dos mecanismos detectados en la auditoria 2026-09-14 (caso A56971 / Yamila
-- Aguirre, 3 items "missing" con order_item_stock_sources coincidiendo exacto
-- con el momento del checkout -- el checkout tomo stock que el ledger decia
-- tener pero que fisicamente no estaba):
--
--   1) Venta publica "vender sin stock confirmado" (admin/public-sales.js
--      `sellWithoutStock`, rpc_create_public_sale con qty_venta_publico=0 y
--      qty_general=0 explicitos). Efecto: NO se toca variant_size_warehouse_stock,
--      NO queda ningun rastro en order_item_stock_sources (public_sale_items es
--      una tabla aparte de orders). Si el conteo previo ya estaba mal, esto deja
--      flotando un "credito fantasma" para siempre.
--
--   2) Alta manual admin sin stock verificado (admin_confirmed_missing=true via
--      rpc_admin_manual_inject_and_deduct, 179). Este camino SI queda trazado
--      (stock_history + order_item_stock_sources, efecto neto 0), pero sigue
--      siendo una confirmacion manual sin verificacion real del sistema y vale
--      la pena tenerlo en la misma watchlist para revision fisica.
--
-- No modifica ninguna tabla, funcion ni RPC existente. No cambia disponibilidad
-- mostrada en el catalogo. Solo agrega 2 vistas para que el equipo pueda revisar
-- fisicamente los talles marcados antes de que un cliente online los compre.
--
-- Riesgo: BAJO (solo SELECT sobre datos existentes, mismo patron de permisos
-- que las vistas de 144_stock_audit_readonly_views.sql).
-- Rollback: 341_ROLLBACK_stock_audit_untracked_sales_watchlist.sql

-- ============================================================================
-- 1) Detalle evento por evento
-- ============================================================================
CREATE OR REPLACE VIEW public.vw_stock_audit_untracked_sales AS
SELECT
  'public_sale_sin_stock'::text AS source_type,
  psi.created_at AS event_at,
  pv.product_id,
  COALESCE(p.name, psi.product_name) AS product_name,
  psi.variant_id,
  pv.color AS variant_color,
  pv.sku AS variant_sku,
  NULLIF(TRIM(COALESCE(psi.sold_size_normalized::text, '')), '') AS size,
  psi.qty,
  psi.sale_id AS reference_id,
  ps.sold_by AS admin_user_id,
  'sell_without_stock: venta publica confirmada sin descuento en variant_size_warehouse_stock (sistema ya mostraba 0/0 en ese talle)'::text AS reason
FROM public.public_sale_items psi
JOIN public.public_sales ps ON ps.id = psi.sale_id
LEFT JOIN public.product_variants pv ON pv.id = psi.variant_id
LEFT JOIN public.products p ON p.id = pv.product_id
WHERE psi.variant_id IS NOT NULL
  AND COALESCE(psi.is_return, false) = false
  AND ps.voided_at IS NULL
  AND psi.qty_venta_publico IS NOT NULL
  AND psi.qty_general IS NOT NULL
  AND psi.qty_venta_publico = 0
  AND psi.qty_general = 0

UNION ALL

SELECT
  'admin_order_confirmado_sin_verificar'::text AS source_type,
  oi.created_at AS event_at,
  pv.product_id,
  oi.product_name,
  oi.variant_id,
  oi.color AS variant_color,
  pv.sku AS variant_sku,
  NULLIF(TRIM(COALESCE(oi.size::text, '')), '') AS size,
  oi.quantity AS qty,
  oi.order_id AS reference_id,
  o.created_by_user_id AS admin_user_id,
  'admin_confirmed_missing: pedido admin marcado apartado por confirmacion manual (neto stock = 0 via rpc_admin_manual_inject_and_deduct), sin verificacion del sistema'::text AS reason
FROM public.order_items oi
JOIN public.orders o ON o.id = oi.order_id
LEFT JOIN public.product_variants pv ON pv.id = oi.variant_id
WHERE oi.variant_id IS NOT NULL
  AND COALESCE(oi.admin_confirmed_missing, false) = true
  AND oi.status IN ('picked', 'missing')
  AND NULLIF(TRIM(COALESCE(oi.size::text, '')), '') IS NOT NULL;

COMMENT ON VIEW public.vw_stock_audit_untracked_sales IS
  '341: eventos donde se vendio/aparto un talle sin descontar realmente variant_size_warehouse_stock (venta publica sell_without_stock o alta admin admin_confirmed_missing). Cada fila es candidata a generar overselling online si el conteo previo ya estaba inflado.';

-- ============================================================================
-- 2) Agregado accionable por variante+talle (ultimos 30 dias)
-- ============================================================================
CREATE OR REPLACE VIEW public.vw_stock_audit_untracked_sales_watchlist AS
SELECT
  variant_id,
  product_name,
  variant_color,
  variant_sku,
  size,
  count(*)::int AS untracked_events_30d,
  sum(qty)::int AS untracked_qty_30d,
  max(event_at) AS last_event_at,
  array_agg(DISTINCT source_type) AS source_types
FROM public.vw_stock_audit_untracked_sales
WHERE event_at >= now() - interval '30 days'
GROUP BY variant_id, product_name, variant_color, variant_sku, size
ORDER BY last_event_at DESC;

COMMENT ON VIEW public.vw_stock_audit_untracked_sales_watchlist IS
  '341: agregado por variante+talle de eventos "sin descuento real de stock" en los ultimos 30 dias. Priorizar conteo fisico de estos talles antes de que el catalogo online los venda como disponibles.';

GRANT SELECT ON public.vw_stock_audit_untracked_sales TO authenticated;
GRANT SELECT ON public.vw_stock_audit_untracked_sales_watchlist TO authenticated;

SELECT pg_notify('pgrst', 'reload schema');
