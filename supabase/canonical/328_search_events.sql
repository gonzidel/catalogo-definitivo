-- 328_search_events.sql
-- Eventos operativos del buscador. No modifica catálogo ni ranking.
-- Rollback: 328_ROLLBACK_search_events.sql

CREATE TABLE IF NOT EXISTS public.search_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  query_original text NOT NULL,
  query_normalized text,
  query_resolved text,
  result_count integer,
  resolutions jsonb NOT NULL DEFAULT '[]'::jsonb,
  suggestion_type text,
  suggestion_label text,
  product_article text,
  result_position integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT search_events_type_chk CHECK (
    event_type IN ('search_committed', 'suggestion_selected', 'result_click')
  ),
  CONSTRAINT search_events_query_len_chk CHECK (
    char_length(query_original) BETWEEN 1 AND 200
    AND (query_normalized IS NULL OR char_length(query_normalized) BETWEEN 0 AND 200)
    AND (query_resolved IS NULL OR char_length(query_resolved) BETWEEN 0 AND 200)
  ),
  CONSTRAINT search_events_result_count_chk CHECK (
    result_count IS NULL OR result_count >= 0
  ),
  CONSTRAINT search_events_result_position_chk CHECK (
    result_position IS NULL OR result_position >= 1
  ),
  CONSTRAINT search_events_suggestion_type_chk CHECK (
    suggestion_type IS NULL OR suggestion_type IN ('tag', 'categoria', 'product')
  ),
  CONSTRAINT search_events_label_len_chk CHECK (
    suggestion_label IS NULL OR char_length(suggestion_label) <= 120
  ),
  CONSTRAINT search_events_article_len_chk CHECK (
    product_article IS NULL OR char_length(product_article) <= 80
  ),
  CONSTRAINT search_events_resolutions_size_chk CHECK (
    pg_column_size(resolutions) <= 2048
  ),
  CONSTRAINT search_events_shape_chk CHECK (
    (
      event_type = 'search_committed'
      AND result_count IS NOT NULL
    )
    OR (
      event_type = 'suggestion_selected'
      AND suggestion_label IS NOT NULL
      AND suggestion_type IS NOT NULL
    )
    OR (
      event_type = 'result_click'
      AND product_article IS NOT NULL
      AND result_position IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS search_events_type_created_idx
  ON public.search_events (event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS search_events_committed_resolved_idx
  ON public.search_events (query_resolved, created_at DESC)
  WHERE event_type = 'search_committed';

CREATE INDEX IF NOT EXISTS search_events_click_article_idx
  ON public.search_events (product_article, created_at DESC)
  WHERE event_type = 'result_click';

COMMENT ON TABLE public.search_events IS
  'Eventos operativos del buscador (aliases, zero-results, CTR). Sin PII. GA cubre el embudo.';

ALTER TABLE public.search_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.search_events FROM PUBLIC;
REVOKE ALL ON TABLE public.search_events FROM anon;
REVOKE ALL ON TABLE public.search_events FROM authenticated;

GRANT INSERT ON TABLE public.search_events TO anon, authenticated;
GRANT SELECT ON TABLE public.search_events TO authenticated;

DROP POLICY IF EXISTS search_events_insert_public ON public.search_events;
CREATE POLICY search_events_insert_public
  ON public.search_events
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS search_events_select_admin ON public.search_events;
CREATE POLICY search_events_select_admin
  ON public.search_events
  FOR SELECT
  TO authenticated
  USING (public.is_admin());
