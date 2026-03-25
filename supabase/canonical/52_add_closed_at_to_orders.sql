-- 52_add_closed_at_to_orders.sql - Agregar columna closed_at a orders y actualizar rpc_close_order

-- Agregar columna closed_at si no existe
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS closed_at timestamptz;

-- Actualizar rpc_close_order para guardar closed_at cuando se cierra el pedido
CREATE OR REPLACE FUNCTION public.rpc_close_order(p_order_id uuid, p_payment_method text DEFAULT NULL)
RETURNS void 
LANGUAGE plpgsql 
SECURITY DEFINER 
AS $$
DECLARE
  v_customer_id uuid;
  v_is_admin boolean;
  v_item record;
  v_size text;
  v_variant_id uuid;
  v_qty int;
  v_general_warehouse_id uuid;
  v_venta_publico_warehouse_id uuid;
  v_size_stock_general int;
  v_size_stock_venta_publico int;
  v_qty_venta_publico int;
  v_qty_general int;
BEGIN
  -- Verificar si el usuario es admin
  SELECT EXISTS (
    SELECT 1 FROM public.admins
    WHERE user_id = auth.uid()
  ) INTO v_is_admin;

  -- Obtener el customer_id del pedido
  SELECT customer_id INTO v_customer_id
  FROM public.orders
  WHERE id = p_order_id;

  IF v_customer_id IS NULL THEN
    RAISE EXCEPTION 'Pedido no encontrado';
  END IF;

  -- Verificar permisos:
  -- 1. Si es admin, puede cerrar cualquier pedido
  -- 2. Si es cliente, solo puede cerrar sus propios pedidos
  IF NOT v_is_admin AND v_customer_id != auth.uid() THEN
    RAISE EXCEPTION 'No tienes permiso para cerrar este pedido';
  END IF;

  -- Obtener IDs de warehouses
  SELECT id INTO v_general_warehouse_id FROM public.warehouses WHERE code = 'general' LIMIT 1;
  SELECT id INTO v_venta_publico_warehouse_id FROM public.warehouses WHERE code = 'venta-publico' LIMIT 1;

  -- Descontar stock de los items del pedido que están en estado 'picked' o 'waiting'
  FOR v_item IN 
    SELECT 
      oi.variant_id,
      oi.size,
      oi.quantity
    FROM public.order_items oi
    WHERE oi.order_id = p_order_id
      AND oi.status IN ('picked', 'waiting')
      AND oi.variant_id IS NOT NULL
  LOOP
    v_variant_id := v_item.variant_id;
    v_size := v_item.size;
    v_qty := v_item.quantity;

    -- Si hay tamaño específico, usar variant_size_warehouse_stock
    IF v_size IS NOT NULL AND v_size != '' AND v_general_warehouse_id IS NOT NULL AND v_venta_publico_warehouse_id IS NOT NULL THEN
      -- Obtener stock por talle
      SELECT 
        COALESCE(SUM(CASE WHEN warehouse_id = v_general_warehouse_id THEN stock_qty ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN warehouse_id = v_venta_publico_warehouse_id THEN stock_qty ELSE 0 END), 0)
      INTO v_size_stock_general, v_size_stock_venta_publico
      FROM public.variant_size_warehouse_stock
      WHERE variant_id = v_variant_id
        AND size = v_size
        AND warehouse_id IN (v_general_warehouse_id, v_venta_publico_warehouse_id);

      -- Priorizar venta-publico, luego general
      IF v_size_stock_venta_publico >= v_qty THEN
        v_qty_venta_publico := v_qty;
        v_qty_general := 0;
      ELSIF (v_size_stock_venta_publico + v_size_stock_general) >= v_qty THEN
        v_qty_venta_publico := v_size_stock_venta_publico;
        v_qty_general := v_qty - v_size_stock_venta_publico;
      ELSE
        -- Stock insuficiente, pero descontar lo que haya
        v_qty_venta_publico := v_size_stock_venta_publico;
        v_qty_general := v_size_stock_general;
      END IF;

      -- Descontar de variant_size_warehouse_stock
      IF v_qty_venta_publico > 0 THEN
        UPDATE public.variant_size_warehouse_stock
        SET stock_qty = stock_qty - v_qty_venta_publico,
            updated_at = now()
        WHERE variant_id = v_variant_id
          AND size = v_size
          AND warehouse_id = v_venta_publico_warehouse_id;
      END IF;

      IF v_qty_general > 0 THEN
        UPDATE public.variant_size_warehouse_stock
        SET stock_qty = stock_qty - v_qty_general,
            updated_at = now()
        WHERE variant_id = v_variant_id
          AND size = v_size
          AND warehouse_id = v_general_warehouse_id;
      END IF;
    ELSE
      -- Sin tamaño específico, usar variant_warehouse_stock (legacy)
      SELECT 
        COALESCE(SUM(CASE WHEN warehouse_id = v_general_warehouse_id THEN stock_qty ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN warehouse_id = v_venta_publico_warehouse_id THEN stock_qty ELSE 0 END), 0)
      INTO v_size_stock_general, v_size_stock_venta_publico
      FROM public.variant_warehouse_stock
      WHERE variant_id = v_variant_id
        AND warehouse_id IN (v_general_warehouse_id, v_venta_publico_warehouse_id);

      -- Priorizar venta-publico, luego general
      IF v_size_stock_venta_publico >= v_qty THEN
        v_qty_venta_publico := v_qty;
        v_qty_general := 0;
      ELSIF (v_size_stock_venta_publico + v_size_stock_general) >= v_qty THEN
        v_qty_venta_publico := v_size_stock_venta_publico;
        v_qty_general := v_qty - v_size_stock_venta_publico;
      ELSE
        -- Stock insuficiente, pero descontar lo que haya
        v_qty_venta_publico := v_size_stock_venta_publico;
        v_qty_general := v_size_stock_general;
      END IF;

      -- Descontar de variant_warehouse_stock
      IF v_qty_venta_publico > 0 AND v_venta_publico_warehouse_id IS NOT NULL THEN
        UPDATE public.variant_warehouse_stock
        SET stock_qty = stock_qty - v_qty_venta_publico,
            updated_at = now()
        WHERE variant_id = v_variant_id
          AND warehouse_id = v_venta_publico_warehouse_id;
      END IF;

      IF v_qty_general > 0 AND v_general_warehouse_id IS NOT NULL THEN
        UPDATE public.variant_warehouse_stock
        SET stock_qty = stock_qty - v_qty_general,
            updated_at = now()
        WHERE variant_id = v_variant_id
          AND warehouse_id = v_general_warehouse_id;
      END IF;
    END IF;
  END LOOP;

  -- Actualizar el estado del pedido, el método de pago y la fecha de cierre.
  -- closed_at = now() guarda el instante real; el día en BA se calcula al filtrar (rpc_get_shipping_orders).
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

