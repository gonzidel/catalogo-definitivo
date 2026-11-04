-- 366_ROLLBACK_checkout_preserve_order_notes_extras.sql
-- Vuelve rpc_checkout_cart() al UPDATE de total previo (md5 b990b8c9...) y
-- borra fn_order_notes_extras_total. Los totales ya corregidos no se tocan.

DO $patch$
DECLARE
  v_oid oid;
  v_src text;
  v_new constant text := E'  UPDATE public.orders\n  SET total_amount = greatest(0, v_gross_subtotal - v_promo_discount)\n  WHERE id = v_order_id;';
  v_old constant text := E'  UPDATE public.orders\n  SET total_amount = greatest(\n    0,\n    v_gross_subtotal - v_promo_discount\n      + public.fn_order_notes_extras_total(notes, v_gross_subtotal)\n  )\n  WHERE id = v_order_id;';
BEGIN
  SELECT p.oid, p.prosrc INTO v_oid, v_src
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'rpc_checkout_cart'
     AND pg_get_function_identity_arguments(p.oid) = '';

  IF md5(v_src) <> '04c1dac9cc7f452dc4318b6aba1ee4ca' THEN
    RAISE EXCEPTION '366 ROLLBACK: rpc_checkout_cart() no es la versión 366 (md5 %)', md5(v_src);
  END IF;

  EXECUTE replace(pg_get_functiondef(v_oid), v_old, v_new);

  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_oid;
  IF md5(v_src) <> 'b990b8c92c36e7ec64a9f8bea41424f3' THEN
    RAISE EXCEPTION '366 ROLLBACK: md5 inesperado %', md5(v_src);
  END IF;
END
$patch$;

COMMENT ON FUNCTION public.rpc_checkout_cart() IS
  'canonical:335 | line price = get_effective_price(variant_id); snapshot no es autoridad. stock/309/wrapper intactos. anterior canonical:331 md5 9901c2cf5a32fc2ecad95c30c247b77e';

DROP FUNCTION IF EXISTS public.fn_order_notes_extras_total(text, numeric);
