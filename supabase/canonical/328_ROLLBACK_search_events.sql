-- 328_ROLLBACK_search_events.sql
-- Quita analytics operativo del buscador. No toca keywords/aliases ni catálogo.

DROP POLICY IF EXISTS search_events_select_admin ON public.search_events;
DROP POLICY IF EXISTS search_events_insert_public ON public.search_events;
DROP TABLE IF EXISTS public.search_events;
