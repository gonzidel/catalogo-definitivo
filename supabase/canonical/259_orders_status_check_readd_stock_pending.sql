-- 259_orders_status_check_readd_stock_pending.sql
--
-- Motivo del fix:
--   La migracion 235_fix_rpc_customer_cancel_order.sql recreo
--   orders_status_check para sumar 'cancelled', pero al hacerlo se perdio
--   'stock_pending' (agregado antes en 167_orders_status_add_stock_pending.sql).
--
--   Confirmado en vivo contra produccion (fyl-core, 2026-08-01):
--     SELECT pg_get_constraintdef(c.oid) ... -- solo devuelve:
--     CHECK (status = ANY (ARRAY['active','closing_soon','closed','sent',
--                                 'expired','devolución','cancelled']))
--
--   'stock_pending' sigue escribiendose activamente desde:
--     - admin/order-creator.js (fallo de stock al crear/editar pedido admin)
--     - nj/lib/supabase/order-create.ts / order-edit.ts (idem, flujo nuevo)
--
--   Cualquier caso real de falla de stock en esos flujos revienta hoy con
--   "new row for relation orders violates check constraint orders_status_check"
--   en vez de dejar el pedido visible en la columna "Stock Pendiente".
--
-- Cambio: recrear el CHECK sumando 'stock_pending' al set ya vigente
-- (no se quita ni se modifica ningun otro valor).
--
-- Riesgo: BAJO. Solo amplia el dominio permitido; no reescribe filas
-- existentes ni cambia comportamiento de ninguna RPC.
--
-- Rollback: volver a recrear el CHECK sin 'stock_pending' (ver seccion final).

ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_status_check;

ALTER TABLE public.orders
  ADD CONSTRAINT orders_status_check
  CHECK (status IN (
    'active',
    'closing_soon',
    'closed',
    'sent',
    'expired',
    'devolución',
    'cancelled',
    'stock_pending'
  ));

-- =============================================================================
-- VERIFICACION POST-DEPLOY (ejecutar manualmente)
-- =============================================================================
-- SELECT pg_get_constraintdef(c.oid)
-- FROM pg_constraint c
-- JOIN pg_class t ON t.oid = c.conrelid
-- WHERE t.relname = 'orders' AND c.conname = 'orders_status_check';
--
-- Debe incluir 'stock_pending' en el array.

-- =============================================================================
-- ROLLBACK (ejecutar manualmente si hiciera falta revertir)
-- =============================================================================
-- ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_status_check;
-- ALTER TABLE public.orders ADD CONSTRAINT orders_status_check
--   CHECK (status IN ('active','closing_soon','closed','sent','expired','devolución','cancelled'));
