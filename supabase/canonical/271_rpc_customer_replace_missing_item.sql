-- 271_rpc_customer_replace_missing_item.sql
--
-- Panel "Alternativas en Talle N" (ActiveOrderTab.tsx / AlternativesPanel):
-- cuando un producto queda "sin stock" (missing), se le muestran a la
-- clienta hasta 6 alternativas similares en el mismo talle. Hasta ahora
-- tocar una de esas 6 solo navegaba a la ficha del producto (<a href=...>)
-- -- no reemplazaba nada. La función `handleSelectAlternative` que sí
-- existía en el frontend solo agregaba la alternativa al carrito local
-- (para checkout manual después) y cancelaba el ítem sin stock -- dos pasos
-- separados y sin relación real con "reservado" en el pedido.
--
-- Esta RPC reemplaza el ítem "missing" por la alternativa elegida en un
-- solo paso atómico:
--   1) Reserva stock de la variante alternativa para la MISMA cantidad que
--      tenía el ítem sin stock, con la misma lógica de reparto por depósito
--      que rpc_checkout_cart (talle por variant_size_warehouse_stock si
--      existe, si no variant_warehouse_stock legacy; general -> reserved,
--      venta-publico -> waiting).
--   2) Si no alcanza el stock, aborta con excepción (no se cancela nada del
--      lado del ítem sin stock -- el frontend muestra el error y el panel
--      de alternativas sigue abierto).
--   3) Cancela el ítem "missing" original (nunca tuvo stock real reservado,
--      no hay nada que devolver) y lo marca admin_confirmed_missing=true,
--      mismo criterio que 269 para que el Kanban admin no lo trate como
--      pendiente de confirmar devolución de stock.
--   4) Recalcula total_amount desde cero sobre los ítems no cancelados
--      (gross, sin descuento de promos 2x1/2xMonto -- mismo alcance que
--      rpc_cancel_order_item, que tampoco los recalcula).
--
-- El precio se toma siempre de `product_variants.price` en el servidor
-- (no se confía en un precio mandado por el cliente).

CREATE OR REPLACE FUNCTION public.rpc_customer_replace_missing_item(
  p_missing_item_id uuid,
  p_variant_id uuid,
  p_product_name text,
  p_color text,
  p_size text,
  p_imagen text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_missing record;
  v_order record;
  v_qty int;
  v_reserved int;
  v_total_stock int;
  v_available int;
  v_general_id uuid;
  v_venta_id uuid;
  v_general_stock int;
  v_remaining_qty int;
  v_qty_from_general int;
  v_qty_from_venta int;
  v_size_normalized text;
  v_use_size_table boolean;
  v_size_stock_general int;
  v_size_stock_venta int;
  v_size_row record;
  v_item_price numeric;
  v_new_item_id uuid;
  v_gross_subtotal numeric;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  SELECT id, order_id, status, quantity
  INTO v_missing
  FROM public.order_items
  WHERE id = p_missing_item_id
  FOR UPDATE;

  IF v_missing.id IS NULL THEN
    RAISE EXCEPTION 'Ítem no encontrado';
  END IF;

  IF v_missing.status <> 'missing' THEN
    RAISE EXCEPTION 'Este ítem ya no está marcado como sin stock';
  END IF;

  SELECT id, customer_id, status
  INTO v_order
  FROM public.orders
  WHERE id = v_missing.order_id
  FOR UPDATE;

  IF v_order.customer_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'No tenés permiso para modificar este pedido';
  END IF;

  IF v_order.status NOT IN ('active', 'closing_soon') THEN
    RAISE EXCEPTION 'Este pedido no admite cambios';
  END IF;

  IF p_variant_id IS NULL THEN
    RAISE EXCEPTION 'Falta la variante del producto alternativo';
  END IF;

  v_qty := greatest(coalesce(v_missing.quantity, 0), 1);

  SELECT public.get_total_stock(p_variant_id) INTO v_total_stock;
  SELECT reserved_qty INTO v_reserved
  FROM public.product_variants
  WHERE id = p_variant_id
  FOR UPDATE;

  v_available := coalesce(v_total_stock, 0) - coalesce(v_reserved, 0);
  IF v_qty > v_available THEN
    RAISE EXCEPTION
      USING MESSAGE = format(
        'Sin stock suficiente para %s (color %s talle %s). Disponible: %s.',
        coalesce(p_product_name, 'producto'), coalesce(p_color, '-'), coalesce(p_size, '-'), v_available
      );
  END IF;

  SELECT id INTO v_general_id FROM public.warehouses WHERE code = 'general' LIMIT 1;
  SELECT id INTO v_venta_id FROM public.warehouses WHERE code = 'venta-publico' LIMIT 1;

  v_qty_from_general := 0;
  v_qty_from_venta := 0;
  v_remaining_qty := 0;
  v_size_normalized := trim(coalesce(p_size, ''));
  IF v_size_normalized ~ '^\d+(\.\d+)?$' THEN
    v_size_normalized := split_part(v_size_normalized, '.', 1);
  END IF;

  v_use_size_table := false;
  IF v_size_normalized != '' AND v_general_id IS NOT NULL AND v_venta_id IS NOT NULL THEN
    INSERT INTO public.variant_size_warehouse_stock (variant_id, warehouse_id, size, stock_qty)
    VALUES (p_variant_id, v_general_id, v_size_normalized, 0)
    ON CONFLICT (variant_id, warehouse_id, size) DO NOTHING;
    INSERT INTO public.variant_size_warehouse_stock (variant_id, warehouse_id, size, stock_qty)
    VALUES (p_variant_id, v_venta_id, v_size_normalized, 0)
    ON CONFLICT (variant_id, warehouse_id, size) DO NOTHING;

    v_size_stock_general := 0;
    v_size_stock_venta := 0;
    FOR v_size_row IN
      SELECT warehouse_id, stock_qty
      FROM public.variant_size_warehouse_stock
      WHERE variant_id = p_variant_id
        AND trim(coalesce(size, '')) = v_size_normalized
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
          'Sin stock por talle suficiente para %s (color %s talle %s). Disponible: %s.',
          coalesce(p_product_name, 'producto'), coalesce(p_color, '-'), v_size_normalized,
          coalesce(v_size_stock_general, 0) + coalesce(v_size_stock_venta, 0)
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
      WHERE variant_id = p_variant_id AND trim(coalesce(size, '')) = v_size_normalized AND warehouse_id = v_general_id;
    END IF;
    IF v_qty_from_venta > 0 THEN
      UPDATE public.variant_size_warehouse_stock
      SET stock_qty = stock_qty - v_qty_from_venta, updated_at = now()
      WHERE variant_id = p_variant_id AND trim(coalesce(size, '')) = v_size_normalized AND warehouse_id = v_venta_id;
    END IF;
  END IF;

  IF NOT v_use_size_table AND v_size_normalized = '' THEN
    v_remaining_qty := v_qty;
    v_qty_from_general := 0;
    v_qty_from_venta := 0;

    SELECT coalesce(stock_qty, 0) INTO v_general_stock
    FROM public.variant_warehouse_stock
    WHERE variant_id = p_variant_id AND warehouse_id = v_general_id;

    IF v_general_stock > 0 THEN
      IF v_general_stock >= v_qty THEN
        UPDATE public.variant_warehouse_stock
        SET stock_qty = stock_qty - v_qty, updated_at = now()
        WHERE variant_id = p_variant_id AND warehouse_id = v_general_id;
        v_qty_from_general := v_qty;
        v_remaining_qty := 0;
      ELSE
        UPDATE public.variant_warehouse_stock
        SET stock_qty = 0, updated_at = now()
        WHERE variant_id = p_variant_id AND warehouse_id = v_general_id;
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
      WHERE variant_id = p_variant_id AND warehouse_id = v_venta_id;
    END IF;
  END IF;

  UPDATE public.product_variants
  SET reserved_qty = coalesce(reserved_qty, 0) + v_qty
  WHERE id = p_variant_id;

  SELECT price INTO v_item_price FROM public.product_variants WHERE id = p_variant_id;
  v_item_price := coalesce(v_item_price, 0);

  IF v_qty_from_general > 0 AND v_general_id IS NOT NULL THEN
    INSERT INTO public.order_items (order_id, variant_id, product_name, color, size, quantity, price_snapshot, imagen, status)
    VALUES (v_order.id, p_variant_id, p_product_name, p_color, p_size, v_qty_from_general, v_item_price, p_imagen, 'reserved')
    RETURNING id INTO v_new_item_id;
    INSERT INTO public.order_item_stock_sources (order_item_id, warehouse_id, qty)
    VALUES (v_new_item_id, v_general_id, v_qty_from_general);
  END IF;

  IF v_qty_from_venta > 0 AND v_venta_id IS NOT NULL THEN
    INSERT INTO public.order_items (order_id, variant_id, product_name, color, size, quantity, price_snapshot, imagen, status)
    VALUES (v_order.id, p_variant_id, p_product_name, p_color, p_size, v_qty_from_venta, v_item_price, p_imagen, 'waiting')
    RETURNING id INTO v_new_item_id;
    INSERT INTO public.order_item_stock_sources (order_item_id, warehouse_id, qty)
    VALUES (v_new_item_id, v_venta_id, v_qty_from_venta);
  END IF;

  -- El ítem "missing" nunca tuvo stock real reservado -- cancelarlo acá
  -- directamente (ya tenemos el row lockeado) en vez de llamar a
  -- rpc_cancel_order_item, y marcar admin_confirmed_missing=true (mismo
  -- criterio que 269) para que el Kanban admin no lo trate como pendiente
  -- de confirmar devolución de stock.
  UPDATE public.order_items
  SET status = 'cancelled', admin_confirmed_missing = true, updated_at = now()
  WHERE id = p_missing_item_id;

  SELECT coalesce(sum(oi.quantity * coalesce(oi.price_snapshot, 0)), 0)
  INTO v_gross_subtotal
  FROM public.order_items oi
  WHERE oi.order_id = v_order.id
    AND oi.status != 'cancelled';

  UPDATE public.orders
  SET total_amount = v_gross_subtotal, updated_at = now()
  WHERE id = v_order.id;

  RETURN json_build_object('ok', true, 'order_id', v_order.id, 'new_item_id', v_new_item_id);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.rpc_customer_replace_missing_item(uuid, uuid, text, text, text, text) TO authenticated;

SELECT pg_notify('pgrst', 'reload schema');
