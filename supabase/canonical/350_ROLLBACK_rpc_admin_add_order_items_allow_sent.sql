-- 350_ROLLBACK_rpc_admin_add_order_items_allow_sent.sql
-- Vuelve a la allowlist de 347 (sin `sent`).
-- Preferible: re-aplicar supabase/canonical/347_rpc_admin_add_order_items_atomic.sql

-- Patch mínimo del allowlist (el resto del cuerpo 347/350 es idéntico salvo comentarios).
-- Si hace falta rollback completo, ejecutar el archivo 347 completo.
DO $$
BEGIN
  RAISE NOTICE 'Rollback 350: re-aplicar 347_rpc_admin_add_order_items_atomic.sql completo.';
END $$;
