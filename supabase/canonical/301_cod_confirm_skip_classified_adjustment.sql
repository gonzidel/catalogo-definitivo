-- 301_cod_confirm_skip_classified_adjustment.sql
--
-- Completa el patch 300: classified_adjustment ya pasa el gate rows_not_ready,
-- pero el loop de confirm las trataba como approved_pending_confirmation y
-- fallaba con approved_row_missing_order (sin matched_order_id).
--
-- Comportamiento correcto:
--   classified_adjustment = skip (sin efecto COD).

DO $patch$
DECLARE
  v_reg regprocedure;
  v_src text;
  v_new text;
  v_needle text;
  v_repl text;
BEGIN
  v_reg := to_regprocedure('public.rpc_cod_confirm_remittance(uuid)');
  IF v_reg IS NULL THEN
    RAISE EXCEPTION '301_confirm_rpc_missing';
  END IF;

  v_src := pg_get_functiondef(v_reg);

  -- Ya patcheado
  IF v_src LIKE '%row_status = ''classified_adjustment'' THEN%'
     AND v_src LIKE '%CONTINUE;%'
     AND position(
       'row_status = ''classified_adjustment'' THEN' in
       substring(v_src from position('FOR v_row IN' in v_src) for 800)
     ) > 0
  THEN
    RAISE NOTICE '301: confirm already skips classified_adjustment in loop';
    RETURN;
  END IF;

  -- Normalizar CRLF por si el body viene con \r
  v_src := replace(v_src, E'\r\n', E'\n');

  v_needle :=
    'IF v_row.row_status = ''unassigned'' THEN' || E'\n' ||
    '      v_count_unassigned := v_count_unassigned + 1;' || E'\n' ||
    '      CONTINUE;' || E'\n' ||
    '    END IF;';

  IF position(v_needle in v_src) = 0 THEN
    RAISE EXCEPTION '301_confirm_skip_anchor_not_found';
  END IF;

  v_repl :=
    'IF v_row.row_status = ''unassigned'' THEN' || E'\n' ||
    '      v_count_unassigned := v_count_unassigned + 1;' || E'\n' ||
    '      CONTINUE;' || E'\n' ||
    '    END IF;' || E'\n' ||
    E'\n' ||
    '    -- 301: crédito/diferencia transporte — no es pago COD a confirmar' || E'\n' ||
    '    IF v_row.row_status = ''classified_adjustment'' THEN' || E'\n' ||
    '      CONTINUE;' || E'\n' ||
    '    END IF;';

  v_new := replace(v_src, v_needle, v_repl);
  EXECUTE v_new;
  RAISE NOTICE '301: rpc_cod_confirm_remittance skips classified_adjustment';
END;
$patch$;

COMMENT ON FUNCTION public.rpc_cod_confirm_remittance(uuid) IS
  'Confirma remesa. unassigned y classified_adjustment se omiten (no COD). '
  'Patch 300 (ready gate) + 301 (loop skip).';

SELECT pg_notify('pgrst', 'reload schema');
