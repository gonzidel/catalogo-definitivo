-- 366_checkout_preserve_order_notes_extras.sql
--
-- Bug (A57414 / Valeria Santillan, 2026-10-02): el admin cargó un extra fijo
-- ("ALHAJEROS" $8.500) en notes.extras_amount. Cada compra posterior desde el
-- dashboard pasa por rpc_checkout_cart(), que reescribía
--   total_amount = suma de líneas no canceladas - promos
-- y borraba del total envío / descuento / extra guardados en notes. El
-- mensaje de cierre los suma aparte ($143.400), pero el total del pedido
-- (admin NJ, lista del dashboard, conciliación) quedaba en $134.900.
--
-- Fix: el total del checkout suma los valores extra de notes con la misma
-- fórmula que rpc_admin_add_order_items_atomic (350) y el editor NJ:
--   subtotal + shipping - discount + extras_amount + subtotal * extras_percentage / 100
--
-- rpc_checkout_cart() se parchea sobre la definición viva: solo cambia el
-- UPDATE final del total. Guard de md5 antes y después para no pisar una
-- versión distinta de la auditada (prod 2026-10-02, posterior a 337).
--
-- fn_order_notes_extras_total nunca lanza error: notes no-JSON o valores no
-- numéricos cuentan como 0 (el checkout no puede fallar por notes).
--
-- Rollback: 366_ROLLBACK_checkout_preserve_order_notes_extras.sql
-- Tests: 366_checkout_preserve_order_notes_extras_tests.sql

CREATE OR REPLACE FUNCTION public.fn_order_notes_extras_total(
  p_notes text,
  p_subtotal numeric
)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_notes jsonb;
  v_shipping numeric := 0;
  v_discount numeric := 0;
  v_extras numeric := 0;
  v_pct numeric := 0;
  v_num_re constant text := '^\s*-?\d+(\.\d+)?\s*$';
BEGIN
  IF p_notes IS NULL OR NOT (p_notes IS JSON OBJECT) THEN
    RETURN 0;
  END IF;
  v_notes := p_notes::jsonb;

  IF coalesce(v_notes->>'shipping', v_notes->>'shipping_cost', '') ~ v_num_re THEN
    v_shipping := greatest(0, coalesce(v_notes->>'shipping', v_notes->>'shipping_cost')::numeric);
  END IF;
  IF coalesce(v_notes->>'discount', '') ~ v_num_re THEN
    v_discount := greatest(0, (v_notes->>'discount')::numeric);
  END IF;
  IF coalesce(v_notes->>'extras_amount', v_notes->>'extras', '') ~ v_num_re THEN
    v_extras := greatest(0, coalesce(v_notes->>'extras_amount', v_notes->>'extras')::numeric);
  END IF;
  IF coalesce(v_notes->>'extras_percentage', '') ~ v_num_re THEN
    v_pct := greatest(0, (v_notes->>'extras_percentage')::numeric);
  END IF;

  RETURN v_shipping - v_discount + v_extras
    + CASE WHEN v_pct > 0 THEN coalesce(p_subtotal, 0) * v_pct / 100 ELSE 0 END;
END;
$function$;

COMMENT ON FUNCTION public.fn_order_notes_extras_total(text, numeric) IS
  'canonical:366 | Neto de valores extra de orders.notes (shipping - discount + extras_amount + subtotal*extras_percentage/100). Nunca lanza error.';

REVOKE ALL ON FUNCTION public.fn_order_notes_extras_total(text, numeric) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_order_notes_extras_total(text, numeric) FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_order_notes_extras_total(text, numeric) FROM authenticated;

DO $patch$
DECLARE
  v_oid oid;
  v_src text;
  v_def text;
  v_old constant text := E'  UPDATE public.orders\n  SET total_amount = greatest(0, v_gross_subtotal - v_promo_discount)\n  WHERE id = v_order_id;';
  v_new constant text := E'  UPDATE public.orders\n  SET total_amount = greatest(\n    0,\n    v_gross_subtotal - v_promo_discount\n      + public.fn_order_notes_extras_total(notes, v_gross_subtotal)\n  )\n  WHERE id = v_order_id;';
BEGIN
  SELECT p.oid, p.prosrc INTO v_oid, v_src
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'rpc_checkout_cart'
     AND pg_get_function_identity_arguments(p.oid) = '';

  IF v_oid IS NULL THEN
    RAISE EXCEPTION '366: rpc_checkout_cart() no existe';
  END IF;
  IF md5(v_src) = '04c1dac9cc7f452dc4318b6aba1ee4ca' THEN
    RAISE NOTICE '366: rpc_checkout_cart() ya parcheada';
    RETURN;
  END IF;
  IF md5(v_src) <> 'b990b8c92c36e7ec64a9f8bea41424f3' THEN
    RAISE EXCEPTION '366: rpc_checkout_cart() difiere de la versión auditada (md5 %)', md5(v_src);
  END IF;

  v_def := replace(pg_get_functiondef(v_oid), v_old, v_new);
  EXECUTE v_def;

  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_oid;
  IF md5(v_src) <> '04c1dac9cc7f452dc4318b6aba1ee4ca' THEN
    RAISE EXCEPTION '366: parche aplicado con md5 inesperado %', md5(v_src);
  END IF;
END
$patch$;

COMMENT ON FUNCTION public.rpc_checkout_cart() IS
  'canonical:366 | total_amount = líneas no canceladas - promos + valores extra de notes (fn_order_notes_extras_total). Base canonical:335/336/337. md5 previo b990b8c92c36e7ec64a9f8bea41424f3';
