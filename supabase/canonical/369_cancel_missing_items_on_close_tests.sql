-- 369_cancel_missing_items_on_close_tests.sql
--
-- A) Funcional. Termina SIEMPRE con RAISE EXCEPTION: nada persiste.
--    Ensayo previo: BEGIN; <cuerpo de 369 sin BEGIN/COMMIT>; <bloque A>; COMMIT;
--    Esperado: mensaje que empieza con '369 TEST OK'.
-- B) Estructura (después de aplicar).

-- ---------------------------------------------------------------------------
-- A) Funcional
-- ---------------------------------------------------------------------------
DO $test$
DECLARE
  v_wh     uuid := (SELECT id FROM public.warehouses WHERE code = 'general');
  v_cust   uuid := coalesce(
                     (SELECT id FROM public.customers WHERE kanban_inbox_owner IS NOT NULL LIMIT 1),
                     (SELECT id FROM public.customers LIMIT 1));
  v_prod   uuid;
  v_var    uuid;
  v_order  uuid;
  v_order2 uuid;
  v_picked uuid;
  v_miss   uuid;
  v_miss2  uuid;
  v_it     record;
  v_errs   text := '';
BEGIN
  INSERT INTO public.products (handle, name)
  VALUES ('test-369-' || gen_random_uuid(), 'TEST 369') RETURNING id INTO v_prod;
  INSERT INTO public.product_variants (product_id, color, sku, reserved_qty)
  VALUES (v_prod, 'TEST', 'TEST-369-' || left(gen_random_uuid()::text, 8), 3) RETURNING id INTO v_var;
  INSERT INTO public.variant_size_warehouse_stock (variant_id, size, warehouse_id, stock_qty)
  VALUES (v_var, '1', v_wh, 5);

  -- Pedido 1: un apartado ($100) y un sin stock ($200), ambos con fuente.
  INSERT INTO public.orders (customer_id, order_number, status, total_amount)
  VALUES (v_cust, 'TEST369', 'active', 300) RETURNING id INTO v_order;
  INSERT INTO public.order_items (order_id, product_name, quantity, price_snapshot, variant_id, size, status)
  VALUES (v_order, 'TEST 369', 1, 100, v_var, '1', 'picked') RETURNING id INTO v_picked;
  INSERT INTO public.order_items (order_id, product_name, quantity, price_snapshot, variant_id, size, status)
  VALUES (v_order, 'TEST 369', 1, 200, v_var, '1', 'missing') RETURNING id INTO v_miss;
  INSERT INTO public.order_item_stock_sources (order_item_id, warehouse_id, qty) VALUES (v_picked, v_wh, 1);
  INSERT INTO public.order_item_stock_sources (order_item_id, warehouse_id, qty) VALUES (v_miss, v_wh, 1);

  -- Pedido 2: solo un sin stock (no debe quitarse: dejaría el pedido vacío).
  INSERT INTO public.orders (customer_id, order_number, status, total_amount)
  VALUES (v_cust, 'TEST369B', 'active', 200) RETURNING id INTO v_order2;
  INSERT INTO public.order_items (order_id, product_name, quantity, price_snapshot, variant_id, size, status)
  VALUES (v_order2, 'TEST 369', 1, 200, v_var, '1', 'missing') RETURNING id INTO v_miss2;
  INSERT INTO public.order_item_stock_sources (order_item_id, warehouse_id, qty) VALUES (v_miss2, v_wh, 1);

  -- Cierre directo (camino de rpc_close_stuck_customer_requested_orders).
  UPDATE public.orders SET status = 'closed', closed_at = now() WHERE id IN (v_order, v_order2);

  SELECT * INTO v_it FROM public.order_items WHERE id = v_miss;
  IF v_it.status <> 'cancelled' THEN v_errs := v_errs || ' miss_no_cancelado=' || v_it.status; END IF;
  IF v_it.cancelled_from_status IS DISTINCT FROM 'missing' THEN v_errs := v_errs || ' cfs=' || coalesce(v_it.cancelled_from_status, 'null'); END IF;
  IF NOT v_it.admin_confirmed_missing THEN v_errs := v_errs || ' acm=false'; END IF;
  IF EXISTS (SELECT 1 FROM public.order_item_stock_sources WHERE order_item_id = v_miss) THEN v_errs := v_errs || ' miss_con_fuente'; END IF;

  SELECT * INTO v_it FROM public.order_items WHERE id = v_picked;
  IF v_it.status <> 'picked' THEN v_errs := v_errs || ' picked_cambio=' || v_it.status; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.order_item_stock_sources WHERE order_item_id = v_picked) THEN v_errs := v_errs || ' picked_sin_fuente'; END IF;

  IF (SELECT total_amount FROM public.orders WHERE id = v_order) <> 100 THEN
    v_errs := v_errs || ' total=' || (SELECT total_amount FROM public.orders WHERE id = v_order);
  END IF;
  IF public.fn_compute_closed_order_products_total(v_order) <> 100 THEN
    v_errs := v_errs || ' aviso=' || public.fn_compute_closed_order_products_total(v_order);
  END IF;
  IF (SELECT reserved_qty FROM public.product_variants WHERE id = v_var) <> 2 THEN
    v_errs := v_errs || ' reserved=' || (SELECT reserved_qty FROM public.product_variants WHERE id = v_var);
  END IF;
  IF (SELECT stock_qty FROM public.variant_size_warehouse_stock WHERE variant_id = v_var) <> 5 THEN
    v_errs := v_errs || ' stock_cambio';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.orders WHERE id = v_order2) THEN v_errs := v_errs || ' pedido2_borrado'; END IF;
  IF (SELECT status FROM public.order_items WHERE id = v_miss2) <> 'missing' THEN v_errs := v_errs || ' miss2_cambio'; END IF;
  IF public.fn_compute_closed_order_products_total(v_order2) <> 0 THEN
    v_errs := v_errs || ' aviso2=' || public.fn_compute_closed_order_products_total(v_order2);
  END IF;

  IF v_errs <> '' THEN
    RAISE EXCEPTION '369 TEST FAIL:%', v_errs;
  END IF;
  RAISE EXCEPTION '369 TEST OK (rollback forzado): sin stock quitado, total 100, reserved 3->2, stock intacto, pedido todo-sin-stock intacto';
END
$test$;

-- ---------------------------------------------------------------------------
-- B) Estructura (esperado: todo true)
-- ---------------------------------------------------------------------------
SELECT
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.orders'::regclass
           AND tgname = 'trg_orders_cancel_missing_items_on_close')            AS ok_trigger,
  NOT has_function_privilege('authenticated', 'public.fn_cancel_missing_items_on_close(uuid)', 'EXECUTE')
                                                                                AS ok_fn_not_exposed,
  position('''missing''' in pg_get_functiondef('public.fn_compute_closed_order_products_total(uuid)'::regprocedure)) > 0
                                                                                AS ok_total_excluye_missing;
