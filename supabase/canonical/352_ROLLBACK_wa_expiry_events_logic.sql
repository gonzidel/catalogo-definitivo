-- 352_ROLLBACK_wa_expiry_events_logic.sql
-- Revierte 352. Seguro de correr en cualquier momento (no dropea las tablas
-- de 351, que pueden tener filas encoladas útiles para revisar a mano).

DROP FUNCTION IF EXISTS public.rpc_wa_enqueue_expiry_events();
DROP FUNCTION IF EXISTS public.rpc_wa_preview_expiry_events();
DROP FUNCTION IF EXISTS public.fn_wa_expiry_candidates();
DROP FUNCTION IF EXISTS public.fn_wa_format_deadline_es(timestamptz);
DROP FUNCTION IF EXISTS public.fn_wa_phone_e164(text);

SELECT pg_notify('pgrst', 'reload schema');
