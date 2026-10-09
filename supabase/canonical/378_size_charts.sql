-- 378_size_charts.sql
--
-- Tablas de talles reutilizables (guía de medidas orientativa por producto).
--
-- NO es stock ni talle comercial: no toca product_variants, variant_sizes,
-- variant_size_warehouse_stock, reservas, pedidos, checkout ni el catálogo
-- público (vista/snapshot/triggers de snapshot sin cambios).
--
-- Numeración: 376 quedó libre en el repo pero 377 ya se aplicó
-- (order_total_promo_aware_377); se usa 378 para no pisar una reserva en curso.
--
-- Modelo:
--   size_charts       cabecera (nombre único, tipo de medida, archivado, version)
--   size_chart_rows   talle (texto) + medida en cm (numeric(5,2), NULL = borrador)
--   products.size_chart_id  FK opcional, una tabla como máximo por producto
--
-- Reglas:
--   - Tabla "completa" = al menos una fila y ninguna medida NULL (derivado, no
--     se guarda un estado).
--   - Solo se puede ASIGNAR una tabla completa y no archivada (trigger en
--     products, valida únicamente cuando size_chart_id cambia).
--   - Una tabla asignada no puede quedar incompleta.
--   - Archivar conserva las asignaciones existentes.
--   - Eliminar solo si ningún producto (archivados incluidos) la usa.
--   - Concurrencia optimista por `version` (no updated_at: el navegador trunca
--     timestamps a milisegundos).
--
-- Seguridad:
--   - Tablas sin acceso para anon/authenticated (ni SELECT): todo pasa por RPC.
--     RLS habilitado sin policies (denegado por defecto).
--   - RPC SECURITY DEFINER (owner postgres, BYPASSRLS) con search_path vacío;
--     la primera instrucción exige public.has_permission(auth.uid(),
--     'products', <view|edit|delete>). Sin sesión, auth.uid() es NULL y se
--     rechaza con 42501.
--   - EXECUTE solo para authenticated. Los privilegios por defecto del esquema
--     public otorgan todo a anon/authenticated/service_role sobre objetos
--     nuevos: por eso los REVOKE explícitos.
--
-- Rollback: 378_ROLLBACK_size_charts.sql
-- Tests:    378_size_charts_tests.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1) Tablas
-- ---------------------------------------------------------------------------

CREATE TABLE public.size_charts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  measure_type  text NOT NULL,
  notes         text,
  archived_at   timestamptz,
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT size_charts_name_check
    CHECK (char_length(name) BETWEEN 1 AND 80 AND name = btrim(name) AND name !~ '\s{2,}'),
  CONSTRAINT size_charts_measure_type_check
    CHECK (measure_type IN ('largo_plantilla', 'largo_pie')),
  CONSTRAINT size_charts_notes_check
    CHECK (notes IS NULL OR char_length(notes) <= 500),
  CONSTRAINT size_charts_version_check
    CHECK (version >= 1)
);

CREATE UNIQUE INDEX ux_size_charts_name_lower ON public.size_charts (lower(name));

COMMENT ON TABLE public.size_charts IS
  'canonical:378 Tablas de talles reutilizables (guía de medidas orientativa). '
  'No es stock ni talle comercial. Escritura solo vía rpc_admin_*_size_chart.';
COMMENT ON COLUMN public.size_charts.measure_type IS
  'largo_plantilla = largo de plantilla interna; largo_pie = largo del pie recomendado. '
  'Una tabla no mezcla tipos de medida.';
COMMENT ON COLUMN public.size_charts.version IS
  'Concurrencia optimista: cada RPC de escritura exige la versión leída y la incrementa.';

CREATE TABLE public.size_chart_rows (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  size_chart_id  uuid NOT NULL REFERENCES public.size_charts(id) ON DELETE CASCADE,
  position       smallint NOT NULL,
  size_label     text NOT NULL,
  size_key       text GENERATED ALWAYS AS
                   (lower(replace(regexp_replace(size_label, '\s+', '', 'g'), ',', '.'))) STORED,
  measure_cm     numeric(5,2),
  CONSTRAINT size_chart_rows_position_check CHECK (position BETWEEN 1 AND 40),
  CONSTRAINT size_chart_rows_label_check
    CHECK (char_length(size_label) BETWEEN 1 AND 12 AND size_label = btrim(size_label)),
  CONSTRAINT size_chart_rows_measure_check
    CHECK (measure_cm IS NULL OR (measure_cm >= 5 AND measure_cm <= 40)),
  CONSTRAINT size_chart_rows_chart_key_unique UNIQUE (size_chart_id, size_key),
  CONSTRAINT size_chart_rows_chart_position_unique UNIQUE (size_chart_id, position)
);

COMMENT ON TABLE public.size_chart_rows IS
  'canonical:378 Filas de una tabla de talles. measure_cm NULL = fila incompleta (borrador). '
  'size_key evita duplicados escritos distinto (35,5 = 35.5; 35 / 36 = 35/36).';

ALTER TABLE public.size_charts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.size_chart_rows ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.size_charts FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.size_chart_rows FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.size_charts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.size_chart_rows TO service_role;

-- ---------------------------------------------------------------------------
-- 2) Relación con products (columna nullable sin default: solo metadatos)
-- ---------------------------------------------------------------------------

ALTER TABLE public.products ADD COLUMN size_chart_id uuid;

ALTER TABLE public.products
  ADD CONSTRAINT products_size_chart_id_fkey
  FOREIGN KEY (size_chart_id) REFERENCES public.size_charts(id) ON DELETE RESTRICT;

CREATE INDEX ix_products_size_chart_id
  ON public.products (size_chart_id)
  WHERE size_chart_id IS NOT NULL;

COMMENT ON COLUMN public.products.size_chart_id IS
  'canonical:378 Tabla de talles orientativa (opcional, máx. una). No afecta stock ni talles comerciales.';

-- ---------------------------------------------------------------------------
-- 3) Helper interno de permisos (no ejecutable por roles públicos)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_size_chart_assert_permission(p_action text)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT coalesce(public.has_permission(v_uid, 'products', p_action), false) THEN
    RAISE EXCEPTION 'SIZE_CHART_FORBIDDEN: no tenés permiso para % tablas de talles.',
      CASE p_action WHEN 'view' THEN 'ver' WHEN 'edit' THEN 'editar' ELSE 'eliminar' END
      USING ERRCODE = '42501';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4) Guard de asignación en products
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_products_size_chart_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_archived_at timestamptz;
  v_rows integer;
  v_missing integer;
BEGIN
  IF NEW.size_chart_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.size_chart_id IS NOT DISTINCT FROM OLD.size_chart_id THEN
    RETURN NEW;
  END IF;

  -- FOR SHARE serializa contra rpc_admin_save_size_chart (FOR NO KEY UPDATE):
  -- una tabla no puede quedar incompleta mientras se la asigna.
  SELECT c.archived_at INTO v_archived_at
    FROM public.size_charts c
   WHERE c.id = NEW.size_chart_id
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN NEW; -- la FK informa el error
  END IF;

  IF v_archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'SIZE_CHART_NOT_ASSIGNABLE: la tabla de talles está archivada.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*), count(*) FILTER (WHERE r.measure_cm IS NULL)
    INTO v_rows, v_missing
    FROM public.size_chart_rows r
   WHERE r.size_chart_id = NEW.size_chart_id;

  IF v_rows = 0 OR v_missing > 0 THEN
    RAISE EXCEPTION 'SIZE_CHART_NOT_ASSIGNABLE: la tabla de talles está incompleta.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_products_size_chart_guard
  BEFORE INSERT OR UPDATE OF size_chart_id ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.fn_products_size_chart_guard();

-- ---------------------------------------------------------------------------
-- 5) RPC de lectura
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rpc_admin_size_charts_overview()
RETURNS TABLE (
  id uuid,
  name text,
  measure_type text,
  notes text,
  archived_at timestamptz,
  version integer,
  updated_at timestamptz,
  rows_count integer,
  missing_measures_count integer,
  is_complete boolean,
  products_count integer,
  archived_products_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  PERFORM public.fn_size_chart_assert_permission('view');

  RETURN QUERY
  SELECT c.id,
         c.name,
         c.measure_type,
         c.notes,
         c.archived_at,
         c.version,
         c.updated_at,
         coalesce(r.rows_count, 0),
         coalesce(r.missing_count, 0),
         coalesce(r.rows_count, 0) > 0 AND coalesce(r.missing_count, 0) = 0,
         coalesce(p.total, 0),
         coalesce(p.archived, 0)
    FROM public.size_charts c
    LEFT JOIN LATERAL (
      SELECT count(*)::integer AS rows_count,
             count(*) FILTER (WHERE sr.measure_cm IS NULL)::integer AS missing_count
        FROM public.size_chart_rows sr
       WHERE sr.size_chart_id = c.id
    ) r ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::integer AS total,
             count(*) FILTER (WHERE pr.status = 'archived')::integer AS archived
        FROM public.products pr
       WHERE pr.size_chart_id = c.id
    ) p ON true
   ORDER BY c.archived_at IS NOT NULL, lower(c.name);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_admin_get_size_chart(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result jsonb;
BEGIN
  PERFORM public.fn_size_chart_assert_permission('view');

  -- Una sola sentencia: cabecera, versión, filas y uso del mismo snapshot.
  SELECT jsonb_build_object(
           'id', c.id,
           'name', c.name,
           'measure_type', c.measure_type,
           'notes', c.notes,
           'archived_at', c.archived_at,
           'version', c.version,
           'updated_at', c.updated_at,
           'rows', coalesce((
             SELECT jsonb_agg(jsonb_build_object(
                      'position', r.position,
                      'size_label', r.size_label,
                      'measure_cm', r.measure_cm) ORDER BY r.position)
               FROM public.size_chart_rows r
              WHERE r.size_chart_id = c.id), '[]'::jsonb),
           'products_count', (
             SELECT count(*) FROM public.products pr WHERE pr.size_chart_id = c.id),
           'archived_products_count', (
             SELECT count(*) FROM public.products pr
              WHERE pr.size_chart_id = c.id AND pr.status = 'archived'))
    INTO v_result
    FROM public.size_charts c
   WHERE c.id = p_id;

  IF v_result IS NULL THEN
    RAISE EXCEPTION 'SIZE_CHART_NOT_FOUND: la tabla de talles no existe.' USING ERRCODE = 'P0001';
  END IF;

  RETURN v_result || jsonb_build_object(
    'is_complete',
    jsonb_array_length(v_result->'rows') > 0
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_result->'rows') e
         WHERE jsonb_typeof(e->'measure_cm') = 'null'));
END;
$$;

-- ---------------------------------------------------------------------------
-- 6) RPC de escritura
-- ---------------------------------------------------------------------------

-- p_id NULL = crear (p_expected_version se ignora).
-- p_rows: [{"size_label": "35", "measure_cm": 22.5 | null}, ...] en el orden a mostrar.
CREATE OR REPLACE FUNCTION public.rpc_admin_save_size_chart(
  p_id uuid,
  p_expected_version integer,
  p_name text,
  p_measure_type text,
  p_notes text,
  p_rows jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_name text;
  v_notes text;
  v_rows jsonb := coalesce(p_rows, '[]'::jsonb);
  v_row jsonb;
  v_idx integer := 0;
  v_label text;
  v_key text;
  v_measure numeric;
  v_keys text[] := '{}';
  v_labels text[] := '{}';
  v_measures numeric[] := '{}';
  v_complete boolean;
  v_chart_id uuid;
  v_version integer;
  v_current_version integer;
  v_in_use integer := 0;
  v_constraint text;
BEGIN
  PERFORM public.fn_size_chart_assert_permission('edit');

  v_name := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  IF char_length(v_name) < 1 OR char_length(v_name) > 80 THEN
    RAISE EXCEPTION 'SIZE_CHART_INVALID_NAME: el nombre es obligatorio (máximo 80 caracteres).'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_measure_type IS NULL OR p_measure_type NOT IN ('largo_plantilla', 'largo_pie') THEN
    RAISE EXCEPTION 'SIZE_CHART_INVALID_MEASURE_TYPE: tipo de medida inválido.'
      USING ERRCODE = 'P0001';
  END IF;

  v_notes := nullif(btrim(coalesce(p_notes, '')), '');
  IF v_notes IS NOT NULL AND char_length(v_notes) > 500 THEN
    RAISE EXCEPTION 'SIZE_CHART_INVALID_NOTES: las notas admiten hasta 500 caracteres.'
      USING ERRCODE = 'P0001';
  END IF;

  IF jsonb_typeof(v_rows) <> 'array' THEN
    RAISE EXCEPTION 'SIZE_CHART_INVALID_ROWS: formato de filas inválido.' USING ERRCODE = 'P0001';
  END IF;
  IF jsonb_array_length(v_rows) > 40 THEN
    RAISE EXCEPTION 'SIZE_CHART_INVALID_ROWS: máximo 40 talles por tabla.' USING ERRCODE = 'P0001';
  END IF;

  FOR v_row IN SELECT e.value FROM jsonb_array_elements(v_rows) e LOOP
    v_idx := v_idx + 1;

    IF jsonb_typeof(v_row) <> 'object' THEN
      RAISE EXCEPTION 'SIZE_CHART_INVALID_ROWS: fila % con formato inválido.', v_idx
        USING ERRCODE = 'P0001';
    END IF;

    v_label := btrim(regexp_replace(
                 regexp_replace(coalesce(v_row->>'size_label', ''), '\s+', ' ', 'g'),
                 '\s*/\s*', '/', 'g'));
    IF char_length(v_label) < 1 OR char_length(v_label) > 12 OR v_label ~ '[[:cntrl:]]' THEN
      RAISE EXCEPTION 'SIZE_CHART_INVALID_SIZE: el talle de la fila % es inválido (1 a 12 caracteres).', v_idx
        USING ERRCODE = 'P0001';
    END IF;

    v_key := lower(replace(regexp_replace(v_label, '\s+', '', 'g'), ',', '.'));
    IF v_key = ANY (v_keys) THEN
      RAISE EXCEPTION 'SIZE_CHART_DUPLICATE_SIZE: el talle % está repetido.', v_label
        USING ERRCODE = 'P0001';
    END IF;

    IF NOT (v_row ? 'measure_cm') OR jsonb_typeof(v_row->'measure_cm') = 'null' THEN
      v_measure := NULL;
    ELSIF jsonb_typeof(v_row->'measure_cm') <> 'number' THEN
      RAISE EXCEPTION 'SIZE_CHART_INVALID_MEASURE: la medida del talle % debe ser numérica.', v_label
        USING ERRCODE = 'P0001';
    ELSE
      v_measure := (v_row->>'measure_cm')::numeric;
      IF v_measure <> round(v_measure, 2) OR v_measure < 5 OR v_measure > 40 THEN
        RAISE EXCEPTION 'SIZE_CHART_INVALID_MEASURE: la medida del talle % debe estar entre 5 y 40 cm (hasta 2 decimales).', v_label
          USING ERRCODE = 'P0001';
      END IF;
    END IF;

    v_keys := array_append(v_keys, v_key);
    v_labels := array_append(v_labels, v_label);
    v_measures := array_append(v_measures, v_measure);
  END LOOP;

  v_complete := v_idx > 0 AND array_position(v_measures, NULL) IS NULL;

  BEGIN
    IF p_id IS NULL THEN
      INSERT INTO public.size_charts (name, measure_type, notes, created_by, updated_by)
      VALUES (v_name, p_measure_type, v_notes, v_uid, v_uid)
      RETURNING id, version INTO v_chart_id, v_version;
    ELSE
      -- NO KEY UPDATE: no bloquea el FK (KEY SHARE) pero sí el guard (FOR SHARE).
      SELECT c.version INTO v_current_version
        FROM public.size_charts c
       WHERE c.id = p_id
       FOR NO KEY UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'SIZE_CHART_NOT_FOUND: la tabla de talles no existe.' USING ERRCODE = 'P0001';
      END IF;
      IF p_expected_version IS NULL OR v_current_version <> p_expected_version THEN
        RAISE EXCEPTION 'SIZE_CHART_VERSION_CONFLICT: otra persona modificó esta tabla. Recargala antes de guardar.'
          USING ERRCODE = 'P0001';
      END IF;

      SELECT count(*) INTO v_in_use FROM public.products pr WHERE pr.size_chart_id = p_id;
      IF v_in_use > 0 AND NOT v_complete THEN
        RAISE EXCEPTION 'SIZE_CHART_IN_USE_INCOMPLETE: la tabla está asignada a % producto(s); completá todas las medidas.', v_in_use
          USING ERRCODE = 'P0001';
      END IF;

      UPDATE public.size_charts c
         SET name = v_name,
             measure_type = p_measure_type,
             notes = v_notes,
             version = c.version + 1,
             updated_at = now(),
             updated_by = v_uid
       WHERE c.id = p_id
      RETURNING c.id, c.version INTO v_chart_id, v_version;

      DELETE FROM public.size_chart_rows r WHERE r.size_chart_id = p_id;
    END IF;

    INSERT INTO public.size_chart_rows (size_chart_id, position, size_label, measure_cm)
    SELECT v_chart_id, t.ord::smallint, t.label, t.measure
      FROM unnest(v_labels, v_measures) WITH ORDINALITY AS t(label, measure, ord);
  EXCEPTION
    WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint = 'ux_size_charts_name_lower' THEN
        RAISE EXCEPTION 'SIZE_CHART_NAME_TAKEN: ya existe una tabla llamada "%".', v_name
          USING ERRCODE = 'P0001';
      END IF;
      RAISE;
  END;

  RETURN jsonb_build_object(
    'id', v_chart_id,
    'version', v_version,
    'is_complete', v_complete,
    'rows_count', v_idx,
    'products_count', v_in_use);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_admin_set_size_chart_archived(
  p_id uuid,
  p_expected_version integer,
  p_archived boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_current_version integer;
  v_version integer;
  v_archived_at timestamptz;
BEGIN
  PERFORM public.fn_size_chart_assert_permission('edit');

  IF p_archived IS NULL THEN
    RAISE EXCEPTION 'SIZE_CHART_INVALID_ARCHIVED: falta indicar si se archiva o se reactiva.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT c.version INTO v_current_version
    FROM public.size_charts c
   WHERE c.id = p_id
   FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SIZE_CHART_NOT_FOUND: la tabla de talles no existe.' USING ERRCODE = 'P0001';
  END IF;
  IF p_expected_version IS NULL OR v_current_version <> p_expected_version THEN
    RAISE EXCEPTION 'SIZE_CHART_VERSION_CONFLICT: otra persona modificó esta tabla. Recargala antes de guardar.'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.size_charts c
     SET archived_at = CASE WHEN p_archived THEN coalesce(c.archived_at, now()) ELSE NULL END,
         version = c.version + 1,
         updated_at = now(),
         updated_by = auth.uid()
   WHERE c.id = p_id
  RETURNING c.version, c.archived_at INTO v_version, v_archived_at;

  RETURN jsonb_build_object('id', p_id, 'version', v_version, 'archived_at', v_archived_at);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_admin_delete_size_chart(
  p_id uuid,
  p_expected_version integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_current_version integer;
  v_in_use integer;
BEGIN
  PERFORM public.fn_size_chart_assert_permission('delete');

  SELECT c.version INTO v_current_version
    FROM public.size_charts c
   WHERE c.id = p_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SIZE_CHART_NOT_FOUND: la tabla de talles no existe.' USING ERRCODE = 'P0001';
  END IF;
  IF p_expected_version IS NULL OR v_current_version <> p_expected_version THEN
    RAISE EXCEPTION 'SIZE_CHART_VERSION_CONFLICT: otra persona modificó esta tabla. Recargala antes de eliminar.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO v_in_use FROM public.products pr WHERE pr.size_chart_id = p_id;
  IF v_in_use > 0 THEN
    RAISE EXCEPTION 'SIZE_CHART_IN_USE_DELETE: la tabla está asignada a % producto(s); archivala en lugar de eliminarla.', v_in_use
      USING ERRCODE = 'P0001';
  END IF;

  BEGIN
    DELETE FROM public.size_charts c WHERE c.id = p_id;
  EXCEPTION
    WHEN foreign_key_violation THEN
      RAISE EXCEPTION 'SIZE_CHART_IN_USE_DELETE: la tabla está asignada a productos; archivala en lugar de eliminarla.'
        USING ERRCODE = 'P0001';
  END;

  RETURN jsonb_build_object('id', p_id, 'deleted', true);
END;
$$;

-- ---------------------------------------------------------------------------
-- 7) Privilegios de ejecución
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.fn_size_chart_assert_permission(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_products_size_chart_guard() FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.rpc_admin_size_charts_overview() FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.rpc_admin_get_size_chart(uuid) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.rpc_admin_save_size_chart(uuid, integer, text, text, text, jsonb) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.rpc_admin_set_size_chart_archived(uuid, integer, boolean) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.rpc_admin_delete_size_chart(uuid, integer) FROM PUBLIC, anon, service_role;

GRANT EXECUTE ON FUNCTION public.rpc_admin_size_charts_overview() TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_admin_get_size_chart(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_admin_save_size_chart(uuid, integer, text, text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_admin_set_size_chart_archived(uuid, integer, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_admin_delete_size_chart(uuid, integer) TO authenticated;

COMMENT ON FUNCTION public.rpc_admin_save_size_chart(uuid, integer, text, text, text, jsonb) IS
  'canonical:378 Crea (p_id NULL) o reemplaza cabecera+filas de una tabla de talles. Exige products:edit.';
COMMENT ON FUNCTION public.rpc_admin_delete_size_chart(uuid, integer) IS
  'canonical:378 Elimina una tabla sin productos asociados. Exige products:delete.';

SELECT pg_notify('pgrst', 'reload schema');

COMMIT;
