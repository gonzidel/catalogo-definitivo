-- 352b_fix_wa_expiry_candidates_privilege_leak.sql
--
-- Aplicado en producción el 2026-09-22, inmediatamente después de 352, tras
-- verificación post-deploy (no fue parte del SQL presentado originalmente).
--
-- Hallazgo: fn_wa_expiry_candidates() (helper interno con nombres, teléfonos
-- y pedidos de clientas) quedó ejecutable por `anon` y por `authenticated`.
-- `REVOKE ALL ... FROM PUBLIC` (como en 352) no alcanza en este proyecto:
-- existen default privileges que otorgan EXECUTE a anon/authenticated en
-- toda función nueva, por rol, independientemente del revoke a PUBLIC.
--
-- Verificado con has_function_privilege() antes y después del fix, y con
-- `SET ROLE anon` contra wa_settings/wa_outbox (RLS sí filtraba esas dos
-- tablas a 0 filas — ese patrón estaba bien; solo la función helper sin RLS
-- estaba expuesta). Las dos RPC públicas (rpc_wa_preview_expiry_events,
-- rpc_wa_enqueue_expiry_events) siguen teniendo el mismo patrón que el resto
-- del admin (EXECUTE otorgado a nivel Postgres, pero bloqueadas por su propio
-- chequeo interno `IF NOT EXISTS (SELECT 1 FROM admins ...)`).
--
-- Rollback: no aplica (revertir esto reabriría el hallazgo). Si hace falta
-- deshacer 352 completo, usar 352_ROLLBACK_wa_expiry_events_logic.sql (dropea
-- la función igual).

REVOKE EXECUTE ON FUNCTION public.fn_wa_expiry_candidates() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_wa_expiry_candidates() FROM anon;

SELECT pg_notify('pgrst', 'reload schema');
