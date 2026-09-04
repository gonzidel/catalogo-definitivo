-- 327_ROLLBACK_search_keywords_aliases.sql
-- Quita vocabulario de búsqueda. No toca tags ni catálogo.

DROP VIEW IF EXISTS public.search_dictionary_public;

DROP TRIGGER IF EXISTS trg_search_keywords_identity_alias ON public.search_keywords;
DROP TRIGGER IF EXISTS trg_search_keywords_normalize ON public.search_keywords;
DROP TRIGGER IF EXISTS trg_search_aliases_normalize ON public.search_aliases;

DROP FUNCTION IF EXISTS public.search_keywords_identity_alias_trg();
DROP FUNCTION IF EXISTS public.search_keywords_normalize_trg();
DROP FUNCTION IF EXISTS public.search_aliases_normalize_trg();

DROP TABLE IF EXISTS public.search_aliases;
DROP TABLE IF EXISTS public.search_keywords;

DROP FUNCTION IF EXISTS public.search_normalize_text(text);
