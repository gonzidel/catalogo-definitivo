-- 210_security_hardening_indexes_concurrent.sql
--
-- Indices criticos derivados de la auditoria viva FYL.
-- IMPORTANTE: ejecutar cada sentencia fuera de cualquier transaction block.
-- No usar runners que envuelvan migraciones completas en BEGIN/COMMIT.
-- Preferir ventana de bajo trafico y validar locks/EXPLAIN entre grupos.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_carts_customer_status_created_at
  ON public.carts (customer_id, status, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cart_items_cart_id
  ON public.cart_items (cart_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cart_items_variant_size_status
  ON public.cart_items (variant_id, size, status)
  WHERE variant_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_customer_status_created_at
  ON public.orders (customer_id, status, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_status_updated_at
  ON public.orders (status, updated_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_created_at_desc
  ON public.orders (created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_order_items_order_id
  ON public.order_items (order_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_order_items_variant_size
  ON public.order_items (variant_id, size)
  WHERE variant_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_order_item_stock_sources_order_item_id
  ON public.order_item_stock_sources (order_item_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_order_item_stock_sources_warehouse_id
  ON public.order_item_stock_sources (warehouse_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_variant_size_wh_stock_variant_size_wh
  ON public.variant_size_warehouse_stock (variant_id, size, warehouse_id);

ANALYZE public.carts;
ANALYZE public.cart_items;
ANALYZE public.orders;
ANALYZE public.order_items;
ANALYZE public.order_item_stock_sources;
ANALYZE public.variant_size_warehouse_stock;
