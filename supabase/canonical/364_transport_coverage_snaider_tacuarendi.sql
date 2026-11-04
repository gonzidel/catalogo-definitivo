-- 364_transport_coverage_snaider_tacuarendi.sql
--
-- Snaider entrega en Tacuarendí (Santa Fe), confirmado por el negocio
-- 2026-10-02 (caso clienta Daiana Elisabet Gomez, pedido A57669). No figura
-- en el Excel de scripts/import-snaider-xlsx.mjs, así que la web lo agrega en
-- client/transportes-data.js (SNAIDER_LOCALIDADES_EXTRA). Esta migración
-- sincroniza la copia del bot (public.transport_coverage, migración 360).
--
-- Dos variantes de nombre porque fn_transportes_disponibles matchea exacto
-- (normalizado): "Tacuarendi (Emb. Kilometro 421)" es el que guarda el
-- selector de perfil NJ; "Tacuarendi" el de client/data/argentina-localidades.json.
--
-- Si se re-ejecuta 360 (DELETE + seed de 1005 filas), volver a correr esta.
--
-- Rollback: 364_ROLLBACK_transport_coverage_snaider_tacuarendi.sql

INSERT INTO public.transport_coverage (source, provincia, localidad, transporte)
SELECT v.source, v.provincia, v.localidad, v.transporte
  FROM (VALUES
    ('snaider', 'Santa Fe', 'Tacuarendi', 'Transporte Snaider'),
    ('snaider', 'Santa Fe', 'Tacuarendi (Emb. Kilometro 421)', 'Transporte Snaider')
  ) AS v(source, provincia, localidad, transporte)
 WHERE NOT EXISTS (
   SELECT 1
     FROM public.transport_coverage tc
    WHERE tc.source = v.source
      AND public.fn_transport_coverage_normalize_locality(tc.provincia)
          = public.fn_transport_coverage_normalize_locality(v.provincia)
      AND public.fn_transport_coverage_normalize_locality(tc.localidad)
          = public.fn_transport_coverage_normalize_locality(v.localidad)
 );

DO $$
DECLARE
  v_result text[];
BEGIN
  v_result := public.fn_transportes_disponibles('Santa Fe', 'Tacuarendi (Emb. Kilometro 421)');
  IF v_result <> ARRAY['Snaider', 'Correo Argentino'] THEN
    RAISE EXCEPTION '364 FAIL: Tacuarendi (Emb. Kilometro 421) esperaba {Snaider,Correo Argentino}, dio %', v_result;
  END IF;

  v_result := public.fn_transportes_disponibles('Santa Fe', 'Tacuarendí');
  IF v_result <> ARRAY['Snaider', 'Correo Argentino'] THEN
    RAISE EXCEPTION '364 FAIL: Tacuarendí esperaba {Snaider,Correo Argentino}, dio %', v_result;
  END IF;
END $$;
