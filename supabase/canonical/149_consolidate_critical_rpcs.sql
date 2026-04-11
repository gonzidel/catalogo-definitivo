-- 149_consolidate_critical_rpcs.sql
-- Plan 3: consolidación de RPCs críticas en una única versión canónica por función.
-- No introduce lógica funcional nueva; reaplica cuerpos canónicos existentes:
-- - rpc_checkout_cart  => canonical:124
-- - rpc_close_order    => canonical:83
-- - rpc_void_public_sale => canonical:141

CREATE OR REPLACE FUNCTION public.rpc_checkout_cart()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_cart_id uuid;
  v_order_id uuid;
  v_order_number text;
  v_total numeric := 0;
  r record;
  v_reserved int;
  v_available int;
  v_qty int;
  v_total_stock int;
  v_general_id uuid;
  v_venta_id uuid;
  v_general_stock int;
  v_remaining_qty int;
  v_qty_from_general int;
  v_qty_from_venta int;
  v_order_item_id uuid;
  v_expires_at timestamptz;
  v_dismantle_at timestamptz;
  v_size_stock_general int;
  v_size_stock_venta int;
  v_size_normalized text;
  v_use_size_table boolean;
  v_item_price numeric;
  v_size_row record;
BEGIN
  SELECT id INTO v_cart_id
  FROM public.carts
  WHERE customer_id = auth.uid() AND status = 'open'
  ORDER BY created_at DESC LIMIT 1;

  IF v_cart_id IS NULL THEN
    RAISE EXCEPTION 'No se encontró un carrito activo.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.cart_items WHERE cart_id = v_cart_id) THEN
    RAISE EXCEPTION 'El carrito está vacío.';
  END IF;

  SELECT id, expires_at, dismantle_at
  INTO v_order_id, v_expires_at, v_dismantle_at
  FROM public.orders
  WHERE customer_id = auth.uid() AND status IN ('active', 'closing_soon')
  ORDER BY
    CASE WHEN status = 'active' THEN 0 WHEN status = 'closing_soon' THEN 1 ELSE 2 END,
    created_at DESC
  LIMIT 1;

  IF v_order_id IS NULL THEN
    BEGIN
      INSERT INTO public.orders (customer_id, status, expires_at, dismantle_at)
      VALUES (
        auth.uid(),
        'active',
        now() + interval '5 days',
        now() + interval '7 days'
      )
      RETURNING id INTO v_order_id;
    EXCEPTION
      WHEN unique_violation THEN
        SELECT id, expires_at, dismantle_at
        INTO v_order_id, v_expires_at, v_dismantle_at
        FROM public.orders
        WHERE customer_id = auth.uid() AND status IN ('active', 'closing_soon')
        ORDER BY
          CASE WHEN status = 'active' THEN 0 WHEN status = 'closing_soon' THEN 1 ELSE 2 END,
          created_at DESC
        LIMIT 1;
        IF v_order_id IS NULL THEN
          RAISE;
        END IF;
    END;
  ELSE
    IF v_expires_at IS NULL OR v_dismantle_at IS NULL THEN
      UPDATE public.orders
      SET
        expires_at = coalesce(expires_at, created_at + interval '5 days'),
        dismantle_at = coalesce(dismantle_at, created_at + interval '7 days')
      WHERE id = v_order_id;
    END IF;
  END IF;

  SELECT id INTO v_general_id FROM public.warehouses WHERE code = 'general' LIMIT 1;
  SELECT id INTO v_venta_id FROM public.warehouses WHERE code = 'venta-publico' LIMIT 1;

  FOR r IN
    SELECT id, variant_id, coalesce(quantity, qty, 0) AS qty, price_snapshot, product_name, color, size, imagen
    FROM public.cart_items
    WHERE cart_id = v_cart_id
  LOOP
    v_qty := coalesce(r.qty, 0);
    IF v_qty <= 0 THEN CONTINUE; END IF;

    IF r.variant_id IS NULL THEN
      RAISE EXCEPTION 'El item % no tiene variante asociada.', r.id;
    END IF;

    SELECT public.get_total_stock(r.variant_id) INTO v_total_stock;
    SELECT reserved_qty INTO v_reserved
    FROM public.product_variants
    WHERE id = r.variant_id FOR UPDATE;

    v_available := coalesce(v_total_stock, 0) - coalesce(v_reserved, 0);
    IF v_qty > v_available THEN
      RAISE EXCEPTION
        USING MESSAGE = format(
          'Stock insuficiente para %s (color %s talle %s). Disponible: %s, solicitado: %s.',
          coalesce(r.product_name,'producto'), coalesce(r.color,'-'), coalesce(r.size,'-'),
          v_available, v_qty
        );
    END IF;

    v_qty_from_general := 0;
    v_qty_from_venta := 0;
    v_remaining_qty := 0;
    v_size_normalized := trim(coalesce(r.size::text, ''));
    IF v_size_normalized ~ '^\d+(\.\d+)?$' THEN
      v_size_normalized := split_part(v_size_normalized, '.', 1);
    END IF;

    -- Descontar por talle (variant_size_warehouse_stock) si hay size
    v_use_size_table := false;
    IF v_size_normalized != '' AND v_general_id IS NOT NULL AND v_venta_id IS NOT NULL THEN
      INSERT INTO public.variant_size_warehouse_stock (variant_id, warehouse_id, size, stock_qty)
      VALUES (r.variant_id, v_general_id, v_size_normalized, 0)
      ON CONFLICT (variant_id, warehouse_id, size) DO NOTHING;
      INSERT INTO public.variant_size_warehouse_stock (variant_id, warehouse_id, size, stock_qty)
      VALUES (r.variant_id, v_venta_id, v_size_normalized, 0)
      ON CONFLICT (variant_id, warehouse_id, size) DO NOTHING;

      v_size_stock_general := 0;
      v_size_stock_venta := 0;
      FOR v_size_row IN
        SELECT warehouse_id, stock_qty
        FROM public.variant_size_warehouse_stock
        WHERE variant_id = r.variant_id
          AND trim(coalesce(size,'')) = v_size_normalized
          AND warehouse_id IN (v_general_id, v_venta_id)
        ORDER BY warehouse_id
        FOR UPDATE
      LOOP
        IF v_size_row.warehouse_id = v_general_id THEN
          v_size_stock_general := coalesce(v_size_row.stock_qty, 0);
        ELSIF v_size_row.warehouse_id = v_venta_id THEN
          v_size_stock_venta := coalesce(v_size_row.stock_qty, 0);
        END IF;
      END LOOP;

      IF (coalesce(v_size_stock_general, 0) + coalesce(v_size_stock_venta, 0)) < v_qty THEN
        RAISE EXCEPTION
          USING MESSAGE = format(
            'Stock por talle insuficiente para %s (color %s talle %s). Disponible por talle: %s, solicitado: %s.',
            coalesce(r.product_name,'producto'),
            coalesce(r.color,'-'),
            v_size_normalized,
            coalesce(v_size_stock_general, 0) + coalesce(v_size_stock_venta, 0),
            v_qty
          );
      END IF;

      v_use_size_table := true;
      v_general_stock := coalesce(v_size_stock_general, 0);
      IF v_general_stock >= v_qty THEN
        v_qty_from_general := v_qty;
        v_remaining_qty := 0;
      ELSIF v_general_stock > 0 THEN
        v_qty_from_general := v_general_stock;
        v_remaining_qty := v_qty - v_general_stock;
      ELSE
        v_remaining_qty := v_qty;
      END IF;
      IF v_remaining_qty > 0 THEN
        v_qty_from_venta := v_remaining_qty;
      END IF;

      IF v_qty_from_general > 0 THEN
        UPDATE public.variant_size_warehouse_stock
        SET stock_qty = stock_qty - v_qty_from_general, updated_at = now()
        WHERE variant_id = r.variant_id AND trim(coalesce(size,'')) = v_size_normalized AND warehouse_id = v_general_id;
      END IF;
      IF v_qty_from_venta > 0 THEN
        UPDATE public.variant_size_warehouse_stock
        SET stock_qty = stock_qty - v_qty_from_venta, updated_at = now()
        WHERE variant_id = r.variant_id AND trim(coalesce(size,'')) = v_size_normalized AND warehouse_id = v_venta_id;
      END IF;
    END IF;

    -- Solo sin talle: descontar de variant_warehouse_stock (legacy compatible)
    IF NOT v_use_size_table AND v_size_normalized = '' THEN
      v_remaining_qty := v_qty;
      v_qty_from_general := 0;
      v_qty_from_venta := 0;

      SELECT coalesce(stock_qty, 0) INTO v_general_stock
      FROM public.variant_warehouse_stock
      WHERE variant_id = r.variant_id AND warehouse_id = v_general_id;

      IF v_general_stock > 0 THEN
        IF v_general_stock >= v_qty THEN
          UPDATE public.variant_warehouse_stock
          SET stock_qty = stock_qty - v_qty, updated_at = now()
          WHERE variant_id = r.variant_id AND warehouse_id = v_general_id;
          v_qty_from_general := v_qty;
          v_remaining_qty := 0;
        ELSE
          UPDATE public.variant_warehouse_stock
          SET stock_qty = 0, updated_at = now()
          WHERE variant_id = r.variant_id AND warehouse_id = v_general_id;
          v_remaining_qty := v_qty - v_general_stock;
          v_qty_from_general := v_general_stock;
          v_qty_from_venta := v_remaining_qty;
        END IF;
      ELSE
        v_remaining_qty := v_qty;
        v_qty_from_venta := v_qty;
      END IF;

      IF v_remaining_qty > 0 THEN
        UPDATE public.variant_warehouse_stock
        SET stock_qty = stock_qty - v_remaining_qty, updated_at = now()
        WHERE variant_id = r.variant_id AND warehouse_id = v_venta_id;
      END IF;
    END IF;

    UPDATE public.product_variants
    SET reserved_qty = greatest(reserved_qty - v_qty, 0)
    WHERE id = r.variant_id;

    SELECT price INTO v_item_price FROM public.product_variants WHERE id = r.variant_id;
    v_item_price := COALESCE(NULLIF(r.price_snapshot, 0), v_item_price, r.price_snapshot, 0);

    -- Una línea por almacén: general = reserved; venta-público = waiting (cola en local / campana).
    IF v_qty_from_general > 0 AND v_general_id IS NOT NULL THEN
      INSERT INTO public.order_items (order_id, variant_id, product_name, color, size, quantity, price_snapshot, imagen, status)
      VALUES (v_order_id, r.variant_id, r.product_name, r.color, r.size, v_qty_from_general, v_item_price, r.imagen, 'reserved')
      RETURNING id INTO v_order_item_id;
      INSERT INTO public.order_item_stock_sources (order_item_id, warehouse_id, qty)
      VALUES (v_order_item_id, v_general_id, v_qty_from_general);
    END IF;

    IF v_qty_from_venta > 0 AND v_venta_id IS NOT NULL THEN
      INSERT INTO public.order_items (order_id, variant_id, product_name, color, size, quantity, price_snapshot, imagen, status)
      VALUES (v_order_id, r.variant_id, r.product_name, r.color, r.size, v_qty_from_venta, v_item_price, r.imagen, 'waiting')
      RETURNING id INTO v_order_item_id;
      INSERT INTO public.order_item_stock_sources (order_item_id, warehouse_id, qty)
      VALUES (v_order_item_id, v_venta_id, v_qty_from_venta);
    END IF;

    v_total := v_total + (coalesce(v_item_price, 0) * v_qty);
  END LOOP;

  DELETE FROM public.cart_items WHERE cart_id = v_cart_id;

  UPDATE public.orders
  SET total_amount = coalesce(total_amount, 0) + coalesce(v_total, 0)
  WHERE id = v_order_id;

  SELECT order_number INTO v_order_number FROM public.orders WHERE id = v_order_id;

  RETURN json_build_object('order_id', v_order_id, 'order_number', coalesce(v_order_number, ''));
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_close_order(p_order_id uuid, p_payment_method text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_customer_id uuid;
  v_is_admin boolean;
  v_status text;
  v_dismantle_at timestamptz;
BEGIN
  SELECT EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()) INTO v_is_admin;

  SELECT customer_id, status, dismantle_at
  INTO v_customer_id, v_status, v_dismantle_at
  FROM public.orders
  WHERE id = p_order_id;

  IF v_customer_id IS NULL THEN
    RAISE EXCEPTION 'Pedido no encontrado';
  END IF;

  IF v_status = 'expired' THEN
    RAISE EXCEPTION 'Pedido vencido';
  END IF;

  IF v_dismantle_at IS NOT NULL AND now() >= v_dismantle_at THEN
    RAISE EXCEPTION 'Pedido vencido';
  END IF;

  IF NOT v_is_admin AND v_customer_id != auth.uid() THEN
    RAISE EXCEPTION 'No tienes permiso para cerrar este pedido';
  END IF;

  -- Solo actualizar estado; el stock ya se descontó en rpc_checkout_cart.
  -- closed_at = now() guarda el instante real (UTC); el filtro por día en BA se hace al consultar.
  UPDATE public.orders
  SET status = 'closed',
      payment_method = p_payment_method,
      closed_at = now(),
      updated_at = now()
  WHERE id = p_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No se pudo cerrar el pedido.';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_void_public_sale(p_sale_id uuid)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_sale record;
  v_psi record;
  v_wh_vp uuid;
  v_wh_g uuid;
  v_pv_size text;
  v_norm text;
  v_has_size_model boolean;
BEGIN
  SELECT id INTO v_wh_vp FROM public.warehouses WHERE code = 'venta-publico' LIMIT 1;
  SELECT id INTO v_wh_g FROM public.warehouses WHERE code = 'general' LIMIT 1;

  IF v_wh_vp IS NULL THEN
    RAISE EXCEPTION 'Warehouse venta-publico no encontrado';
  END IF;
  IF v_wh_g IS NULL THEN
    RAISE EXCEPTION 'Warehouse general no encontrado';
  END IF;

  SELECT id, sale_number, customer_id, credit_used, voided_at INTO v_sale
  FROM public.public_sales WHERE id = p_sale_id;

  IF v_sale.id IS NULL THEN
    RAISE EXCEPTION 'Venta no encontrada';
  END IF;
  IF v_sale.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'La venta ya está anulada';
  END IF;

  FOR v_psi IN
    SELECT psi.*, pv.size AS pv_size
    FROM public.public_sale_items psi
    LEFT JOIN public.product_variants pv ON pv.id = psi.variant_id
    WHERE psi.sale_id = p_sale_id AND psi.variant_id IS NOT NULL
  LOOP
    PERFORM 1
    FROM public.product_variants pv
    WHERE pv.id = v_psi.variant_id
    FOR UPDATE;

    IF (v_psi.qty_venta_publico IS NULL) <> (v_psi.qty_general IS NULL) THEN
      RAISE EXCEPTION 'public_sale_items id %: qty_venta_publico y qty_general deben ser ambas NULL o ambas NOT NULL',
        v_psi.id;
    END IF;

    IF v_psi.qty_venta_publico IS NULL AND v_psi.qty_general IS NULL THEN
      SELECT (
        EXISTS (
          SELECT 1
          FROM public.variant_size_warehouse_stock
          WHERE variant_id = v_psi.variant_id
          LIMIT 1
        )
        OR EXISTS (
          SELECT 1
          FROM public.variant_sizes
          WHERE variant_id = v_psi.variant_id
            AND TRIM(COALESCE(size, '')) <> ''
          LIMIT 1
        )
      )
      INTO v_has_size_model;

      IF COALESCE(v_has_size_model, false) THEN
        RAISE EXCEPTION 'La variante % usa talles. No se puede anular línea legacy sin size.', v_psi.variant_id;
      END IF;

      IF v_psi.is_return THEN
        UPDATE public.variant_warehouse_stock
        SET stock_qty = greatest(0, stock_qty - v_psi.qty), updated_at = now()
        WHERE variant_id = v_psi.variant_id AND warehouse_id = v_wh_vp;
      ELSE
        INSERT INTO public.variant_warehouse_stock (variant_id, warehouse_id, stock_qty)
        VALUES (v_psi.variant_id, v_wh_vp, v_psi.qty)
        ON CONFLICT (variant_id, warehouse_id)
        DO UPDATE SET
          stock_qty = public.variant_warehouse_stock.stock_qty + v_psi.qty,
          updated_at = now();
      END IF;
      CONTINUE;
    END IF;

    -- Preferir talle guardado en la línea (mismo criterio que al descontar); pv.size solo respaldo
    v_norm := NULL;
    IF v_psi.sold_size_normalized IS NOT NULL AND TRIM(v_psi.sold_size_normalized::text) != '' THEN
      v_norm := TRIM(v_psi.sold_size_normalized::text);
      IF v_norm ~ '^\d+(\.\d+)?$' THEN
        v_norm := split_part(v_norm, '.', 1);
      END IF;
    END IF;
    IF v_norm IS NULL OR v_norm = '' THEN
      v_pv_size := v_psi.pv_size;
      IF v_pv_size IS NOT NULL AND TRIM(v_pv_size::text) != '' THEN
        v_norm := TRIM(v_pv_size::text);
        IF v_norm ~ '^\d+(\.\d+)?$' THEN
          v_norm := split_part(v_norm, '.', 1);
        END IF;
      END IF;
    END IF;

    IF v_norm IS NULL OR v_norm = '' THEN
      SELECT (
        EXISTS (
          SELECT 1
          FROM public.variant_size_warehouse_stock
          WHERE variant_id = v_psi.variant_id
          LIMIT 1
        )
        OR EXISTS (
          SELECT 1
          FROM public.variant_sizes
          WHERE variant_id = v_psi.variant_id
            AND TRIM(COALESCE(size, '')) <> ''
          LIMIT 1
        )
      )
      INTO v_has_size_model;

      IF COALESCE(v_has_size_model, false) THEN
        RAISE EXCEPTION 'La variante % usa talles. No se puede anular línea sin size.', v_psi.variant_id;
      END IF;

      IF v_psi.is_return THEN
        UPDATE public.variant_warehouse_stock
        SET stock_qty = greatest(0, stock_qty - v_psi.qty), updated_at = now()
        WHERE variant_id = v_psi.variant_id AND warehouse_id = v_wh_vp;
      ELSE
        INSERT INTO public.variant_warehouse_stock (variant_id, warehouse_id, stock_qty)
        VALUES (v_psi.variant_id, v_wh_vp, v_psi.qty)
        ON CONFLICT (variant_id, warehouse_id)
        DO UPDATE SET
          stock_qty = public.variant_warehouse_stock.stock_qty + v_psi.qty,
          updated_at = now();
      END IF;
      CONTINUE;
    END IF;

    INSERT INTO public.variant_size_warehouse_stock (variant_id, size, warehouse_id, stock_qty)
    VALUES (v_psi.variant_id, v_norm, v_wh_vp, 0)
    ON CONFLICT (variant_id, size, warehouse_id) DO NOTHING;
    INSERT INTO public.variant_size_warehouse_stock (variant_id, size, warehouse_id, stock_qty)
    VALUES (v_psi.variant_id, v_norm, v_wh_g, 0)
    ON CONFLICT (variant_id, size, warehouse_id) DO NOTHING;

    PERFORM 1
    FROM public.variant_size_warehouse_stock
    WHERE variant_id = v_psi.variant_id
      AND size = v_norm
      AND warehouse_id IN (v_wh_vp, v_wh_g)
    ORDER BY warehouse_id
    FOR UPDATE;

    IF v_psi.is_return THEN
      IF v_psi.qty_venta_publico > 0 THEN
        UPDATE public.variant_size_warehouse_stock
        SET stock_qty = greatest(0, stock_qty - v_psi.qty_venta_publico), updated_at = now()
        WHERE variant_id = v_psi.variant_id AND size = v_norm AND warehouse_id = v_wh_vp;
      END IF;
    ELSE
      IF v_psi.qty_venta_publico > 0 THEN
        INSERT INTO public.variant_size_warehouse_stock (variant_id, size, warehouse_id, stock_qty)
        VALUES (v_psi.variant_id, v_norm, v_wh_vp, 0)
        ON CONFLICT (variant_id, size, warehouse_id) DO NOTHING;
        UPDATE public.variant_size_warehouse_stock
        SET stock_qty = stock_qty + v_psi.qty_venta_publico, updated_at = now()
        WHERE variant_id = v_psi.variant_id AND size = v_norm AND warehouse_id = v_wh_vp;
      END IF;
      IF v_psi.qty_general > 0 THEN
        INSERT INTO public.variant_size_warehouse_stock (variant_id, size, warehouse_id, stock_qty)
        VALUES (v_psi.variant_id, v_norm, v_wh_g, 0)
        ON CONFLICT (variant_id, size, warehouse_id) DO NOTHING;
        UPDATE public.variant_size_warehouse_stock
        SET stock_qty = stock_qty + v_psi.qty_general, updated_at = now()
        WHERE variant_id = v_psi.variant_id AND size = v_norm AND warehouse_id = v_wh_g;
      END IF;
    END IF;
  END LOOP;

  IF v_sale.customer_id IS NOT NULL AND coalesce(v_sale.credit_used, 0) > 0 THEN
    PERFORM public.rpc_add_customer_credit(
      v_sale.customer_id,
      v_sale.credit_used,
      'Crédito restaurado por anulación de venta ' || v_sale.sale_number
    );
  END IF;

  UPDATE public.public_sales SET voided_at = now() WHERE id = p_sale_id;

  RETURN json_build_object('success', true, 'sale_number', v_sale.sale_number);
END $$;

COMMENT ON FUNCTION public.rpc_checkout_cart() IS
  'canonical:124 | source:supabase/canonical/124_rpc_checkout_cart_deduct_by_size.sql';
COMMENT ON FUNCTION public.rpc_close_order(uuid, text) IS
  'canonical:83 | source:supabase/canonical/83_rpc_close_order_no_stock_deduction.sql';
COMMENT ON FUNCTION public.rpc_void_public_sale(uuid) IS
  'canonical:141 | source:supabase/canonical/141_public_sale_stock_trace_and_void.sql';

SELECT pg_notify('pgrst', 'reload schema');
