-- 86_rpc_checkout_cart_ensure_deduct_by_size.sql
-- Asegura que al pasar la bolsa a "Mi pedido" se descuente el stock por talle.
-- Si en tu proyecto quedó activa la versión de 122/123, solo descontaba de variant_warehouse_stock
-- y no de variant_size_warehouse_stock, por eso el stock no bajaba.
-- Esta migración reaplica la lógica de 82: ítems con size descontan de variant_size_warehouse_stock
-- (general primero, luego venta público). Si no hay fila para ese talle, hace fallback a variant_warehouse_stock.

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
  WHERE customer_id = auth.uid() AND status = 'active'
  ORDER BY created_at DESC LIMIT 1;

  IF v_order_id IS NULL THEN
    INSERT INTO public.orders (customer_id, status, expires_at, dismantle_at)
    VALUES (
      auth.uid(),
      'active',
      now() + interval '7 days',
      now() + interval '14 days'
    )
    RETURNING id INTO v_order_id;
  ELSE
    IF v_expires_at IS NULL OR v_dismantle_at IS NULL THEN
      UPDATE public.orders
      SET
        expires_at = coalesce(expires_at, created_at + interval '7 days'),
        dismantle_at = coalesce(dismantle_at, created_at + interval '14 days')
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
    v_size_normalized := trim(coalesce(r.size, ''));

    -- Intentar descontar por talle (variant_size_warehouse_stock) si hay size y hay stock ahí
    v_use_size_table := false;
    IF v_size_normalized != '' AND v_general_id IS NOT NULL AND v_venta_id IS NOT NULL THEN
      SELECT
        COALESCE(SUM(CASE WHEN warehouse_id = v_general_id THEN stock_qty ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN warehouse_id = v_venta_id THEN stock_qty ELSE 0 END), 0)
      INTO v_size_stock_general, v_size_stock_venta
      FROM public.variant_size_warehouse_stock
      WHERE variant_id = r.variant_id AND trim(size) = v_size_normalized
        AND warehouse_id IN (v_general_id, v_venta_id);

      IF (coalesce(v_size_stock_general, 0) + coalesce(v_size_stock_venta, 0)) >= v_qty THEN
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
          WHERE variant_id = r.variant_id AND trim(size) = v_size_normalized AND warehouse_id = v_general_id;
        END IF;
        IF v_qty_from_venta > 0 THEN
          UPDATE public.variant_size_warehouse_stock
          SET stock_qty = stock_qty - v_qty_from_venta, updated_at = now()
          WHERE variant_id = r.variant_id AND trim(size) = v_size_normalized AND warehouse_id = v_venta_id;
        END IF;
      END IF;
    END IF;

    -- Si no se usó la tabla por talle, descontar de variant_warehouse_stock (general luego venta público)
    IF NOT v_use_size_table THEN
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

    -- Precio: usar price_snapshot del carrito si es válido; si no, precio de la variante (evita precios mal guardados al pasar a "Mi pedido")
    SELECT price INTO v_item_price FROM public.product_variants WHERE id = r.variant_id;
    v_item_price := COALESCE(NULLIF(r.price_snapshot, 0), v_item_price, r.price_snapshot, 0);

    INSERT INTO public.order_items (order_id, variant_id, product_name, color, size, quantity, price_snapshot, imagen, status)
    VALUES (v_order_id, r.variant_id, r.product_name, r.color, r.size, v_qty, v_item_price, r.imagen, 'reserved')
    RETURNING id INTO v_order_item_id;

    IF v_qty_from_general > 0 AND v_general_id IS NOT NULL THEN
      INSERT INTO public.order_item_stock_sources (order_item_id, warehouse_id, qty)
      VALUES (v_order_item_id, v_general_id, v_qty_from_general);
    END IF;
    IF v_qty_from_venta > 0 AND v_venta_id IS NOT NULL THEN
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

COMMENT ON FUNCTION public.rpc_checkout_cart() IS
  'Checkout: descuenta stock por talle (variant_size_warehouse_stock) o por variante (variant_warehouse_stock). Aplicar 86 después de 122/123 si el stock no se descontaba.';

SELECT pg_notify('pgrst', 'reload schema');
