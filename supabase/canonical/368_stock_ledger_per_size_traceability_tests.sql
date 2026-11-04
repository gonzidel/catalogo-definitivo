-- 368_stock_ledger_per_size_traceability_tests.sql
--
-- A) Prueba funcional. Termina SIEMPRE con RAISE EXCEPTION: nada persiste.
--    Ensayo previo en producción: ejecutar en una sola llamada
--      BEGIN; <cuerpo de 368 sin BEGIN/COMMIT>; <este bloque A>; COMMIT;
--    El mensaje debe empezar con '368 TEST OK'. Después de aplicar 368 también
--    puede correrse solo.
-- B) Chequeos estructurales de solo lectura (después de aplicar).
-- C) Consultas operativas para auditorías.

-- ---------------------------------------------------------------------------
-- A) Funcional
-- ---------------------------------------------------------------------------
DO $test$
DECLARE
  v_wh    uuid := (SELECT id FROM public.warehouses WHERE code = 'general');
  v_cust  uuid := coalesce(
                    (SELECT id FROM public.customers WHERE kanban_inbox_owner IS NOT NULL LIMIT 1),
                    (SELECT id FROM public.customers LIMIT 1));
  v_txid  bigint := txid_current();
  v_prod  uuid;
  v_var   uuid;
  v_order uuid;
  v_item  uuid;
  v_got   text;
  v_want  text;
  v_src   record;
BEGIN
  INSERT INTO public.products (handle, name)
  VALUES ('test-368-' || gen_random_uuid(), 'TEST 368')
  RETURNING id INTO v_prod;

  INSERT INTO public.product_variants (product_id, color, sku)
  VALUES (v_prod, 'TEST', 'TEST-368-' || left(gen_random_uuid()::text, 8))
  RETURNING id INTO v_var;

  -- stock: alta +10, descuento -2, cambios sin efecto (no deben registrarse)
  INSERT INTO public.variant_size_warehouse_stock (variant_id, size, warehouse_id, stock_qty)
  VALUES (v_var, '3', v_wh, 10);
  UPDATE public.variant_size_warehouse_stock SET stock_qty = 8 WHERE variant_id = v_var;
  UPDATE public.variant_size_warehouse_stock SET updated_at = now() WHERE variant_id = v_var;
  UPDATE public.variant_size_warehouse_stock SET stock_qty = 8 WHERE variant_id = v_var;

  -- pedido con ítem reservado y fuente; borrado en cascada
  INSERT INTO public.orders (customer_id, order_number, status)
  VALUES (v_cust, 'TEST368', 'active')
  RETURNING id INTO v_order;

  INSERT INTO public.order_items (order_id, product_name, quantity, variant_id, size, status)
  VALUES (v_order, 'TEST 368', 2, v_var, '3', 'reserved')
  RETURNING id INTO v_item;

  INSERT INTO public.order_item_stock_sources (order_item_id, warehouse_id, qty)
  VALUES (v_item, v_wh, 2);

  DELETE FROM public.orders WHERE id = v_order;

  -- reingreso +2 y baja de la fila -10
  UPDATE public.variant_size_warehouse_stock SET stock_qty = 10 WHERE variant_id = v_var;
  DELETE FROM public.variant_size_warehouse_stock WHERE variant_id = v_var;

  SELECT string_agg(
           event || ':' || coalesce(size, '-') || ':' || coalesce(delta::text, '-')
           || ':' || coalesce(order_number, '-'),
           ' | ' ORDER BY id)
    INTO v_got
    FROM public.stock_ledger
   WHERE txid = v_txid;

  v_want := 'stock:3:10:- | stock:3:-2:- | source:3:2:TEST368 | order_deleted:-:-:TEST368'
         || ' | order_item_deleted:3:-:TEST368 | source:3:-2:TEST368'
         || ' | stock:3:2:- | stock:3:-10:-';

  SELECT * INTO v_src
    FROM public.stock_ledger
   WHERE txid = v_txid AND event = 'source' AND delta = -2;

  IF v_got IS DISTINCT FROM v_want
     OR v_src.variant_id IS DISTINCT FROM v_var
     OR v_src.order_id IS DISTINCT FROM v_order
     OR v_src.status IS DISTINCT FROM 'reserved'
     OR v_src.warehouse_id IS DISTINCT FROM v_wh THEN
    RAISE EXCEPTION '368 TEST FAIL: got=[%] want=[%] src=%', v_got, v_want, row_to_json(v_src);
  END IF;

  RAISE EXCEPTION '368 TEST OK (rollback forzado): % | origin=% | api_role=%',
    v_got, v_src.origin, v_src.api_role;
END
$test$;

-- ---------------------------------------------------------------------------
-- B) Estructura (esperado: todas las columnas ok = true)
-- ---------------------------------------------------------------------------
SELECT
  to_regclass('public.stock_ledger') IS NOT NULL                                  AS ok_table,
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.stock_ledger'::regclass) AS ok_rls,
  NOT has_table_privilege('anon', 'public.stock_ledger', 'SELECT')                AS ok_anon_no_select,
  NOT has_table_privilege('authenticated', 'public.stock_ledger', 'INSERT')       AS ok_auth_no_insert,
  NOT has_table_privilege('authenticated', 'public.stock_ledger', 'UPDATE')       AS ok_auth_no_update,
  NOT has_table_privilege('authenticated', 'public.stock_ledger', 'DELETE')       AS ok_auth_no_delete,
  has_table_privilege('authenticated', 'public.stock_ledger', 'SELECT')           AS ok_auth_select,
  NOT has_table_privilege('anon', 'public.vw_stock_ledger_readable', 'SELECT')    AS ok_view_anon_no_select,
  (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'trg_stock_ledger_%') = 4
                                                                                  AS ok_4_triggers,
  NOT has_function_privilege('authenticated', 'public.fn_stock_ledger_origin()', 'EXECUTE')
                                                                                  AS ok_fn_not_exposed;

-- ---------------------------------------------------------------------------
-- C) Consultas operativas
-- ---------------------------------------------------------------------------
-- Movimientos de un SKU por talle (ej. L3040):
-- SELECT created_at, event, size, warehouse, qty_before, qty_after, delta,
--        order_number, status, origin, actor
--   FROM public.vw_stock_ledger_readable
--  WHERE sku = 'LAD-L3040-VA'
--  ORDER BY id;
--
-- Qué pedido explica un movimiento de stock (misma transacción):
-- SELECT s.created_at, s.size, s.delta, s.origin, r.event, r.order_number, r.status
--   FROM public.stock_ledger s
--   JOIN public.stock_ledger r ON r.txid = s.txid AND r.event <> 'stock'
--                             AND r.variant_id = s.variant_id AND r.size = s.size
--  WHERE s.event = 'stock' AND s.variant_id = '<variant_uuid>'
--  ORDER BY s.id;
--
-- Volumen diario:
-- SELECT date_trunc('day', created_at) d, event, count(*)
--   FROM public.stock_ledger GROUP BY 1, 2 ORDER BY 1 DESC, 2;
