-- 329_ROLLBACK_search_admin.sql
-- Quita admin de vocabulario. No toca search_keywords/aliases ni search_events.
-- No reabre INSERT/UPDATE/DELETE de anon sobre el diccionario.

DROP FUNCTION IF EXISTS public.search_admin_resolved_usage(integer);
DROP FUNCTION IF EXISTS public.search_admin_resolution_usage(integer);
DROP FUNCTION IF EXISTS public.search_admin_grouped_queries(integer, text);
DROP FUNCTION IF EXISTS public.search_admin_dashboard_stats();
DROP FUNCTION IF EXISTS public.search_admin_require();

DROP TRIGGER IF EXISTS trg_search_ignored_terms_normalize ON public.search_ignored_terms;
DROP FUNCTION IF EXISTS public.search_ignored_terms_normalize_trg();
DROP TABLE IF EXISTS public.search_ignored_terms;
