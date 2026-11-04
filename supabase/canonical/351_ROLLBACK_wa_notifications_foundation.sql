-- 351_ROLLBACK_wa_notifications_foundation.sql
-- Revierte 351 por completo. Seguro solo si 352 ya se revirtió antes (o nunca
-- se aplicó): las funciones de 352 leen estas tablas.
--
-- Estas 4 tablas son nuevas y (en la fase de piloto) no deberían tener datos
-- operativos reales todavía; aun así, revisar el conteo de filas antes de
-- correr esto si ya se usó en producción.

DROP TRIGGER IF EXISTS wa_outbox_set_updated_at ON public.wa_outbox;
DROP TRIGGER IF EXISTS wa_channels_set_updated_at ON public.wa_channels;
DROP TRIGGER IF EXISTS wa_settings_set_updated_at ON public.wa_settings;

DROP TABLE IF EXISTS public.wa_webhook_events CASCADE;
DROP TABLE IF EXISTS public.wa_outbox CASCADE;
DROP TABLE IF EXISTS public.wa_channels CASCADE;
DROP TABLE IF EXISTS public.wa_settings CASCADE;

SELECT pg_notify('pgrst', 'reload schema');
