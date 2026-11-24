-- 383_ROLLBACK_tv_local_settings.sql
DROP POLICY IF EXISTS tv_local_settings_admin_insert ON public.tv_local_settings;
DROP POLICY IF EXISTS tv_local_settings_admin_update ON public.tv_local_settings;
DROP POLICY IF EXISTS tv_local_settings_public_select ON public.tv_local_settings;
DROP TABLE IF EXISTS public.tv_local_settings;
SELECT pg_notify('pgrst', 'reload schema');
