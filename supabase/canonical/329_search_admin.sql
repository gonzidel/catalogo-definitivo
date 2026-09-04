-- 329_search_admin.sql
-- Vocabulario admin: términos ignorados + RPCs de agregación.
-- No modifica tags. Rollback: 329_ROLLBACK_search_admin.sql

CREATE TABLE IF NOT EXISTS public.search_ignored_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  normalized_term text NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT search_ignored_terms_norm_uniq UNIQUE (normalized_term),
  CONSTRAINT search_ignored_terms_len_chk CHECK (
    char_length(normalized_term) BETWEEN 1 AND 200
  ),
  CONSTRAINT search_ignored_terms_reason_len_chk CHECK (
    reason IS NULL OR char_length(reason) <= 200
  )
);

CREATE OR REPLACE FUNCTION public.search_ignored_terms_normalize_trg()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  NEW.normalized_term := public.search_normalize_text(NEW.normalized_term);
  IF NEW.normalized_term IS NULL THEN
    RAISE EXCEPTION 'search_ignored_terms.normalized_term vacío tras normalizar';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_search_ignored_terms_normalize ON public.search_ignored_terms;
CREATE TRIGGER trg_search_ignored_terms_normalize
  BEFORE INSERT OR UPDATE OF normalized_term
  ON public.search_ignored_terms
  FOR EACH ROW
  EXECUTE FUNCTION public.search_ignored_terms_normalize_trg();

ALTER TABLE public.search_ignored_terms ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.search_ignored_terms FROM PUBLIC;
REVOKE ALL ON TABLE public.search_ignored_terms FROM anon;
REVOKE ALL ON TABLE public.search_ignored_terms FROM authenticated;

GRANT SELECT, INSERT, DELETE ON TABLE public.search_ignored_terms TO authenticated;

DROP POLICY IF EXISTS search_ignored_terms_admin ON public.search_ignored_terms;
CREATE POLICY search_ignored_terms_admin
  ON public.search_ignored_terms
  FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

COMMENT ON TABLE public.search_ignored_terms IS
  'Términos revisados que no deben proponerse como alias. No es vocabulario de búsqueda.';

CREATE OR REPLACE FUNCTION public.search_admin_require()
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.search_admin_dashboard_stats()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_out jsonb;
BEGIN
  PERFORM public.search_admin_require();

  SELECT jsonb_build_object(
    'searches_7d', (
      SELECT count(*) FROM public.search_events
      WHERE event_type = 'search_committed'
        AND created_at > now() - interval '7 days'
    ),
    'searches_30d', (
      SELECT count(*) FROM public.search_events
      WHERE event_type = 'search_committed'
        AND created_at > now() - interval '30 days'
    ),
    'zero_results_30d', (
      SELECT count(*) FROM public.search_events
      WHERE event_type = 'search_committed'
        AND result_count = 0
        AND created_at > now() - interval '30 days'
    ),
    'alias_used_30d', (
      SELECT count(*) FROM public.search_events
      WHERE event_type = 'search_committed'
        AND created_at > now() - interval '30 days'
        AND resolutions <> '[]'::jsonb
    ),
    'keywords_active', (
      SELECT count(*) FROM public.search_keywords WHERE active
    ),
    'aliases_active', (
      SELECT count(*)
      FROM public.search_aliases a
      JOIN public.search_keywords k ON k.id = a.keyword_id
      WHERE a.active AND k.active AND a.alias_normalized IS DISTINCT FROM k.canonical
    )
  ) INTO v_out;

  RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION public.search_admin_grouped_queries(
  p_days integer,
  p_mode text
)
RETURNS TABLE (
  query_normalized text,
  query_resolved text,
  searches integer,
  last_seen timestamptz,
  sample_original text,
  avg_result_count numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_days integer := greatest(1, least(coalesce(p_days, 30), 90));
BEGIN
  PERFORM public.search_admin_require();

  RETURN QUERY
  SELECT
    e.query_normalized,
    e.query_resolved,
    count(*)::integer AS searches,
    max(e.created_at) AS last_seen,
    (array_agg(e.query_original ORDER BY e.created_at DESC))[1] AS sample_original,
    avg(e.result_count)::numeric AS avg_result_count
  FROM public.search_events e
  WHERE e.event_type = 'search_committed'
    AND e.created_at > now() - make_interval(days => v_days)
    AND e.query_normalized IS NOT NULL
    AND (
      (p_mode = 'zero' AND e.result_count = 0)
      OR (p_mode = 'low' AND e.result_count > 0 AND e.result_count <= 2)
      OR (
        p_mode = 'unresolved'
        AND e.query_normalized = e.query_resolved
        AND e.resolutions = '[]'::jsonb
      )
    )
  GROUP BY e.query_normalized, e.query_resolved
  ORDER BY searches DESC, last_seen DESC
  LIMIT 80;
END;
$$;

CREATE OR REPLACE FUNCTION public.search_admin_resolution_usage(p_days integer)
RETURNS TABLE (
  canonical text,
  alias_input text,
  hits integer,
  last_seen timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_days integer := greatest(1, least(coalesce(p_days, 30), 90));
BEGIN
  PERFORM public.search_admin_require();

  RETURN QUERY
  SELECT
    r.canonical,
    r.alias_input,
    count(*)::integer AS hits,
    max(r.created_at) AS last_seen
  FROM (
    SELECT
      e.created_at,
      nullif(btrim(x.elem ->> 'canonical'), '') AS canonical,
      nullif(btrim(x.elem ->> 'input'), '') AS alias_input
    FROM public.search_events e
    CROSS JOIN LATERAL jsonb_array_elements(e.resolutions) AS x(elem)
    WHERE e.event_type = 'search_committed'
      AND e.created_at > now() - make_interval(days => v_days)
      AND e.resolutions <> '[]'::jsonb
  ) r
  WHERE r.canonical IS NOT NULL
  GROUP BY r.canonical, r.alias_input;
END;
$$;

CREATE OR REPLACE FUNCTION public.search_admin_resolved_usage(p_days integer)
RETURNS TABLE (
  query_resolved text,
  hits integer,
  last_seen timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_days integer := greatest(1, least(coalesce(p_days, 30), 90));
BEGIN
  PERFORM public.search_admin_require();

  RETURN QUERY
  SELECT
    e.query_resolved,
    count(*)::integer AS hits,
    max(e.created_at) AS last_seen
  FROM public.search_events e
  WHERE e.event_type = 'search_committed'
    AND e.created_at > now() - make_interval(days => v_days)
    AND e.query_resolved IS NOT NULL
    AND e.resolutions = '[]'::jsonb
  GROUP BY e.query_resolved;
END;
$$;

GRANT EXECUTE ON FUNCTION public.search_admin_require() TO authenticated;
GRANT EXECUTE ON FUNCTION public.search_admin_dashboard_stats() TO authenticated;
GRANT EXECUTE ON FUNCTION public.search_admin_grouped_queries(integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.search_admin_resolution_usage(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.search_admin_resolved_usage(integer) TO authenticated;

REVOKE ALL ON FUNCTION public.search_admin_require() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.search_admin_dashboard_stats() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.search_admin_grouped_queries(integer, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.search_admin_resolution_usage(integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.search_admin_resolved_usage(integer) FROM PUBLIC, anon;

-- Defensa en profundidad: el diccionario se lee en público, no se escribe.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.search_keywords FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.search_aliases FROM anon;
