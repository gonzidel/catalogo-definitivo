-- 327_search_keywords_aliases.sql
-- Vocabulario de búsqueda (keywords + aliases). No modifica tags.
-- Rollback: 327_ROLLBACK_search_keywords_aliases.sql

CREATE OR REPLACE FUNCTION public.search_normalize_text(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_catalog
AS $$
  SELECT nullif(
    btrim(
      regexp_replace(
        regexp_replace(
          lower(
            regexp_replace(
              normalize(coalesce(value, ''), NFD),
              E'[\\u0300-\\u036f]',
              '',
              'g'
            )
          ),
          '[-_/]+',
          ' ',
          'g'
        ),
        '\s+',
        ' ',
        'g'
      )
    ),
    ''
  );
$$;

COMMENT ON FUNCTION public.search_normalize_text(text) IS
  'Normaliza texto de búsqueda: lower, NFD, sin tildes, guiones→espacio, espacios colapsados.';

CREATE TABLE IF NOT EXISTS public.search_keywords (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical text NOT NULL,
  display_label text NOT NULL,
  kind text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT search_keywords_canonical_uniq UNIQUE (canonical),
  CONSTRAINT search_keywords_kind_chk CHECK (
    kind IS NULL OR kind IN ('product_type', 'color', 'attribute', 'commercial')
  )
);

CREATE TABLE IF NOT EXISTS public.search_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword_id uuid NOT NULL REFERENCES public.search_keywords(id) ON DELETE CASCADE,
  alias text NOT NULL,
  alias_normalized text NOT NULL,
  kind text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT search_aliases_normalized_uniq UNIQUE (alias_normalized),
  CONSTRAINT search_aliases_kind_chk CHECK (
    kind IS NULL OR kind IN (
      'plural', 'grammatical', 'abbreviation', 'commercial',
      'typo', 'spacing', 'legacy_tag'
    )
  )
);

CREATE INDEX IF NOT EXISTS search_aliases_keyword_id_idx
  ON public.search_aliases (keyword_id);

CREATE INDEX IF NOT EXISTS search_keywords_active_canonical_idx
  ON public.search_keywords (canonical)
  WHERE active;

CREATE OR REPLACE FUNCTION public.search_keywords_normalize_trg()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  NEW.canonical := public.search_normalize_text(NEW.canonical);
  IF NEW.canonical IS NULL THEN
    RAISE EXCEPTION 'search_keywords.canonical vacío tras normalizar';
  END IF;
  IF btrim(coalesce(NEW.display_label, '')) = '' THEN
    NEW.display_label := initcap(NEW.canonical);
  END IF;
  NEW.updated_at := now();

  IF EXISTS (
    SELECT 1
    FROM public.search_aliases a
    WHERE a.alias_normalized = NEW.canonical
      AND a.keyword_id IS DISTINCT FROM NEW.id
  ) THEN
    RAISE EXCEPTION
      'canonical "%" ya existe como alias de otra keyword', NEW.canonical;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_search_keywords_normalize ON public.search_keywords;
CREATE TRIGGER trg_search_keywords_normalize
  BEFORE INSERT OR UPDATE OF canonical, display_label
  ON public.search_keywords
  FOR EACH ROW
  EXECUTE FUNCTION public.search_keywords_normalize_trg();

CREATE OR REPLACE FUNCTION public.search_aliases_normalize_trg()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  NEW.alias_normalized := public.search_normalize_text(coalesce(NEW.alias_normalized, NEW.alias));
  IF NEW.alias_normalized IS NULL THEN
    RAISE EXCEPTION 'search_aliases.alias vacío tras normalizar';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.search_keywords k
    WHERE k.canonical = NEW.alias_normalized
      AND k.id IS DISTINCT FROM NEW.keyword_id
  ) THEN
    RAISE EXCEPTION
      'alias "%" choca con la keyword canónica de otro concepto', NEW.alias_normalized;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_search_aliases_normalize ON public.search_aliases;
CREATE TRIGGER trg_search_aliases_normalize
  BEFORE INSERT OR UPDATE OF alias, alias_normalized, keyword_id
  ON public.search_aliases
  FOR EACH ROW
  EXECUTE FUNCTION public.search_aliases_normalize_trg();

CREATE OR REPLACE FUNCTION public.search_keywords_identity_alias_trg()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  INSERT INTO public.search_aliases (keyword_id, alias, alias_normalized, kind)
  VALUES (NEW.id, NEW.canonical, NEW.canonical, NULL)
  ON CONFLICT (alias_normalized) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_search_keywords_identity_alias ON public.search_keywords;
CREATE TRIGGER trg_search_keywords_identity_alias
  AFTER INSERT ON public.search_keywords
  FOR EACH ROW
  EXECUTE FUNCTION public.search_keywords_identity_alias_trg();

ALTER TABLE public.search_keywords ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.search_aliases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS search_keywords_public_select ON public.search_keywords;
CREATE POLICY search_keywords_public_select
  ON public.search_keywords
  FOR SELECT
  TO anon, authenticated
  USING (active);

DROP POLICY IF EXISTS search_keywords_admin_write ON public.search_keywords;
CREATE POLICY search_keywords_admin_write
  ON public.search_keywords
  FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS search_aliases_public_select ON public.search_aliases;
CREATE POLICY search_aliases_public_select
  ON public.search_aliases
  FOR SELECT
  TO anon, authenticated
  USING (active);

DROP POLICY IF EXISTS search_aliases_admin_write ON public.search_aliases;
CREATE POLICY search_aliases_admin_write
  ON public.search_aliases
  FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

GRANT SELECT ON public.search_keywords TO anon, authenticated;
GRANT SELECT ON public.search_aliases TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.search_keywords TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.search_aliases TO authenticated;

CREATE OR REPLACE VIEW public.search_dictionary_public
WITH (security_invoker = true) AS
SELECT
  k.id AS keyword_id,
  k.canonical,
  k.display_label,
  k.kind AS keyword_kind,
  a.alias,
  a.alias_normalized,
  a.kind AS alias_kind
FROM public.search_keywords k
JOIN public.search_aliases a ON a.keyword_id = k.id
WHERE k.active AND a.active;

GRANT SELECT ON public.search_dictionary_public TO anon, authenticated;

-- Seed mínimo seguro
INSERT INTO public.search_keywords (canonical, display_label, kind) VALUES
  ('pantubota', 'Pantubota', 'product_type'),
  ('zapatilla', 'Zapatilla', 'product_type'),
  ('borcego', 'Borcego', 'product_type'),
  ('ojota', 'Ojota', 'product_type'),
  ('chinela', 'Chinela', 'product_type'),
  ('deportivo', 'Deportivo', 'attribute'),
  ('negro', 'Negro', 'color')
ON CONFLICT (canonical) DO UPDATE
  SET display_label = excluded.display_label,
      kind = excluded.kind,
      active = true;

INSERT INTO public.search_aliases (keyword_id, alias, alias_normalized, kind)
SELECT k.id, v.alias, v.alias, v.kind
FROM public.search_keywords k
JOIN (
  VALUES
    ('pantubota', 'pantubotas', 'plural'),
    ('pantubota', 'pantu bota', 'spacing'),
    ('zapatilla', 'zapatillas', 'plural'),
    ('zapatilla', 'zapa', 'abbreviation'),
    ('zapatilla', 'zapas', 'abbreviation'),
    ('borcego', 'borcegos', 'plural'),
    ('ojota', 'ojotas', 'plural'),
    ('chinela', 'chinelas', 'plural'),
    ('deportivo', 'deportiva', 'grammatical'),
    ('deportivo', 'deportivos', 'plural'),
    ('deportivo', 'deportivas', 'grammatical'),
    ('negro', 'negra', 'grammatical'),
    ('negro', 'negros', 'plural'),
    ('negro', 'negras', 'grammatical')
) AS v(canonical, alias, kind) ON v.canonical = k.canonical
ON CONFLICT (alias_normalized) DO NOTHING;

COMMENT ON TABLE public.search_keywords IS
  'Conceptos canónicos de búsqueda. Independientes de la taxonomía tags.';
COMMENT ON TABLE public.search_aliases IS
  'Equivalencias de búsqueda. alias_normalized es único en todo el diccionario.';
COMMENT ON VIEW public.search_dictionary_public IS
  'Diccionario público (anon/authenticated) para el Search Resolver del cliente.';
