-- 277_cod_remittance_date_formats.sql
--
-- Amplía public._cod_parse_remittance_date para formatos reales de planilla:
--   20/07/2026 | 20-07-2026 | 20/7/2026
--   20 jul 2026 | 20 JUL 2026 | 20 julio 2026 | 20 jul. 2026
--
-- Siempre día/mes/año. Rechaza ISO (YYYY-MM-DD) y mes-primero (jul 20 2026).
-- NO reaplicar 276. NO tocar rpc_cod_create_remittance salvo que use este helper.
--
-- NO APLICAR en producción sin aprobación explícita.

CREATE OR REPLACE FUNCTION public._cod_parse_remittance_date(p_raw text)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v text;
  v_day int;
  v_month int;
  v_year int;
  v_month_token text;
  v_date date;
BEGIN
  v := trim(COALESCE(p_raw, ''));
  IF v = '' THEN
    RAISE EXCEPTION 'Fecha vacía';
  END IF;

  -- Colapsar espacios.
  v := regexp_replace(v, '\s+', ' ', 'g');

  -- ISO / año primero → rechazo (no ambiguo / no US).
  IF v ~ '^\d{4}-\d{2}-\d{2}' THEN
    RAISE EXCEPTION 'Fecha inválida. Ej.: 20/07/2026 o 20 jul 2026';
  END IF;

  -- Numérico: DD/MM/YYYY o DD-MM-YYYY (día/mes/año).
  IF v ~ '^\d{1,2}[/-]\d{1,2}[/-]\d{4}$' THEN
    v := replace(v, '-', '/');
    v_day := split_part(v, '/', 1)::int;
    v_month := split_part(v, '/', 2)::int;
    v_year := split_part(v, '/', 3)::int;
  ELSIF v ~ '^\d{1,2} [[:alpha:].]+ \d{4}$' THEN
    -- Textual ES: "20 jul 2026" / "20 julio 2026" / "20 jul. 2026"
    v_day := split_part(v, ' ', 1)::int;
    v_year := split_part(v, ' ', 3)::int;
    v_month_token := lower(trim(both '.' from split_part(v, ' ', 2)));
    -- Quitar acentos comunes sin depender de unaccent.
    v_month_token := translate(
      v_month_token,
      'áéíóúüñÁÉÍÓÚÜÑ',
      'aeiouunAEIOUUN'
    );

    v_month := CASE v_month_token
      WHEN 'ene' THEN 1
      WHEN 'enero' THEN 1
      WHEN 'feb' THEN 2
      WHEN 'febrero' THEN 2
      WHEN 'mar' THEN 3
      WHEN 'marzo' THEN 3
      WHEN 'abr' THEN 4
      WHEN 'abril' THEN 4
      WHEN 'may' THEN 5
      WHEN 'mayo' THEN 5
      WHEN 'jun' THEN 6
      WHEN 'junio' THEN 6
      WHEN 'jul' THEN 7
      WHEN 'julio' THEN 7
      WHEN 'ago' THEN 8
      WHEN 'agosto' THEN 8
      WHEN 'sep' THEN 9
      WHEN 'sept' THEN 9
      WHEN 'septiembre' THEN 9
      WHEN 'oct' THEN 10
      WHEN 'octubre' THEN 10
      WHEN 'nov' THEN 11
      WHEN 'noviembre' THEN 11
      WHEN 'dic' THEN 12
      WHEN 'diciembre' THEN 12
      ELSE NULL
    END;

    IF v_month IS NULL THEN
      RAISE EXCEPTION 'Fecha inválida. Ej.: 20/07/2026 o 20 jul 2026';
    END IF;
  ELSE
    RAISE EXCEPTION 'Fecha inválida. Ej.: 20/07/2026 o 20 jul 2026';
  END IF;

  IF v_month < 1 OR v_month > 12 OR v_day < 1 OR v_day > 31 OR v_year < 2000 OR v_year > 2100 THEN
    RAISE EXCEPTION 'Fecha fuera de rango';
  END IF;

  BEGIN
    v_date := make_date(v_year, v_month, v_day);
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'Fecha inexistente';
  END;

  RETURN v_date;
END;
$fn$;

REVOKE ALL ON FUNCTION public._cod_parse_remittance_date(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._cod_parse_remittance_date(text) FROM anon;
REVOKE ALL ON FUNCTION public._cod_parse_remittance_date(text) FROM authenticated;

COMMENT ON FUNCTION public._cod_parse_remittance_date(text) IS
  'Parsea fecha de planilla COD (DD/MM/YYYY, DD-MM-YYYY o día + mes ES + año). Solo día/mes/año.';
