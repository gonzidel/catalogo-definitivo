-- 123_order_expiry_and_notifications.sql
-- Vencimiento real (7d closing_soon, 14d expired), outbox idempotente, tracking stock sources.
-- Stock al expirar se devuelve solo a warehouse GENERAL; solo se devuelve para ítems con order_item_stock_sources.

-- =============================================================================
-- A.1 Columnas en orders
-- =============================================================================
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS dismantle_at timestamptz,
  ADD COLUMN IF NOT EXISTS expired_at timestamptz;

-- A.2 Estados (normalizar legacy y luego CHECK)
-- =============================================================================
-- Importante: respetar estado especial 'devolución' (trigger prevent_devolucion_status_change)
UPDATE public.orders
SET status = 'closed'
WHERE status IS NULL
   OR status NOT IN ('active','closing_soon','closed','sent','expired','devolución');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'orders_status_check'
      AND conrelid = 'public.orders'::regclass
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_status_check
      CHECK (status IN ('active','closing_soon','closed','sent','expired','devolución'));
  END IF;
END $$;

-- order_items.status: permitir 'expired' (TEXT sin CHECK en 10_checkout_flow; no hace falta alter)

-- =============================================================================
-- A.3 Tabla order_notifications (outbox)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.order_notifications (
  id bigserial primary key,
  order_id uuid not null references public.orders(id) on delete cascade,
  customer_id uuid not null references public.customers(id),
  type text not null,
  channel text not null default 'whatsapp',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  sent_at timestamptz null
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_order_notifications_order_id_type
  ON public.order_notifications (order_id, type);

CREATE INDEX IF NOT EXISTS idx_order_notifications_sent_at_pending
  ON public.order_notifications (sent_at) WHERE sent_at IS NULL;

-- =============================================================================
-- A.4 Tabla order_item_stock_sources (tracking exacto checkout)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.order_item_stock_sources (
  id bigserial primary key,
  order_item_id uuid not null references public.order_items(id) on delete cascade,
  warehouse_id uuid not null references public.warehouses(id),
  qty integer not null check (qty > 0),
  created_at timestamptz not null default now(),
  unique(order_item_id, warehouse_id)
);

-- =============================================================================
-- Backfill fechas para órdenes existentes (active/closing_soon, solo nulls)
-- =============================================================================
UPDATE public.orders
SET
  expires_at = coalesce(expires_at, created_at + interval '7 days'),
  dismantle_at = coalesce(dismantle_at, created_at + interval '14 days')
WHERE status IN ('active','closing_soon')
  AND (expires_at IS NULL OR dismantle_at IS NULL);

-- =============================================================================
-- B) rpc_checkout_cart: expires_at/dismantle_at + order_item_stock_sources
-- =============================================================================
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

    SELECT coalesce(stock_qty, 0) INTO v_general_stock
    FROM public.variant_warehouse_stock
    WHERE variant_id = r.variant_id AND warehouse_id = v_general_id;

    IF v_general_stock > 0 THEN
      IF v_general_stock >= v_qty THEN
        UPDATE public.variant_warehouse_stock
        SET stock_qty = stock_qty - v_qty, updated_at = now()
        WHERE variant_id = r.variant_id AND warehouse_id = v_general_id;
        v_remaining_qty := 0;
        v_qty_from_general := v_qty;
        v_qty_from_venta := 0;
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
      v_qty_from_general := 0;
      v_qty_from_venta := v_qty;
    END IF;

    IF v_remaining_qty > 0 THEN
      UPDATE public.variant_warehouse_stock
      SET stock_qty = stock_qty - v_remaining_qty, updated_at = now()
      WHERE variant_id = r.variant_id AND warehouse_id = v_venta_id;
    END IF;

    UPDATE public.product_variants
    SET reserved_qty = greatest(reserved_qty - v_qty, 0)
    WHERE id = r.variant_id;

    INSERT INTO public.order_items (order_id, variant_id, product_name, color, size, quantity, price_snapshot, imagen, status)
    VALUES (v_order_id, r.variant_id, r.product_name, r.color, r.size, v_qty, r.price_snapshot, r.imagen, 'reserved')
    RETURNING id INTO v_order_item_id;

    IF v_qty_from_general > 0 AND v_general_id IS NOT NULL THEN
      INSERT INTO public.order_item_stock_sources (order_item_id, warehouse_id, qty)
      VALUES (v_order_item_id, v_general_id, v_qty_from_general);
    END IF;
    IF v_qty_from_venta > 0 AND v_venta_id IS NOT NULL THEN
      INSERT INTO public.order_item_stock_sources (order_item_id, warehouse_id, qty)
      VALUES (v_order_item_id, v_venta_id, v_qty_from_venta);
    END IF;

    v_total := v_total + (coalesce(r.price_snapshot, 0) * v_qty);
  END LOOP;

  DELETE FROM public.cart_items WHERE cart_id = v_cart_id;

  UPDATE public.orders
  SET total_amount = coalesce(total_amount, 0) + coalesce(v_total, 0)
  WHERE id = v_order_id;

  SELECT order_number INTO v_order_number FROM public.orders WHERE id = v_order_id;

  RETURN json_build_object('order_id', v_order_id, 'order_number', coalesce(v_order_number, ''));
END;
$$;

-- =============================================================================
-- C) rpc_close_order: rechazar si expired o now() >= dismantle_at
-- =============================================================================
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

  SELECT id INTO v_general_warehouse_id FROM public.warehouses WHERE code = 'general' LIMIT 1;
  SELECT id INTO v_venta_publico_warehouse_id FROM public.warehouses WHERE code = 'venta-publico' LIMIT 1;

  FOR v_item IN
    SELECT oi.variant_id, oi.size, oi.quantity
    FROM public.order_items oi
    WHERE oi.order_id = p_order_id
      AND oi.status IN ('picked', 'waiting')
      AND oi.variant_id IS NOT NULL
  LOOP
    v_variant_id := v_item.variant_id;
    v_size := v_item.size;
    v_qty := v_item.quantity;

    IF v_size IS NOT NULL AND v_size != '' AND v_general_warehouse_id IS NOT NULL AND v_venta_publico_warehouse_id IS NOT NULL THEN
      SELECT
        COALESCE(SUM(CASE WHEN warehouse_id = v_general_warehouse_id THEN stock_qty ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN warehouse_id = v_venta_publico_warehouse_id THEN stock_qty ELSE 0 END), 0)
      INTO v_size_stock_general, v_size_stock_venta_publico
      FROM public.variant_size_warehouse_stock
      WHERE variant_id = v_variant_id AND size = v_size
        AND warehouse_id IN (v_general_warehouse_id, v_venta_publico_warehouse_id);

      IF v_size_stock_venta_publico >= v_qty THEN
        v_qty_venta_publico := v_qty; v_qty_general := 0;
      ELSIF (v_size_stock_venta_publico + v_size_stock_general) >= v_qty THEN
        v_qty_venta_publico := v_size_stock_venta_publico; v_qty_general := v_qty - v_size_stock_venta_publico;
      ELSE
        v_qty_venta_publico := v_size_stock_venta_publico; v_qty_general := v_size_stock_general;
      END IF;

      IF v_qty_venta_publico > 0 THEN
        UPDATE public.variant_size_warehouse_stock
        SET stock_qty = stock_qty - v_qty_venta_publico, updated_at = now()
        WHERE variant_id = v_variant_id AND size = v_size AND warehouse_id = v_venta_publico_warehouse_id;
      END IF;
      IF v_qty_general > 0 THEN
        UPDATE public.variant_size_warehouse_stock
        SET stock_qty = stock_qty - v_qty_general, updated_at = now()
        WHERE variant_id = v_variant_id AND size = v_size AND warehouse_id = v_general_warehouse_id;
      END IF;
    ELSE
      SELECT
        COALESCE(SUM(CASE WHEN warehouse_id = v_general_warehouse_id THEN stock_qty ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN warehouse_id = v_venta_publico_warehouse_id THEN stock_qty ELSE 0 END), 0)
      INTO v_size_stock_general, v_size_stock_venta_publico
      FROM public.variant_warehouse_stock
      WHERE variant_id = v_variant_id AND warehouse_id IN (v_general_warehouse_id, v_venta_publico_warehouse_id);

      IF v_size_stock_venta_publico >= v_qty THEN
        v_qty_venta_publico := v_qty; v_qty_general := 0;
      ELSIF (v_size_stock_venta_publico + v_size_stock_general) >= v_qty THEN
        v_qty_venta_publico := v_size_stock_venta_publico; v_qty_general := v_qty - v_size_stock_venta_publico;
      ELSE
        v_qty_venta_publico := v_size_stock_venta_publico; v_qty_general := v_size_stock_general;
      END IF;

      IF v_qty_venta_publico > 0 AND v_venta_publico_warehouse_id IS NOT NULL THEN
        UPDATE public.variant_warehouse_stock
        SET stock_qty = stock_qty - v_qty_venta_publico, updated_at = now()
        WHERE variant_id = v_variant_id AND warehouse_id = v_venta_publico_warehouse_id;
      END IF;
      IF v_qty_general > 0 AND v_general_warehouse_id IS NOT NULL THEN
        UPDATE public.variant_warehouse_stock
        SET stock_qty = stock_qty - v_qty_general, updated_at = now()
        WHERE variant_id = v_variant_id AND warehouse_id = v_general_warehouse_id;
      END IF;
    END IF;
  END LOOP;

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

-- =============================================================================
-- D) rpc_orders_daily_maintenance: backfill, closing_soon, expire, notifications
-- =============================================================================
CREATE OR REPLACE FUNCTION public.rpc_orders_daily_maintenance()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_general_warehouse_id uuid;
BEGIN
  -- D.1 Backfill fechas
  UPDATE public.orders
  SET
    expires_at = coalesce(expires_at, created_at + interval '7 days'),
    dismantle_at = coalesce(dismantle_at, created_at + interval '14 days')
  WHERE status IN ('active','closing_soon')
    AND (expires_at IS NULL OR dismantle_at IS NULL);

  -- D.2 Pasar a closing_soon
  UPDATE public.orders
  SET status = 'closing_soon'
  WHERE status = 'active'
    AND now() >= expires_at
    AND now() < dismantle_at;

  -- D.3 Expirar / desarmar (solo devolver stock para ítems con order_item_stock_sources; devolución solo a GENERAL)
  SELECT id INTO v_general_warehouse_id FROM public.warehouses WHERE code = 'general' LIMIT 1;

  IF v_general_warehouse_id IS NOT NULL THEN
    -- Sumar stock a GENERAL por variant_id desde items_to_return (items_to_expire JOIN sources)
    INSERT INTO public.variant_warehouse_stock (variant_id, warehouse_id, stock_qty, updated_at)
    SELECT agg.variant_id, v_general_warehouse_id, agg.sum_qty, now()
    FROM (
      SELECT oi.variant_id, SUM(s.qty)::int AS sum_qty
      FROM public.order_items oi
      JOIN public.order_item_stock_sources s ON s.order_item_id = oi.id
      JOIN public.orders o ON o.id = oi.order_id
      WHERE o.status IN ('active','closing_soon')
        AND now() >= o.dismantle_at
        AND oi.status IN ('reserved','picked','waiting','missing')
      GROUP BY oi.variant_id
    ) agg
    ON CONFLICT (variant_id, warehouse_id) DO UPDATE
    SET stock_qty = public.variant_warehouse_stock.stock_qty + excluded.stock_qty,
        updated_at = now();

    -- Revertir reserved_qty (incrementar lo que el checkout decrementó)
    UPDATE public.product_variants pv
    SET reserved_qty = pv.reserved_qty + agg.sum_qty
    FROM (
      SELECT oi.variant_id, SUM(s.qty)::int AS sum_qty
      FROM public.order_items oi
      JOIN public.order_item_stock_sources s ON s.order_item_id = oi.id
      JOIN public.orders o ON o.id = oi.order_id
      WHERE o.status IN ('active','closing_soon')
        AND now() >= o.dismantle_at
        AND oi.status IN ('reserved','picked','waiting','missing')
      GROUP BY oi.variant_id
    ) agg
    WHERE pv.id = agg.variant_id;
  END IF;

  -- Marcar TODOS los items_to_expire como expired (tengan o no sources)
  UPDATE public.order_items oi
  SET status = 'expired'
  FROM public.orders o
  WHERE o.id = oi.order_id
    AND o.status IN ('active','closing_soon')
    AND now() >= o.dismantle_at
    AND oi.status IN ('reserved','picked','waiting','missing');

  -- Marcar órdenes como expired
  UPDATE public.orders
  SET status = 'expired', expired_at = now()
  WHERE status IN ('active','closing_soon')
    AND now() >= dismantle_at;

  -- D.4 Notificaciones (outbox) idempotentes
  INSERT INTO public.order_notifications (order_id, customer_id, type, payload)
  SELECT o.id, o.customer_id, 'DAY_4', jsonb_build_object(
    'order_id', o.id, 'order_number', coalesce(o.order_number,''),
    'days_elapsed', floor(extract(epoch from (now() - o.created_at))/86400)::int,
    'picked_waiting', (SELECT count(*)::int FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status IN ('picked','waiting')),
    'missing_to_min', greatest(0, 4 - (SELECT count(*) FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status IN ('picked','waiting'))),
    'expires_at', o.expires_at, 'dismantle_at', o.dismantle_at
  )
  FROM public.orders o
  WHERE o.status IN ('active','closing_soon')
    AND floor(extract(epoch from (now() - o.created_at))/86400) >= 4
  ON CONFLICT (order_id, type) DO NOTHING;

  INSERT INTO public.order_notifications (order_id, customer_id, type, payload)
  SELECT o.id, o.customer_id, 'DAY_6', jsonb_build_object(
    'order_id', o.id, 'order_number', coalesce(o.order_number,''),
    'days_elapsed', floor(extract(epoch from (now() - o.created_at))/86400)::int,
    'picked_waiting', (SELECT count(*)::int FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status IN ('picked','waiting')),
    'missing_to_min', greatest(0, 4 - (SELECT count(*) FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status IN ('picked','waiting'))),
    'expires_at', o.expires_at, 'dismantle_at', o.dismantle_at
  )
  FROM public.orders o
  WHERE o.status IN ('active','closing_soon')
    AND floor(extract(epoch from (now() - o.created_at))/86400) >= 6
  ON CONFLICT (order_id, type) DO NOTHING;

  INSERT INTO public.order_notifications (order_id, customer_id, type, payload)
  SELECT o.id, o.customer_id, 'DAY_7', jsonb_build_object(
    'order_id', o.id, 'order_number', coalesce(o.order_number,''),
    'days_elapsed', floor(extract(epoch from (now() - o.created_at))/86400)::int,
    'picked_waiting', (SELECT count(*)::int FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status IN ('picked','waiting')),
    'missing_to_min', greatest(0, 4 - (SELECT count(*) FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status IN ('picked','waiting'))),
    'expires_at', o.expires_at, 'dismantle_at', o.dismantle_at
  )
  FROM public.orders o
  WHERE o.status IN ('active','closing_soon')
    AND floor(extract(epoch from (now() - o.created_at))/86400) >= 7
  ON CONFLICT (order_id, type) DO NOTHING;

  INSERT INTO public.order_notifications (order_id, customer_id, type, payload)
  SELECT o.id, o.customer_id, 'DAY_11', jsonb_build_object(
    'order_id', o.id, 'order_number', coalesce(o.order_number,''),
    'days_elapsed', floor(extract(epoch from (now() - o.created_at))/86400)::int,
    'picked_waiting', (SELECT count(*)::int FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status IN ('picked','waiting')),
    'missing_to_min', greatest(0, 4 - (SELECT count(*) FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status IN ('picked','waiting'))),
    'expires_at', o.expires_at, 'dismantle_at', o.dismantle_at
  )
  FROM public.orders o
  WHERE o.status IN ('active','closing_soon')
    AND floor(extract(epoch from (now() - o.created_at))/86400) >= 11
  ON CONFLICT (order_id, type) DO NOTHING;

  INSERT INTO public.order_notifications (order_id, customer_id, type, payload)
  SELECT o.id, o.customer_id, 'DAY_13', jsonb_build_object(
    'order_id', o.id, 'order_number', coalesce(o.order_number,''),
    'days_elapsed', floor(extract(epoch from (now() - o.created_at))/86400)::int,
    'picked_waiting', (SELECT count(*)::int FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status IN ('picked','waiting')),
    'missing_to_min', greatest(0, 4 - (SELECT count(*) FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status IN ('picked','waiting'))),
    'expires_at', o.expires_at, 'dismantle_at', o.dismantle_at
  )
  FROM public.orders o
  WHERE o.status IN ('active','closing_soon')
    AND floor(extract(epoch from (now() - o.created_at))/86400) >= 13
  ON CONFLICT (order_id, type) DO NOTHING;

  INSERT INTO public.order_notifications (order_id, customer_id, type, payload)
  SELECT o.id, o.customer_id, 'MIN_REACHED', jsonb_build_object(
    'order_id', o.id, 'order_number', coalesce(o.order_number,''),
    'days_elapsed', floor(extract(epoch from (now() - o.created_at))/86400)::int,
    'picked_waiting', cnt.c,
    'missing_to_min', 0,
    'expires_at', o.expires_at, 'dismantle_at', o.dismantle_at
  )
  FROM public.orders o
  CROSS JOIN LATERAL (SELECT count(*)::int AS c FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status IN ('picked','waiting')) cnt
  WHERE o.status IN ('active','closing_soon') AND cnt.c >= 4
  ON CONFLICT (order_id, type) DO NOTHING;

  INSERT INTO public.order_notifications (order_id, customer_id, type, payload)
  SELECT o.id, o.customer_id, 'MIN_MISSING', jsonb_build_object(
    'order_id', o.id, 'order_number', coalesce(o.order_number,''),
    'days_elapsed', floor(extract(epoch from (now() - o.created_at))/86400)::int,
    'picked_waiting', cnt.c,
    'missing_to_min', greatest(0, 4 - cnt.c),
    'expires_at', o.expires_at, 'dismantle_at', o.dismantle_at
  )
  FROM public.orders o
  CROSS JOIN LATERAL (SELECT count(*)::int AS c FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status IN ('picked','waiting')) cnt
  WHERE o.status IN ('active','closing_soon') AND cnt.c < 4
  ON CONFLICT (order_id, type) DO NOTHING;

  -- EXPIRED: para órdenes que acaban de quedar expired (ya actualizadas arriba)
  INSERT INTO public.order_notifications (order_id, customer_id, type, payload)
  SELECT o.id, o.customer_id, 'EXPIRED', jsonb_build_object(
    'order_id', o.id, 'order_number', coalesce(o.order_number,''),
    'days_elapsed', floor(extract(epoch from (o.expired_at - o.created_at))/86400)::int,
    'picked_waiting', (SELECT count(*)::int FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status IN ('picked','waiting')),
    'missing_to_min', 0,
    'expires_at', o.expires_at, 'dismantle_at', o.dismantle_at
  )
  FROM public.orders o
  WHERE o.status = 'expired' AND o.expired_at >= now() - interval '1 minute'
  ON CONFLICT (order_id, type) DO NOTHING;
END;
$$;

SELECT pg_notify('pgrst','reload schema');

-- =============================================================================
-- E) PRUEBAS (ejecutar manualmente; comentarios de referencia)
-- =============================================================================
/*
-- 1) closing_soon: order con created_at 8 días atrás
UPDATE public.orders SET expires_at = now() - interval '1 day', dismantle_at = now() + interval '6 days'
WHERE id = '<order_id>' AND status = 'active';
SELECT public.rpc_orders_daily_maintenance();
SELECT id, status, expires_at, dismantle_at FROM public.orders WHERE id = '<order_id>';
-- Esperado: status = 'closing_soon'

-- 2) expired: order con dismantle_at en el pasado e ítems con sources
UPDATE public.orders SET status = 'active', dismantle_at = now() - interval '1 hour', expires_at = now() - interval '8 days'
WHERE id = '<order_id>';
-- (Asegurar que los order_items tengan filas en order_item_stock_sources vía checkout)
SELECT stock_qty FROM public.variant_warehouse_stock WHERE variant_id = '<variant_id>' AND warehouse_id = (SELECT id FROM public.warehouses WHERE code = 'general');
SELECT public.rpc_orders_daily_maintenance();
SELECT id, status, expired_at FROM public.orders WHERE id = '<order_id>';
SELECT status FROM public.order_items WHERE order_id = '<order_id>';
SELECT stock_qty FROM public.variant_warehouse_stock WHERE variant_id = '<variant_id>' AND warehouse_id = (SELECT id FROM public.warehouses WHERE code = 'general');
-- Esperado: order/items expired; stock general aumentado

-- 3) Idempotencia: correr maintenance 2 veces
SELECT public.rpc_orders_daily_maintenance();
SELECT public.rpc_orders_daily_maintenance();
SELECT count(*) FROM public.order_notifications WHERE order_id = '<order_id>' AND type = 'DAY_7';
-- Esperado: 1 fila (no duplicar)

-- 4) close_order rechaza pedido vencido
SELECT public.rpc_close_order('<order_id_expired>');
-- Esperado: ERROR "Pedido vencido"
*/
