-- 370_manual_confirm_take_reservation_tests.sql
--
-- A) Funcional. Termina SIEMPRE con RAISE EXCEPTION: nada persiste.
--    Ensayo previo: BEGIN; <cuerpo de 370 sin BEGIN/COMMIT>; <bloque A>; COMMIT;
--    Esperado: mensaje que empieza con '370 TEST OK'.
-- B) Estructura (después de aplicar).

-- ---------------------------------------------------------------------------
-- A) Funcional
-- ---------------------------------------------------------------------------
DO $test$
DECLARE
  v_wh      uuid := (SELECT id FROM public.warehouses WHERE code = 'general');
  v_admin   uuid := (SELECT user_id FROM public.admins ORDER BY user_id LIMIT 1);
  v_cust    uuid;
  v_cust2   uuid;
  v_prod    uuid;
  v_var     uuid;
  v_order_a uuid;
  v_order_b uuid;
  v_item_a  uuid;
  v_item_b  uuid;
  v_cands   jsonb;
  v_res     jsonb;
  v_it      record;
  v_errs    text := '';
  v_msg     text;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  SELECT min(id::text)::uuid, max(id::text)::uuid
    INTO v_cust, v_cust2
    FROM (SELECT c.id FROM public.customers c
           WHERE c.kanban_inbox_owner IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM public.orders o
                              WHERE o.customer_id = c.id
                                AND o.status IN ('active', 'closing_soon', 'closed'))
           LIMIT 2) x;

  INSERT INTO public.products (handle, name)
  VALUES ('test-370-' || gen_random_uuid(), 'TEST 370') RETURNING id INTO v_prod;
  -- reserved_qty 1 = la reserva del pedido A.
  INSERT INTO public.product_variants (product_id, color, sku, reserved_qty)
  VALUES (v_prod, 'TEST', 'TEST-370-' || left(gen_random_uuid()::text, 8), 1) RETURNING id INTO v_var;
  -- Stock 0: el último par ya está descontado por el pedido A.
  INSERT INTO public.variant_size_warehouse_stock (variant_id, size, warehouse_id, stock_qty)
  VALUES (v_var, '37', v_wh, 0);

  -- Pedido A: reservó el último 37 (checkout).
  INSERT INTO public.orders (customer_id, order_number, status, total_amount)
  VALUES (v_cust, 'TEST370A', 'active', 1000) RETURNING id INTO v_order_a;
  INSERT INTO public.order_items (order_id, product_name, quantity, price_snapshot, variant_id, size, status)
  VALUES (v_order_a, 'TEST 370', 1, 1000, v_var, '37', 'picked') RETURNING id INTO v_item_a;
  INSERT INTO public.order_item_stock_sources (order_item_id, warehouse_id, qty) VALUES (v_item_a, v_wh, 1);

  INSERT INTO public.orders (customer_id, order_number, status, total_amount)
  VALUES (v_cust2, 'TEST370B', 'active', 0) RETURNING id INTO v_order_b;

  -- 1) Candidatos: B ve la reserva de A; A no se ve a sí mismo.
  v_cands := public.rpc_admin_manual_confirm_candidates(
    jsonb_build_array(jsonb_build_object('variant_id', v_var, 'size', '37.0')), v_order_b);
  IF jsonb_array_length(v_cands) <> 1
     OR (v_cands->0->'candidates'->0->>'order_item_id')::uuid IS DISTINCT FROM v_item_a THEN
    v_errs := v_errs || ' candidatos=' || v_cands::text;
  END IF;
  IF jsonb_array_length(public.rpc_admin_manual_confirm_candidates(
       jsonb_build_array(jsonb_build_object('variant_id', v_var, 'size', '37')), v_order_a)) <> 0 THEN
    v_errs := v_errs || ' candidatos_propios';
  END IF;

  -- 2) B agrega el 37 confirmado a mano tomando la reserva de A.
  v_res := public.rpc_admin_add_order_items_atomic(v_order_b, jsonb_build_object(
    'expected_status', 'active',
    'items', jsonb_build_array(jsonb_build_object(
      'product_name', 'TEST 370', 'color', 'TEST', 'size', '37', 'quantity', 1,
      'price_snapshot', 1000, 'variant_id', v_var, 'qty_from_general', 0, 'qty_from_venta', 0,
      'status', 'picked', 'admin_confirmed_missing', true,
      'take_from_order_item_id', v_item_a))), gen_random_uuid());

  IF jsonb_array_length(v_res->'stock'->'reservations_taken') <> 1
     OR (v_res->'stock'->'reservations_taken'->0->>'order_id')::uuid IS DISTINCT FROM v_order_a THEN
    v_errs := v_errs || ' resultado=' || (v_res->'stock')::text;
  END IF;
  v_item_b := (v_res->'inserted_items'->0->>'id')::uuid;

  SELECT * INTO v_it FROM public.order_items WHERE id = v_item_a;
  IF v_it.status <> 'missing' THEN v_errs := v_errs || ' a_status=' || v_it.status; END IF;
  IF EXISTS (SELECT 1 FROM public.order_item_stock_sources WHERE order_item_id = v_item_a) THEN
    v_errs := v_errs || ' a_con_fuente';
  END IF;
  IF (SELECT total_amount FROM public.orders WHERE id = v_order_a) <> 0 THEN
    v_errs := v_errs || ' a_total=' || (SELECT total_amount FROM public.orders WHERE id = v_order_a);
  END IF;
  IF (SELECT coalesce(sum(qty), 0) FROM public.order_item_stock_sources
       WHERE order_item_id = v_item_b AND warehouse_id = v_wh) <> 1 THEN
    v_errs := v_errs || ' b_sin_fuente';
  END IF;
  IF (SELECT stock_qty FROM public.variant_size_warehouse_stock WHERE variant_id = v_var AND size = '37') <> 0 THEN
    v_errs := v_errs || ' stock_cambio';
  END IF;
  IF (SELECT reserved_qty FROM public.product_variants WHERE id = v_var) <> 1 THEN
    v_errs := v_errs || ' reserved=' || (SELECT reserved_qty FROM public.product_variants WHERE id = v_var);
  END IF;
  IF (SELECT count(*) FROM public.stock_history WHERE variant_id = v_var AND change_type = 'reserva_tomada') <> 1 THEN
    v_errs := v_errs || ' sin_log_reserva_tomada';
  END IF;
  IF EXISTS (SELECT 1 FROM public.stock_history WHERE variant_id = v_var AND change_type = 'admin_manual_confirmation') THEN
    v_errs := v_errs || ' inyecto_stock';
  END IF;

  -- 3) Volver a tomar la misma reserva (ya missing) debe fallar.
  BEGIN
    PERFORM public.rpc_admin_manual_inject_and_deduct(jsonb_build_array(jsonb_build_object(
      'variant_id', v_var, 'size', '37', 'qty', 1, 'order_item_id', v_item_b,
      'take_from_order_item_id', v_item_a)), v_order_b);
    v_errs := v_errs || ' retoma_permitida';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF position('ya cambió' in v_msg) = 0 THEN v_errs := v_errs || ' retoma_msg=' || v_msg; END IF;
  END;

  -- 4) Sin take_from: comportamiento previo (+1/-1, fuente, reserved +1).
  v_res := public.rpc_admin_add_order_items_atomic(v_order_b, jsonb_build_object(
    'items', jsonb_build_array(jsonb_build_object(
      'product_name', 'TEST 370', 'size', '37', 'quantity', 1, 'price_snapshot', 1000,
      'variant_id', v_var, 'status', 'picked', 'admin_confirmed_missing', true))), gen_random_uuid());
  IF jsonb_array_length(v_res->'stock'->'reservations_taken') <> 0 THEN v_errs := v_errs || ' manual_tomo'; END IF;
  IF (SELECT count(*) FROM public.stock_history WHERE variant_id = v_var AND change_type = 'admin_manual_confirmation') <> 1 THEN
    v_errs := v_errs || ' manual_sin_log';
  END IF;
  IF (SELECT stock_qty FROM public.variant_size_warehouse_stock WHERE variant_id = v_var AND size = '37') <> 0 THEN
    v_errs := v_errs || ' manual_stock';
  END IF;
  IF (SELECT reserved_qty FROM public.product_variants WHERE id = v_var) <> 2 THEN
    v_errs := v_errs || ' manual_reserved';
  END IF;

  -- 5) Reporte: la confirmación manual del paso 4 ve el 37 de A (ya missing) y la toma del paso 2.
  IF NOT EXISTS (SELECT 1 FROM public.vw_stock_audit_manual_confirm_reserved
                  WHERE variant_id = v_var AND kind = 'reserva_tomada' AND other_order_item_id = v_item_a) THEN
    v_errs := v_errs || ' vista_sin_toma';
  END IF;

  IF v_errs <> '' THEN
    RAISE EXCEPTION '370 TEST FAIL:%', v_errs;
  END IF;
  RAISE EXCEPTION '370 TEST OK (rollback forzado): candidatos ok, reserva tomada (A missing, total 0, B con fuente), stock 0 sin cambio, reserved neto 0, re-toma bloqueada, manual sin take_from igual que antes, vista ok';
END
$test$;

-- ---------------------------------------------------------------------------
-- B) Estructura (esperado: todo true)
-- ---------------------------------------------------------------------------
SELECT
  has_function_privilege('authenticated', 'public.rpc_admin_manual_confirm_candidates(jsonb, uuid)', 'EXECUTE') AS ok_candidates_auth,
  NOT has_function_privilege('anon', 'public.rpc_admin_manual_confirm_candidates(jsonb, uuid)', 'EXECUTE')    AS ok_candidates_no_anon,
  position('take_from_order_item_id' in pg_get_functiondef('public.rpc_admin_manual_inject_and_deduct(jsonb, uuid)'::regprocedure)) > 0 AS ok_inject,
  position('reservations_taken' in pg_get_functiondef('public.rpc_admin_add_order_items_atomic(uuid, jsonb, uuid)'::regprocedure)) > 0 AS ok_atomic,
  NOT has_table_privilege('anon', 'public.vw_stock_audit_manual_confirm_reserved', 'SELECT')                AS ok_view_no_anon;
