-- 10_checkout_flow_restore.sql — Restaurar descuento de stock en pedidos
-- Este script actualiza las funciones para descontar stock por talle cuando se cierran o envían pedidos

-- ============================================
-- PARTE 1: Actualizar rpc_close_order para descontar stock por talle
-- ============================================

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
      -- Obtener stock total
      SELECT 
        COALESCE(SUM(CASE WHEN w.code = 'general' THEN vws.stock_qty ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN w.code = 'venta-publico' THEN vws.stock_qty ELSE 0 END), 0)
      INTO v_size_stock_general, v_size_stock_venta_publico
      FROM public.warehouses w
      LEFT JOIN public.variant_warehouse_stock vws 
        ON vws.warehouse_id = w.id 
        AND vws.variant_id = v_variant_id
      WHERE w.code IN ('general', 'venta-publico');

      -- Priorizar venta-publico, luego general
      IF v_size_stock_venta_publico >= v_qty THEN
        v_qty_venta_publico := v_qty;
        v_qty_general := 0;
      ELSIF (v_size_stock_venta_publico + v_size_stock_general) >= v_qty THEN
        v_qty_venta_publico := v_size_stock_venta_publico;
        v_qty_general := v_qty - v_size_stock_venta_publico;
      ELSE
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

  -- Actualizar el estado del pedido y el método de pago
  UPDATE public.orders
     SET status = 'closed',
         payment_method = p_payment_method,
         updated_at = now()
   WHERE id = p_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No se pudo cerrar el pedido.';
  END IF;
END;
$$;

-- ============================================
-- PARTE 2: Actualizar rpc_mark_order_as_sent (si es necesario descontar aquí también)
-- Nota: Si el stock ya se descontó en rpc_close_order, no es necesario descontar aquí
-- ============================================

-- La función rpc_mark_order_as_sent solo marca como enviado, el stock ya se descontó al cerrar
-- Pero verificamos que el pedido esté cerrado antes de marcarlo como enviado

CREATE OR REPLACE FUNCTION public.rpc_mark_order_as_sent(p_order_id uuid)
RETURNS void 
LANGUAGE plpgsql 
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order_record RECORD;
  v_customer_name text;
  v_sale_time time;
  v_total_items int;
  v_total_amount numeric;
  v_sent_at timestamptz;
BEGIN
  -- Verificar que el usuario es admin
  IF NOT EXISTS (
    SELECT 1 FROM public.admins
    WHERE user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Solo administradores pueden marcar pedidos como terminados';
  END IF;

  -- Obtener información del pedido
  SELECT 
    o.id,
    o.status,
    o.customer_id,
    o.total_amount,
    o.sent_at,
    now() as new_sent_at
  INTO v_order_record
  FROM public.orders o
  WHERE o.id = p_order_id;

  -- Verificar que el pedido existe
  IF v_order_record.id IS NULL THEN
    RAISE EXCEPTION 'El pedido no existe';
  END IF;

  -- Verificar que el pedido está cerrado
  IF v_order_record.status != 'closed' THEN
    RAISE EXCEPTION 'El pedido debe estar cerrado antes de marcarlo como enviado';
  END IF;

  -- Guardar el instante real (UTC); la fecha en Buenos Aires se obtiene al filtrar/mostrar.
  v_sent_at := now();

  -- Actualizar el estado del pedido a 'sent' (terminado/enviado) y establecer sent_at
  UPDATE public.orders
  SET status = 'sent',
      sent_at = v_sent_at,
      updated_at = now()
  WHERE id = p_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No se pudo marcar el pedido como terminado';
  END IF;

  -- ============================================
  -- INSERTAR DIRECTAMENTE EN daily_sales
  -- ============================================
  
  -- Obtener nombre del cliente
  IF v_order_record.customer_id IS NOT NULL THEN
    BEGIN
      SELECT COALESCE(full_name, 'Cliente sin nombre')
      INTO v_customer_name
      FROM public.customers
      WHERE id = v_order_record.customer_id;
    EXCEPTION WHEN OTHERS THEN
      v_customer_name := 'Cliente sin nombre';
    END;
  ELSE
    v_customer_name := 'Cliente sin nombre';
  END IF;
  
  -- Extraer hora de sent_at convertida a hora Argentina
  v_sale_time := ((v_sent_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::time);
  
  -- Calcular cantidad de items y monto total
  -- IMPORTANTE: Usar total_amount del pedido directamente porque ya incluye extras (shipping, discount, extras)
  BEGIN
    SELECT 
      COUNT(*)
    INTO v_total_items
    FROM public.order_items
    WHERE order_id = p_order_id
      AND status != 'cancelled';
    
    -- Usar total_amount del pedido directamente (ya incluye todos los extras)
    v_total_amount := COALESCE(v_order_record.total_amount, 0);
    
    -- Si no hay items, usar mínimo 1 para que aparezca
    IF v_total_items = 0 THEN
      v_total_items := 1;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Si hay error, usar valores del pedido
    v_total_items := 1;
    v_total_amount := COALESCE(v_order_record.total_amount, 0);
  END;
  
  -- Verificar que no exista ya un registro para este envío
  -- IMPORTANTE: No comparar el monto porque puede variar (con/sin extras)
  -- Usamos fecha, hora, cliente y cantidad para detectar duplicados
  -- Si existe un duplicado, lo eliminamos primero para insertar el correcto
  -- Convertir sent_at a hora Argentina antes de extraer la fecha
  DELETE FROM public.daily_sales
  WHERE sale_date = (v_sent_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
    AND sale_type = 'envios'
    AND sale_time = v_sale_time
    AND customer_name = v_customer_name
    AND product_quantity = v_total_items;
  
  -- Ahora insertar el registro correcto (con el monto que incluye extras)
  IF NOT EXISTS (
    SELECT 1 FROM public.daily_sales
    WHERE sale_date = (v_sent_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
      AND sale_type = 'envios'
      AND sale_time = v_sale_time
      AND customer_name = v_customer_name
      AND product_quantity = v_total_items
  ) THEN
    -- Insertar en daily_sales
    INSERT INTO public.daily_sales (
      sale_date,
      sale_type,
      sale_time,
      customer_name,
      product_quantity,
      sale_amount,
      created_by
    ) VALUES (
      (v_sent_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date,
      'envios',
      v_sale_time,
      v_customer_name,
      v_total_items,
      v_total_amount,
      NULL  -- NULL porque estamos en una función SECURITY DEFINER
    );
    
    RAISE NOTICE '✅ Pedido marcado como enviado y registrado en daily_sales: Fecha=%, Hora=%, Cliente=%, Monto=%', 
      v_sent_at::date, v_sale_time, v_customer_name, v_total_amount;
  ELSE
    RAISE NOTICE '⚠️ Ya existe un registro similar en daily_sales para este pedido';
  END IF;

END;
$$;

