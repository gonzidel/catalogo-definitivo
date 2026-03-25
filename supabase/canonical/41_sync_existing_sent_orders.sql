-- 41_sync_existing_sent_orders.sql — Sincronizar pedidos ya enviados a daily_sales
-- Este script sincroniza todos los pedidos marcados como "sent" que no están en daily_sales
-- 
-- IMPORTANTE: Este script debe ejecutarse desde el SQL Editor de Supabase
-- El rol "postgres" tiene permisos para ejecutar esta función directamente

-- Opción 1: Ejecutar directamente la función RPC (recomendado desde SQL Editor)
-- La función ya tiene verificación de admin, pero cuando se ejecuta como postgres, se omite
SELECT rpc_sync_sent_orders_to_daily_sales();

-- Opción 2: Si quieres ver más detalles, ejecuta esto:
-- SELECT 
--   (rpc_sync_sent_orders_to_daily_sales())->>'success' as success,
--   (rpc_sync_sent_orders_to_daily_sales())->>'inserted' as inserted,
--   (rpc_sync_sent_orders_to_daily_sales())->>'skipped' as skipped,
--   (rpc_sync_sent_orders_to_daily_sales())->>'message' as message;

