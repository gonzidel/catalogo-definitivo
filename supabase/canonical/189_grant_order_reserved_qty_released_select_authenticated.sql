-- 189_grant_order_reserved_qty_released_select_authenticated.sql
--
-- Complemento de 188: permitir que usuarios autenticados (admin en panel)
-- lean la tabla ledger desde admin/stock-audit.js sin usar service_role.
-- Solo SELECT; escritura sigue siendo trigger + función SECURITY DEFINER.

GRANT SELECT ON TABLE public.order_reserved_qty_released TO authenticated;

COMMENT ON TABLE public.order_reserved_qty_released IS
  'Ledger idempotente (188). SELECT concedido a authenticated para lectura en panel de auditoría.';

SELECT pg_notify('pgrst', 'reload schema');
