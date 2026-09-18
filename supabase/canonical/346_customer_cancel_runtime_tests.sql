-- 346_customer_cancel_runtime_tests.sql
-- Ejecutar solo en staging/local después de 346. Todo se revierte.

BEGIN;

DO $$
DECLARE
  v_customer uuid := '34600000-0000-4000-8000-000000000001';
  v_other_customer uuid := '34600000-0000-4000-8000-000000000002';
  v_reserved_order uuid := '34600000-0000-4000-8000-000000000011';
  v_reserved_item uuid := '34600000-0000-4000-8000-000000000012';
  v_next_order uuid := '34600000-0000-4000-8000-000000000013';
  v_picked_order uuid := '34600000-0000-4000-8000-000000000021';
  v_picked_item uuid := '34600000-0000-4000-8000-000000000022';
  v_warehouse uuid := '34600000-0000-4000-8000-000000000023';
  v_deleted_order uuid := '34600000-0000-4000-8000-000000000031';
  v_result jsonb;
  v_blocked boolean := false;
  v_unauthorized_blocked boolean := false;
BEGIN
  INSERT INTO public.customers (id, full_name)
  VALUES
    (v_customer, 'Fixture 346'),
    (v_other_customer, 'Fixture 346 otro');

  INSERT INTO public.orders (
    id,
    customer_id,
    status,
    total_amount,
    order_number
  )
  VALUES (
    v_reserved_order,
    v_customer,
    'active',
    2000,
    'ATEST346-R'
  );

  INSERT INTO public.order_items (
    id,
    order_id,
    product_name,
    quantity,
    price_snapshot,
    status
  )
  VALUES (
    v_reserved_item,
    v_reserved_order,
    'Fixture reservado',
    2,
    1000,
    'reserved'
  );

  PERFORM set_config('request.jwt.claim.sub', v_customer::text, true);

  v_result := public.rpc_customer_cancel_order(v_reserved_order)::jsonb;

  IF v_result->>'ok' <> 'true'
     OR v_result->>'verified' <> 'true'
     OR v_result->>'order_status' <> 'cancelled'
     OR v_result->>'order_deleted' <> 'false'
  THEN
    RAISE EXCEPTION '346 reserved: resultado inválido: %', v_result;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.orders o
    WHERE o.id = v_reserved_order
      AND o.status = 'cancelled'
  )
  OR EXISTS (
    SELECT 1
    FROM public.order_items oi
    WHERE oi.order_id = v_reserved_order
      AND lower(trim(coalesce(oi.status, ''))) <> 'cancelled'
  )
  THEN
    RAISE EXCEPTION '346 reserved: postcondición persistida inválida';
  END IF;

  IF (
    SELECT count(*)
    FROM public.customer_order_cancellation_audit a
    WHERE a.order_id = v_reserved_order
      AND a.customer_id = v_customer
  ) <> 1
  THEN
    RAISE EXCEPTION '346 reserved: recibo de auditoría ausente/duplicado';
  END IF;

  v_result := public.rpc_customer_cancel_order(v_reserved_order)::jsonb;
  IF v_result->>'idempotent_replay' <> 'true' THEN
    RAISE EXCEPTION '346 replay: no fue idempotente: %', v_result;
  END IF;

  INSERT INTO public.orders (
    id,
    customer_id,
    status,
    total_amount,
    order_number
  )
  VALUES (
    v_next_order,
    v_customer,
    'active',
    0,
    'ATEST346-N'
  );

  IF NOT EXISTS (
    SELECT 1
    FROM public.orders o
    WHERE o.id = v_next_order
      AND o.status = 'active'
      AND o.order_number <> 'ATEST346-R'
  )
  THEN
    RAISE EXCEPTION '346 next order: no se pudo crear otro pedido/número';
  END IF;

  BEGIN
    INSERT INTO public.order_items (
      order_id,
      product_name,
      quantity,
      price_snapshot,
      status
    )
    VALUES (
      v_reserved_order,
      'No debe insertarse',
      1,
      1,
      'reserved'
    );

    SET CONSTRAINTS order_items_reject_cancelled_parent IMMEDIATE;
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'No se pueden agregar productos a un pedido cancelado%' THEN
        v_blocked := true;
      ELSE
        RAISE;
      END IF;
  END;

  SET CONSTRAINTS order_items_reject_cancelled_parent DEFERRED;

  IF NOT v_blocked THEN
    RAISE EXCEPTION '346 race guard: permitió insertar en cancelled';
  END IF;

  INSERT INTO public.warehouses (id, code, name)
  VALUES (v_warehouse, 'fixture-346', 'Fixture 346');

  INSERT INTO public.orders (
    id,
    customer_id,
    status,
    total_amount,
    order_number
  )
  VALUES (
    v_picked_order,
    v_other_customer,
    'active',
    1500,
    'ATEST346-P'
  );

  INSERT INTO public.order_items (
    id,
    order_id,
    product_name,
    quantity,
    price_snapshot,
    status
  )
  VALUES (
    v_picked_item,
    v_picked_order,
    'Fixture apartado',
    1,
    1500,
    'picked'
  );

  INSERT INTO public.order_item_stock_sources (
    order_item_id,
    warehouse_id,
    qty
  )
  VALUES (v_picked_item, v_warehouse, 1);

  PERFORM set_config('request.jwt.claim.sub', v_other_customer::text, true);
  v_result := public.rpc_customer_cancel_order(v_picked_order)::jsonb;

  IF v_result->>'verified' <> 'true'
     OR v_result->>'had_picked' <> 'true'
     OR NOT EXISTS (
       SELECT 1
       FROM public.order_item_stock_sources s
       WHERE s.order_item_id = v_picked_item
         AND s.qty = 1
     )
  THEN
    RAISE EXCEPTION '346 picked: perdió fuente pendiente o respuesta inválida: %', v_result;
  END IF;

  INSERT INTO public.order_empty_deletion_audit (
    order_id,
    customer_id,
    source,
    order_number
  )
  VALUES (
    v_deleted_order,
    v_customer,
    'fixture_346_old_deleted',
    'ATEST346-D'
  );

  PERFORM set_config('request.jwt.claim.sub', v_customer::text, true);
  v_result := public.rpc_customer_cancel_order(v_deleted_order)::jsonb;

  IF v_result->>'verified' <> 'true'
     OR v_result->>'order_status' <> 'deleted'
     OR v_result->>'order_deleted' <> 'true'
     OR NOT EXISTS (
       SELECT 1
       FROM public.customer_order_cancellation_audit a
       WHERE a.order_id = v_deleted_order
     )
  THEN
    RAISE EXCEPTION '346 deleted replay: resultado/recibo inválido: %', v_result;
  END IF;

  BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_other_customer::text, true);
    PERFORM public.rpc_customer_cancel_order(v_reserved_order);
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'No tenés permiso%' OR SQLERRM LIKE 'Pedido no encontrado%' THEN
        v_unauthorized_blocked := true;
      ELSE
        RAISE;
      END IF;
  END;

  IF NOT v_unauthorized_blocked THEN
    RAISE EXCEPTION '346 auth: otro cliente pudo reproducir/cancelar el pedido';
  END IF;

  RAISE NOTICE '346 runtime fixtures: PASS';
END;
$$;

ROLLBACK;
