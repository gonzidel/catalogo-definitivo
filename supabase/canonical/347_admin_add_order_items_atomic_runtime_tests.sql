-- 347_admin_add_order_items_atomic_runtime_tests.sql
-- Ejecutar solo en staging/local después de 347. Todo se revierte.

BEGIN;

DO $$
DECLARE
  v_admin uuid := '34700000-0000-4000-8000-000000000001';
  v_customer uuid := '34700000-0000-4000-8000-000000000002';
  v_variant uuid := '34700000-0000-4000-8000-000000000003';
  v_active_order uuid := '34700000-0000-4000-8000-000000000010';
  v_cancelled_order uuid := '34700000-0000-4000-8000-000000000020';
  v_no_stock_order uuid := '34700000-0000-4000-8000-000000000030';
  v_key uuid := '34700000-0000-4000-8000-000000000101';
  v_blocked_key uuid := '34700000-0000-4000-8000-000000000102';
  v_no_stock_key uuid := '34700000-0000-4000-8000-000000000103';
  v_general uuid;
  v_venta uuid;
  v_payload jsonb;
  v_result jsonb;
  v_blocked boolean := false;
  v_stock_blocked boolean := false;
BEGIN
  SELECT id INTO v_general
  FROM public.warehouses
  WHERE code = 'general'
  LIMIT 1;

  SELECT id INTO v_venta
  FROM public.warehouses
  WHERE code = 'venta-publico'
  LIMIT 1;

  IF v_general IS NULL OR v_venta IS NULL THEN
    RAISE EXCEPTION '347 fixture: faltan warehouses general/venta-publico';
  END IF;

  INSERT INTO public.admins(user_id, email, role)
  VALUES (v_admin, 'fixture-347@example.invalid', 'admin');

  INSERT INTO public.customers(id, full_name)
  VALUES (v_customer, 'Fixture 347');

  INSERT INTO public.product_variants(
    id,
    color,
    size,
    sku,
    price,
    stock_qty,
    reserved_qty
  )
  VALUES (
    v_variant,
    'Fixture',
    '38',
    'FIXTURE-347',
    50,
    10,
    0
  );

  INSERT INTO public.variant_size_warehouse_stock(
    variant_id,
    size,
    warehouse_id,
    stock_qty
  )
  VALUES
    (v_variant, '38', v_general, 10),
    (v_variant, '38', v_venta, 0);

  INSERT INTO public.orders(
    id,
    customer_id,
    status,
    total_amount,
    notes,
    order_number
  )
  VALUES
    (
      v_active_order,
      v_customer,
      'active',
      100,
      '{"shipping":0,"discount":0,"extras_amount":0,"extras_percentage":0}',
      'ATEST347-A'
    ),
    (
      v_cancelled_order,
      v_customer,
      'cancelled',
      0,
      '{}',
      'ATEST347-C'
    ),
    (
      v_no_stock_order,
      v_customer,
      'active',
      0,
      '{}',
      'ATEST347-S'
    );

  INSERT INTO public.order_items(
    order_id,
    product_name,
    quantity,
    price_snapshot,
    status
  )
  VALUES
    (v_active_order, 'Existente', 1, 100, 'picked'),
    (v_active_order, 'Cancelado histórico', 1, 999, 'cancelled');

  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  v_payload := jsonb_build_object(
    'expected_status', 'active',
    'notes_extras', jsonb_build_object(
      'shipping', 10,
      'discount', 5,
      'extras_amount', 2,
      'extras_percentage', 10,
      'extras_label', 'Fixture'
    ),
    'items', jsonb_build_array(
      jsonb_build_object(
        'variant_id', v_variant,
        'product_name', 'Producto fixture',
        'color', 'Fixture',
        'size', '38',
        'quantity', 2,
        'price_snapshot', 50,
        'status', 'picked',
        'admin_confirmed_missing', false,
        'is_special_extra', false,
        'qty_from_general', 2,
        'qty_from_venta', 0
      ),
      jsonb_build_object(
        'variant_id', null,
        'product_name', 'Extra fixture',
        'color', null,
        'size', null,
        'quantity', 1,
        'price_snapshot', 25,
        'status', 'picked',
        'admin_confirmed_missing', false,
        'is_special_extra', true,
        'qty_from_general', 0,
        'qty_from_venta', 0
      )
    )
  );

  v_result := public.rpc_admin_add_order_items_atomic(
    v_active_order,
    v_payload,
    v_key
  );

  IF v_result->>'ok' <> 'true'
     OR v_result->>'order_id' <> v_active_order::text
     OR jsonb_array_length(v_result->'inserted_items') <> 2
     OR (v_result->>'total_amount')::numeric <> 254.5
  THEN
    RAISE EXCEPTION '347 success: respuesta inválida: %', v_result;
  END IF;

  IF (
    SELECT stock_qty
    FROM public.variant_size_warehouse_stock
    WHERE variant_id = v_variant
      AND size = '38'
      AND warehouse_id = v_general
  ) <> 8
  OR (
    SELECT reserved_qty
    FROM public.product_variants
    WHERE id = v_variant
  ) <> 2
  OR (
    SELECT total_amount
    FROM public.orders
    WHERE id = v_active_order
  ) <> 254.5
  OR (
    SELECT coalesce(sum(s.qty), 0)
    FROM public.order_item_stock_sources s
    JOIN public.order_items oi ON oi.id = s.order_item_id
    WHERE oi.order_id = v_active_order
      AND oi.variant_id = v_variant
  ) <> 2
  THEN
    RAISE EXCEPTION '347 success: stock/reserva/total/OISS inválidos';
  END IF;

  v_result := public.rpc_admin_add_order_items_atomic(
    v_active_order,
    v_payload,
    v_key
  );

  IF v_result->'idempotency'->>'replay' <> 'true'
     OR (
       SELECT count(*)
       FROM public.order_items
       WHERE order_id = v_active_order
     ) <> 4
     OR (
       SELECT stock_qty
       FROM public.variant_size_warehouse_stock
       WHERE variant_id = v_variant
         AND size = '38'
         AND warehouse_id = v_general
     ) <> 8
  THEN
    RAISE EXCEPTION '347 replay: duplicó líneas o stock: %', v_result;
  END IF;

  BEGIN
    PERFORM public.rpc_admin_add_order_items_atomic(
      v_cancelled_order,
      jsonb_build_object(
        'expected_status', 'cancelled',
        'items', jsonb_build_array(
          jsonb_build_object(
            'variant_id', null,
            'product_name', 'No debe insertarse',
            'quantity', 1,
            'price_snapshot', 1,
            'status', 'picked',
            'is_special_extra', true
          )
        )
      ),
      v_blocked_key
    );
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%ORDER_STATE_BLOCKED%' THEN
        v_blocked := true;
      ELSE
        RAISE;
      END IF;
  END;

  IF NOT v_blocked
     OR EXISTS (
       SELECT 1
       FROM public.order_items
       WHERE order_id = v_cancelled_order
     )
     OR EXISTS (
       SELECT 1
       FROM public.admin_order_edit_idempotency
       WHERE idempotency_key = v_blocked_key
     )
  THEN
    RAISE EXCEPTION '347 cancelled: mutó pedido o dejó dedupe';
  END IF;

  BEGIN
    PERFORM public.rpc_admin_add_order_items_atomic(
      v_no_stock_order,
      jsonb_build_object(
        'expected_status', 'active',
        'items', jsonb_build_array(
          jsonb_build_object(
            'variant_id', v_variant,
            'product_name', 'Sin stock',
            'color', 'Fixture',
            'size', '38',
            'quantity', 99,
            'price_snapshot', 50,
            'status', 'picked',
            'admin_confirmed_missing', false,
            'is_special_extra', false,
            'qty_from_general', 99,
            'qty_from_venta', 0
          )
        )
      ),
      v_no_stock_key
    );
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%stock insuficiente%' THEN
        v_stock_blocked := true;
      ELSE
        RAISE;
      END IF;
  END;

  IF NOT v_stock_blocked
     OR EXISTS (
       SELECT 1
       FROM public.order_items
       WHERE order_id = v_no_stock_order
     )
     OR EXISTS (
       SELECT 1
       FROM public.admin_order_edit_idempotency
       WHERE idempotency_key = v_no_stock_key
     )
     OR (
       SELECT stock_qty
       FROM public.variant_size_warehouse_stock
       WHERE variant_id = v_variant
         AND size = '38'
         AND warehouse_id = v_general
     ) <> 8
  THEN
    RAISE EXCEPTION '347 stock failure: rollback incompleto';
  END IF;
END;
$$;

ROLLBACK;
