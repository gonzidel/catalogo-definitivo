-- 253_rpc_checkout_cart_apply_promo_discount.sql
--
-- Bug: rpc_checkout_cart() calculaba el total del pedido sumando
-- price_snapshot * qty de cada ítem (que ya incluye la oferta por color vía
-- get_effective_price en el carrito) pero NUNCA restaba el descuento de las
-- promociones 2x1/2xMonto (public.promotions / public.promotion_items). El
-- mismo bug ya se corrigió del lado admin (order-creator.js, orders.js,
-- closed-orders.js, orders-ops.js, public-sales.js) el 2026-07-21/23; esta
-- migración lo corrige en el checkout real del cliente (catálogo público),
-- que es la única pieza que quedaba pendiente porque requiere tocar SQL.
--
-- Fix: en vez de `total_amount = coalesce(total_amount,0) + coalesce(v_total,0)`
-- (suma incremental sin descuento), al final del checkout se recalcula
-- total_amount desde cero a partir de TODOS los order_items no cancelados del
-- pedido (no solo los que se acaban de agregar en este checkout — un pedido
-- puede armarse en varias vueltas de carrito/checkout) más el descuento de
-- promos activas para esas variantes. Misma fórmula ya validada en JS
-- (admin/orders-domain.js: computeOrderItemsPromoDiscount) y en las otras
-- RPCs/módulos: unidades que no completan un par de 2 pagan precio normal, no
-- se descuentan. Si el descuento calculado resulta negativo (promo mal
-- configurada, ej. fixed_amount > 2 * precio normal), se ignora esa promo en
-- particular (no se le suma monto al total).
--
-- No cambia: validación de stock, descuento de stock por depósito/talle,
-- inserción de order_items, reglas de "un pedido a la vez" (migración 251).
-- Todo eso queda idéntico a supabase/canonical/251_orders_one_open_per_customer_include_closed.sql.

CREATE OR REPLACE FUNCTION public.rpc_checkout_cart()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
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
  -- Recalculo de total con descuento de promos 2x1/2xMonto (fix 2026-07-23)
  v_all_variant_ids uuid[];
  v_gross_subtotal numeric;
  v_promo_discount numeric;
  v_promo record;
  v_promo_total_qty int;
  v_promo_total_price numeric;
  v_groups int;
  v_avg_price numeric;
  v_remainder_qty int;
  v_this_discount numeric;
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
    -- Un pedido a la vez: si el único pedido existente está cerrado (ya
    -- pagado / en preparación para envío), no se abre uno nuevo silenciosamente.
    IF EXISTS (
      SELECT 1 FROM public.orders
      WHERE customer_id = auth.uid() AND status = 'closed'
    ) THEN
      RAISE EXCEPTION
        'Ya tenés un pedido cerrado en preparación para el envío. Esperá a que se despache antes de armar uno nuevo.';
    END IF;

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
          -- El índice ahora también cubre `closed`: si la carrera fue contra un
          -- pedido `closed` (no active/closing_soon), no hay pedido para reusar.
          RAISE EXCEPTION
            'Ya tenés un pedido cerrado en preparación para el envío. Esperá a que se despache antes de armar uno nuevo.';
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

  -- Recalcular total_amount desde cero con TODOS los order_items vivos del pedido
  -- (no solo los de este checkout) menos el descuento de promos 2x1/2xMonto activas.
  -- Fix 2026-07-23: antes era `total_amount = coalesce(total_amount,0) + coalesce(v_total,0)`,
  -- que nunca restaba el descuento de promociones.
  v_gross_subtotal := 0;
  v_promo_discount := 0;

  SELECT array_agg(DISTINCT oi.variant_id)
  INTO v_all_variant_ids
  FROM public.order_items oi
  WHERE oi.order_id = v_order_id
    AND oi.status != 'cancelled'
    AND oi.variant_id IS NOT NULL;

  SELECT coalesce(sum(oi.quantity * coalesce(oi.price_snapshot, 0)), 0)
  INTO v_gross_subtotal
  FROM public.order_items oi
  WHERE oi.order_id = v_order_id
    AND oi.status != 'cancelled';

  IF v_all_variant_ids IS NOT NULL AND array_length(v_all_variant_ids, 1) > 0 THEN
    FOR v_promo IN
      SELECT * FROM public.get_active_promotions_for_variants(v_all_variant_ids)
    LOOP
      SELECT coalesce(sum(oi.quantity), 0), coalesce(sum(oi.quantity * coalesce(oi.price_snapshot, 0)), 0)
      INTO v_promo_total_qty, v_promo_total_price
      FROM public.order_items oi
      WHERE oi.order_id = v_order_id
        AND oi.status != 'cancelled'
        AND oi.variant_id = ANY(v_promo.variant_ids);

      IF coalesce(v_promo_total_qty, 0) >= 2 THEN
        v_groups := v_promo_total_qty / 2; -- división entera = floor para enteros positivos
        v_avg_price := v_promo_total_price / v_promo_total_qty;
        v_this_discount := 0;

        IF v_promo.promo_type = '2x1' THEN
          v_this_discount := v_groups * v_avg_price;
        ELSIF v_promo.promo_type = '2xMonto' AND v_promo.fixed_amount IS NOT NULL THEN
          -- Unidades que no completan un par de 2 pagan precio normal (no se descuentan).
          v_remainder_qty := v_promo_total_qty - (v_groups * 2);
          v_this_discount := v_promo_total_price
            - (v_groups * v_promo.fixed_amount + v_remainder_qty * v_avg_price);
        END IF;

        -- Si una promo mal configurada (ej. fixed_amount > 2 * precio normal) diera un
        -- "descuento" negativo, se ignora esa promo puntual (no se le suma monto al total).
        IF v_this_discount > 0 THEN
          v_promo_discount := v_promo_discount + v_this_discount;
        END IF;
      END IF;
    END LOOP;
  END IF;

  UPDATE public.orders
  SET total_amount = greatest(0, v_gross_subtotal - v_promo_discount)
  WHERE id = v_order_id;

  SELECT order_number INTO v_order_number FROM public.orders WHERE id = v_order_id;

  RETURN json_build_object('order_id', v_order_id, 'order_number', coalesce(v_order_number, ''));
END;
$function$;

COMMENT ON FUNCTION public.rpc_checkout_cart() IS
  'canonical:253 | source:supabase/canonical/253_rpc_checkout_cart_apply_promo_discount.sql | recalcula total_amount con descuento de promos 2x1/2xMonto (antes: suma cruda sin descuento) | anterior: canonical:251.';

SELECT pg_notify('pgrst', 'reload schema');
