-- 360_transport_coverage_lookup_tests.sql
-- Solo lectura. Ejecutar en transacción:
--   BEGIN;
--   \i 360_transport_coverage_lookup_tests.sql
--   ROLLBACK;

-- Privilegios: fn_transportes_disponibles no debe ser ejecutable por
-- authenticated/anon (lección 352b) — la expone solo el Edge Function
-- (service role) al Data Connector de YCloud.
DO $$
BEGIN
  IF has_function_privilege('authenticated', 'public.fn_transportes_disponibles(text, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_transportes_disponibles(text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION '360 FAIL: fn_transportes_disponibles es ejecutable por authenticated/anon';
  END IF;
  RAISE NOTICE '360 OK: fn_transportes_disponibles no es ejecutable por authenticated/anon';
END $$;

-- Conteo de filas sembradas (mismo total que transportes-data.js: 86+6+17+328+475+92+1).
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM public.transport_coverage;
  IF v_count <> 1005 THEN
    RAISE EXCEPTION '360 FAIL: se esperaban 1005 filas en transport_coverage, hay %', v_count;
  END IF;
  RAISE NOTICE '360 OK: transport_coverage tiene 1005 filas';
END $$;

-- SEDE override: Charata (Chaco) está en destinos_transporte -> solo SEDE.
DO $$
DECLARE
  v_result text[];
BEGIN
  v_result := public.fn_transportes_disponibles('Chaco', 'Charata');
  IF v_result <> ARRAY['SEDE'] THEN
    RAISE EXCEPTION '360 FAIL: Charata (Chaco) esperaba {SEDE}, dio %', v_result;
  END IF;
  RAISE NOTICE '360 OK: Charata (Chaco) -> SEDE';
END $$;

-- Corrientes Capital: excepción explícita, solo Retira local + MyM (aunque
-- Credifin también liste "Corrientes").
DO $$
DECLARE
  v_result text[];
BEGIN
  v_result := public.fn_transportes_disponibles('Corrientes', 'Corrientes');
  IF v_result <> ARRAY['Retira local', 'MyM'] THEN
    RAISE EXCEPTION '360 FAIL: Corrientes Capital esperaba {Retira local,MyM}, dio %', v_result;
  END IF;
  RAISE NOTICE '360 OK: Corrientes Capital -> Retira local + MyM';
END $$;

-- Resistencia (Chaco): Retiro de Local -> canonicaliza a "Retira local".
-- No está en destinos_transporte (SEDE), así que no debe ganar el override.
DO $$
DECLARE
  v_result text[];
BEGIN
  v_result := public.fn_transportes_disponibles('Chaco', 'Resistencia');
  IF NOT ('Retira local' = ANY(v_result)) THEN
    RAISE EXCEPTION '360 FAIL: Resistencia (Chaco) esperaba incluir Retira local, dio %', v_result;
  END IF;
  RAISE NOTICE '360 OK: Resistencia (Chaco) -> %', v_result;
END $$;

-- Localidad solo en Credifin (sin SEDE): debe agregar Correo Argentino como
-- alternativa (regla "si no hay SEDE y no está Correo, se agrega").
DO $$
DECLARE
  v_result text[];
BEGIN
  v_result := public.fn_transportes_disponibles('Buenos Aires', 'Tandil');
  IF NOT ('Credifin' = ANY(v_result)) OR NOT ('Correo Argentino' = ANY(v_result)) THEN
    RAISE EXCEPTION '360 FAIL: Tandil (Buenos Aires) esperaba Credifin + Correo Argentino, dio %', v_result;
  END IF;
  RAISE NOTICE '360 OK: Tandil (Buenos Aires) -> %', v_result;
END $$;

-- Sin match en ninguna lista: solo Correo Argentino.
DO $$
DECLARE
  v_result text[];
BEGIN
  v_result := public.fn_transportes_disponibles('Tierra del Fuego', 'Ushuaia');
  IF v_result <> ARRAY['Correo Argentino'] THEN
    RAISE EXCEPTION '360 FAIL: localidad sin cobertura esperaba {Correo Argentino}, dio %', v_result;
  END IF;
  RAISE NOTICE '360 OK: localidad sin cobertura -> Correo Argentino';
END $$;

-- Normalización: insensible a mayúsculas/acentos (localidad con tilde escrita sin tilde).
DO $$
DECLARE
  v_result text[];
BEGIN
  v_result := public.fn_transportes_disponibles('corrientes', 'CURUZU CUATIA');
  IF v_result <> ARRAY['SEDE'] THEN
    RAISE EXCEPTION '360 FAIL: Curuzu Cuatia sin tilde/mayúsculas esperaba {SEDE}, dio %', v_result;
  END IF;
  RAISE NOTICE '360 OK: normalización de acentos/mayúsculas funciona';
END $$;

-- Input vacío: array vacío, no error.
DO $$
DECLARE
  v_result text[];
BEGIN
  v_result := public.fn_transportes_disponibles('', '');
  IF v_result <> ARRAY[]::text[] THEN
    RAISE EXCEPTION '360 FAIL: input vacío esperaba array vacío, dio %', v_result;
  END IF;
  RAISE NOTICE '360 OK: input vacío -> array vacío';
END $$;
