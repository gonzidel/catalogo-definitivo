-- 335 runtime controlado. Cuenta de prueba 771a9a9c-e703-4443-819f-05b0eab736be.
-- No usar clientas reales. Limpia pedido al final.

DROP FUNCTION IF EXISTS public._qa_335_checkout_price_run();

CREATE FUNCTION public._qa_335_checkout_price_run()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $fn$
DECLARE
  v_uid uuid := '771a9a9c-e703-4443-819f-05b0eab736be';
  v_cart uuid := '3f9b2f47-a2d2-4b27-ac64-7313f0c80380';
  v_neg uuid := 'd1d45d4d-36ac-4c79-8ffa-9706e1541dd0';
  v_sue uuid := '4bd582fd-f391-44b5-b037-dce1cb31ba15';
  v_n51 uuid := 'b36ce005-07fa-4781-9a04-b0eacf74747a';
  v_s51 uuid := 'edb21521-545b-4e76-8fee-1e9e9dcbfd1e';
  v_wh uuid := 'bec14f04-8b4a-4c99-97c6-36d6feef6bb0';
  v_op uuid;
  v_res jsonb;
  v_replay jsonb;
  v_order uuid;
  v_base jsonb;
  v_after jsonb;
  v_lines jsonb;
  v_out jsonb := '[]'::jsonb;
  v_open int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', v_uid::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

  SELECT count(*) INTO v_open
  FROM public.orders
  WHERE customer_id = v_uid AND status IN ('active','closing_soon','cancelled','closed');
  IF v_open > 0 THEN
    RAISE EXCEPTION 'QA 335 abort: la cuenta de prueba tiene pedido operativo';
  END IF;

  DELETE FROM public.cart_items WHERE cart_id = v_cart;

  SELECT jsonb_object_agg(k, vss) INTO v_base
  FROM (
    SELECT pv.id::text || ':' || vs.size AS k,
           jsonb_build_object(
             'vss', vs.stock_qty,
             'reserved', pv.reserved_qty
           ) AS vss
    FROM public.product_variants pv
    JOIN public.variant_size_warehouse_stock vs
      ON vs.variant_id = pv.id AND vs.warehouse_id = v_wh AND vs.size = '36'
    WHERE pv.id IN (v_neg, v_sue, v_n51, v_s51)
  ) t;

  -- Tests 1-3: un checkout con las 4 variantes
  INSERT INTO public.cart_items (cart_id, variant_id, qty, quantity, price_snapshot, product_name, color, size, status)
  VALUES
    (v_cart, v_neg, 1, 1, 28500, '8000', 'Negro', '36', 'reserved'),
    (v_cart, v_sue, 1, 1, 20000, '8000', 'suela', '36', 'reserved'),
    (v_cart, v_n51, 1, 1, 10000, '51030', 'Negro', '36', 'reserved'),
    (v_cart, v_s51, 1, 1, 18000, '51030', 'Suela', '36', 'reserved');

  v_op := gen_random_uuid();
  v_res := public.rpc_checkout_cart(v_op, '{}'::jsonb);
  v_order := (v_res->>'order_id')::uuid;

  SELECT jsonb_agg(jsonb_build_object(
    'color', oi.color,
    'price', oi.price_snapshot,
    'status', oi.status,
    'qty', oi.quantity
  ) ORDER BY oi.color, oi.product_name)
  INTO v_lines
  FROM public.order_items oi
  WHERE oi.order_id = v_order;

  v_out := v_out || jsonb_build_array(jsonb_build_object(
    'caso', '1-3 combo 8000+51030',
    'order_number', v_res->>'order_number',
    'total', (SELECT total_amount FROM public.orders WHERE id = v_order),
    'lines', v_lines,
    'esperado_total', 76500,
    'resultado', CASE WHEN (SELECT total_amount FROM public.orders WHERE id = v_order) = 76500
                      AND (SELECT count(*) FROM public.order_items WHERE order_id = v_order AND price_snapshot IN (28500,20000,10000,18000)) = 4
                     THEN 'PASS' ELSE 'FAIL' END
  ));

  PERFORM public.rpc_customer_cancel_order(v_order);

  -- Test 4 + 6: snapshot manipulado + replay
  INSERT INTO public.cart_items (cart_id, variant_id, qty, quantity, price_snapshot, product_name, color, size, status)
  VALUES (v_cart, v_neg, 1, 1, 100, '8000', 'Negro', '36', 'reserved');

  v_op := gen_random_uuid();
  v_res := public.rpc_checkout_cart(v_op, '{}'::jsonb);
  v_order := (v_res->>'order_id')::uuid;
  v_replay := public.rpc_checkout_cart(v_op, '{}'::jsonb);

  v_out := v_out || jsonb_build_array(jsonb_build_object(
    'caso', '4 manipulado 100',
    'snapshot', 100,
    'db_effective', public.get_effective_price(v_neg),
    'cobrado', (SELECT oi.price_snapshot FROM public.order_items oi WHERE oi.order_id = v_order LIMIT 1),
    'total', (SELECT total_amount FROM public.orders WHERE id = v_order),
    'resultado', CASE WHEN (SELECT oi.price_snapshot FROM public.order_items oi WHERE oi.order_id = v_order LIMIT 1) = 28500
                       AND (SELECT total_amount FROM public.orders WHERE id = v_order) = 28500
                      THEN 'PASS' ELSE 'FAIL' END
  ));

  v_out := v_out || jsonb_build_array(jsonb_build_object(
    'caso', '6 replay',
    'idempotent_replay', v_replay->>'idempotent_replay',
    'same_order', (v_replay->>'order_id') = (v_res->>'order_id'),
    'line_count', (SELECT count(*) FROM public.order_items WHERE order_id = v_order),
    'total', (SELECT total_amount FROM public.orders WHERE id = v_order),
    'resultado', CASE WHEN (v_replay->>'idempotent_replay') = 'true'
                       AND (SELECT count(*) FROM public.order_items WHERE order_id = v_order) = 1
                       AND (SELECT total_amount FROM public.orders WHERE id = v_order) = 28500
                      THEN 'PASS' ELSE 'FAIL' END
  ));

  PERFORM public.rpc_customer_cancel_order(v_order);

  -- Test 5: snapshot viejo de oferta (20000) vs efectivo 28500 en Negro
  INSERT INTO public.cart_items (cart_id, variant_id, qty, quantity, price_snapshot, product_name, color, size, status)
  VALUES (v_cart, v_neg, 1, 1, 20000, '8000', 'Negro', '36', 'reserved');

  v_op := gen_random_uuid();
  v_res := public.rpc_checkout_cart(v_op, '{}'::jsonb);
  v_order := (v_res->>'order_id')::uuid;

  v_out := v_out || jsonb_build_array(jsonb_build_object(
    'caso', '5 snapshot viejo 20000',
    'snapshot', 20000,
    'db_effective', public.get_effective_price(v_neg),
    'cobrado', (SELECT oi.price_snapshot FROM public.order_items oi WHERE oi.order_id = v_order LIMIT 1),
    'diferencia_registrada', 20000 IS DISTINCT FROM public.get_effective_price(v_neg),
    'resultado', CASE WHEN (SELECT oi.price_snapshot FROM public.order_items oi WHERE oi.order_id = v_order LIMIT 1) = 28500
                      THEN 'PASS' ELSE 'FAIL' END
  ));

  PERFORM public.rpc_customer_cancel_order(v_order);
  DELETE FROM public.cart_items WHERE cart_id = v_cart;

  SELECT jsonb_object_agg(k, vss) INTO v_after
  FROM (
    SELECT pv.id::text || ':' || vs.size AS k,
           jsonb_build_object(
             'vss', vs.stock_qty,
             'reserved', pv.reserved_qty
           ) AS vss
    FROM public.product_variants pv
    JOIN public.variant_size_warehouse_stock vs
      ON vs.variant_id = pv.id AND vs.warehouse_id = v_wh AND vs.size = '36'
    WHERE pv.id IN (v_neg, v_sue, v_n51, v_s51)
  ) t;

  v_out := v_out || jsonb_build_array(jsonb_build_object(
    'caso', '7 stock restore',
    'baseline', v_base,
    'after', v_after,
    'open_orders', (SELECT count(*) FROM public.orders WHERE customer_id = v_uid AND status IN ('active','closing_soon','cancelled')),
    'resultado', CASE WHEN v_base = v_after
                       AND NOT EXISTS (
                         SELECT 1 FROM public.orders
                         WHERE customer_id = v_uid AND status IN ('active','closing_soon','cancelled')
                       )
                      THEN 'PASS' ELSE 'FAIL' END
  ));

  RETURN v_out;
END;
$fn$;

SELECT public._qa_335_checkout_price_run() AS qa;
DROP FUNCTION public._qa_335_checkout_price_run();
