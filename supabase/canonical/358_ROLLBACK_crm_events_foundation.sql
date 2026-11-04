-- 358_ROLLBACK_crm_events_foundation.sql
--
-- Revierte 358 por completo: corta el cron, borra el trigger de orders, las
-- funciones y las tablas nuevas. Seguro en cualquier momento — no afecta
-- ningún dato de orders/customers, solo el subsistema nuevo de eventos CRM.
-- Si crm_event_outbox tiene filas 'queued' sin despachar, se pierden (no se
-- reenvían a YCloud).

SELECT cron.unschedule('crm-events-dispatch');

DROP TRIGGER IF EXISTS orders_after_insert_enqueue_crm_event ON public.orders;
DROP FUNCTION IF EXISTS public.trg_orders_enqueue_crm_event();
DROP FUNCTION IF EXISTS public.rpc_crm_dispatch_trigger();

DROP TABLE IF EXISTS public.crm_event_outbox;
DROP TABLE IF EXISTS public.crm_settings;

-- El secreto en Vault se deja (no hace daño quedarse huérfano; borrarlo
-- requiere vault.delete_secret y no es necesario para el rollback).

SELECT pg_notify('pgrst', 'reload schema');
