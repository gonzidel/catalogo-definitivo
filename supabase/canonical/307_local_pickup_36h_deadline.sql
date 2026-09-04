-- 307_local_pickup_36h_deadline.sql
--
-- Clientes de Resistencia, Barranqueras, Puerto Vilelas y Fontana (Chaco)
-- tienen 36 horas para retirar/armar el pedido (dismantle_at), en lugar de
-- 7 dias habiles. Carrito y Mi pedido siguen iguales al resto del pais.
--
-- expires_at (closing_soon): 24h desde creacion (aviso en las ultimas 12h).

CREATE OR REPLACE FUNCTION public.fn_is_local_pickup_short_deadline_zone(
  p_province text,
  p_city text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_prov text;
  v_city text;
BEGIN
  v_prov := lower(trim(coalesce(p_province, '')));
  v_city := lower(trim(coalesce(p_city, '')));
  v_city := translate(v_city, 'áéíóúüñ', 'aeiouun');
  RETURN v_prov = 'chaco'
    AND v_city IN (
      'resistencia',
      'barranqueras',
      'puerto vilela',
      'puerto vilelas',
      'fontana',
      'fortana'
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_order_deadlines_for_customer(
  p_customer_id uuid,
  p_anchor timestamptz DEFAULT now()
)
RETURNS TABLE(expires_at timestamptz, dismantle_at timestamptz)
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_province text;
  v_city text;
  v_dismantle timestamptz;
  v_expires timestamptz;
BEGIN
  SELECT c.province, c.city
  INTO v_province, v_city
  FROM public.customers c
  WHERE c.id = p_customer_id;

  IF public.fn_is_local_pickup_short_deadline_zone(v_province, v_city) THEN
    v_dismantle := p_anchor + interval '36 hours';
    v_expires := p_anchor + interval '24 hours';
  ELSE
    v_dismantle := public.fn_compute_order_deadline(p_anchor, 7);
    v_expires := v_dismantle - interval '2 days';
  END IF;

  RETURN QUERY SELECT v_expires, v_dismantle;
END;
$$;

GRANT EXECUTE ON FUNCTION public.fn_is_local_pickup_short_deadline_zone(text, text) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.fn_order_deadlines_for_customer(uuid, timestamptz) TO authenticated, anon;


CREATE OR REPLACE FUNCTION public.rpc_checkout_cart()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
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
  v_order_created_at timestamptz;
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

  SELECT id, expires_at, dismantle_at, created_at
  INTO v_order_id, v_expires_at, v_dismantle_at, v_order_created_at
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

    SELECT d.expires_at, d.dismantle_at
    INTO v_expires_at, v_dismantle_at
    FROM public.fn_order_deadlines_for_customer(auth.uid(), now()) d;

    BEGIN
      INSERT INTO public.orders (customer_id, status, expires_at, dismantle_at)
      VALUES (
        auth.uid(),
        'active',
        v_expires_at,
        v_dismantle_at
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
      SELECT
        coalesce(v_expires_at, d.expires_at),
        coalesce(v_dismantle_at, d.dismantle_at)
      INTO v_expires_at, v_dismantle_at
      FROM public.fn_order_deadlines_for_customer(auth.uid(), coalesce(v_order_created_at, now())) d;
      UPDATE public.orders
      SET
        expires_at = v_expires_at,
        dismantle_at = v_dismantle_at
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

CREATE OR REPLACE FUNCTION public.rpc_orders_daily_maintenance()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_general_warehouse_id uuid;
  v_venta_warehouse_id uuid;
  v_legacy_fallback_count int := 0;
  v_expiring_order_ids uuid[];
BEGIN
  -- D.1 Backfill fechas (zona retiro local: 36h; resto: 7d habiles 17:00 AR)
  UPDATE public.orders o
  SET
    dismantle_at = coalesce(
      o.dismantle_at,
      (SELECT d.dismantle_at FROM public.fn_order_deadlines_for_customer(o.customer_id, o.created_at) d)
    ),
    expires_at = coalesce(
      o.expires_at,
      (SELECT d.expires_at FROM public.fn_order_deadlines_for_customer(o.customer_id, o.created_at) d)
    )
  WHERE o.status IN ('active','closing_soon')
    AND (o.expires_at IS NULL OR o.dismantle_at IS NULL);

  -- D.2 Pasar a closing_soon (identico a 257/260/265)
  UPDATE public.orders
  SET status = 'closing_soon'
  WHERE status = 'active'
    AND now() >= expires_at
    AND now() < dismantle_at;

  -- D.3 Expirar / desarmar (devolver por source respetando talle + deposito; fallback legacy sin source)
  SELECT id INTO v_general_warehouse_id FROM public.warehouses WHERE code = 'general' LIMIT 1;
  SELECT id INTO v_venta_warehouse_id FROM public.warehouses WHERE code = 'venta-publico' LIMIT 1;

  SELECT coalesce(array_agg(o.id), '{}'::uuid[])
  INTO v_expiring_order_ids
  FROM public.orders o
  WHERE o.status IN ('active','closing_soon')
    AND now() >= o.dismantle_at;

  PERFORM 1
  FROM public.order_items oi
  WHERE oi.order_id = ANY(v_expiring_order_ids)
    AND oi.status IN ('reserved','picked','waiting','missing')
  FOR UPDATE OF oi;

  PERFORM 1
  FROM public.product_variants pv
  WHERE pv.id IN (
    SELECT DISTINCT oi.variant_id
    FROM public.order_items oi
    WHERE oi.order_id = ANY(v_expiring_order_ids)
      AND oi.status IN ('reserved','picked','waiting','missing')
      AND oi.variant_id IS NOT NULL
  )
  ORDER BY pv.id
  FOR UPDATE;

  INSERT INTO public.variant_size_warehouse_stock (variant_id, warehouse_id, size, stock_qty, updated_at)
  SELECT x.variant_id, x.warehouse_id, x.size_normalized, SUM(x.qty)::int, now()
  FROM (
    SELECT
      oi.variant_id,
      s.warehouse_id,
      CASE
        WHEN trim(coalesce(oi.size::text, '')) ~ '^\d+(\.\d+)?$' THEN split_part(trim(coalesce(oi.size::text, '')), '.', 1)
        ELSE trim(coalesce(oi.size::text, ''))
      END AS size_normalized,
      greatest(coalesce(s.qty, 0), 0)::int AS qty
    FROM public.order_items oi
    JOIN public.order_item_stock_sources s ON s.order_item_id = oi.id
    WHERE oi.order_id = ANY(v_expiring_order_ids)
      AND oi.status IN ('reserved','picked','waiting','missing')
      AND oi.variant_id IS NOT NULL
      AND greatest(coalesce(s.qty, 0), 0) > 0
  ) x
  WHERE x.size_normalized <> ''
  GROUP BY x.variant_id, x.warehouse_id, x.size_normalized
  ON CONFLICT (variant_id, warehouse_id, size) DO UPDATE
  SET stock_qty = public.variant_size_warehouse_stock.stock_qty + excluded.stock_qty,
      updated_at = now();

  INSERT INTO public.variant_warehouse_stock (variant_id, warehouse_id, stock_qty, updated_at)
  SELECT x.variant_id, x.warehouse_id, SUM(x.qty)::int, now()
  FROM (
    SELECT
      oi.variant_id,
      s.warehouse_id,
      CASE
        WHEN trim(coalesce(oi.size::text, '')) ~ '^\d+(\.\d+)?$' THEN split_part(trim(coalesce(oi.size::text, '')), '.', 1)
        ELSE trim(coalesce(oi.size::text, ''))
      END AS size_normalized,
      (
        exists (
          select 1
          from public.variant_size_warehouse_stock vsws
          where vsws.variant_id = oi.variant_id
          limit 1
        )
        or exists (
          select 1
          from public.variant_sizes vs
          where vs.variant_id = oi.variant_id
            and trim(coalesce(vs.size, '')) <> ''
          limit 1
        )
      ) AS has_size_model,
      greatest(coalesce(s.qty, 0), 0)::int AS qty
    FROM public.order_items oi
    JOIN public.order_item_stock_sources s ON s.order_item_id = oi.id
    WHERE oi.order_id = ANY(v_expiring_order_ids)
      AND oi.status IN ('reserved','picked','waiting','missing')
      AND oi.variant_id IS NOT NULL
      AND greatest(coalesce(s.qty, 0), 0) > 0
  ) x
  WHERE x.size_normalized = ''
    AND x.has_size_model = false
  GROUP BY x.variant_id, x.warehouse_id
  ON CONFLICT (variant_id, warehouse_id) DO UPDATE
  SET stock_qty = public.variant_warehouse_stock.stock_qty + excluded.stock_qty,
      updated_at = now();

  INSERT INTO public.variant_size_warehouse_stock (variant_id, warehouse_id, size, stock_qty, updated_at)
  SELECT x.variant_id, x.warehouse_id, x.size_normalized, SUM(x.qty)::int, now()
  FROM (
    SELECT
      oi.variant_id,
      CASE
        WHEN oi.status = 'waiting' THEN v_venta_warehouse_id
        ELSE v_general_warehouse_id
      END AS warehouse_id,
      CASE
        WHEN trim(coalesce(oi.size::text, '')) ~ '^\d+(\.\d+)?$' THEN split_part(trim(coalesce(oi.size::text, '')), '.', 1)
        ELSE trim(coalesce(oi.size::text, ''))
      END AS size_normalized,
      greatest(coalesce(oi.quantity, 0), 0)::int AS qty
    FROM public.order_items oi
    WHERE oi.order_id = ANY(v_expiring_order_ids)
      AND oi.status IN ('reserved','waiting')
      AND oi.variant_id IS NOT NULL
      AND greatest(coalesce(oi.quantity, 0), 0) > 0
      AND NOT EXISTS (
        SELECT 1
        FROM public.order_item_stock_sources s
        WHERE s.order_item_id = oi.id
          AND greatest(coalesce(s.qty, 0), 0) > 0
      )
  ) x
  WHERE x.warehouse_id IS NOT NULL
    AND x.size_normalized <> ''
  GROUP BY x.variant_id, x.warehouse_id, x.size_normalized
  ON CONFLICT (variant_id, warehouse_id, size) DO UPDATE
  SET stock_qty = public.variant_size_warehouse_stock.stock_qty + excluded.stock_qty,
      updated_at = now();

  INSERT INTO public.variant_warehouse_stock (variant_id, warehouse_id, stock_qty, updated_at)
  SELECT x.variant_id, x.warehouse_id, SUM(x.qty)::int, now()
  FROM (
    SELECT
      oi.variant_id,
      CASE
        WHEN oi.status = 'waiting' THEN v_venta_warehouse_id
        ELSE v_general_warehouse_id
      END AS warehouse_id,
      CASE
        WHEN trim(coalesce(oi.size::text, '')) ~ '^\d+(\.\d+)?$' THEN split_part(trim(coalesce(oi.size::text, '')), '.', 1)
        ELSE trim(coalesce(oi.size::text, ''))
      END AS size_normalized,
      (
        exists (
          select 1
          from public.variant_size_warehouse_stock vsws
          where vsws.variant_id = oi.variant_id
          limit 1
        )
        or exists (
          select 1
          from public.variant_sizes vs
          where vs.variant_id = oi.variant_id
            and trim(coalesce(vs.size, '')) <> ''
          limit 1
        )
      ) AS has_size_model,
      greatest(coalesce(oi.quantity, 0), 0)::int AS qty
    FROM public.order_items oi
    WHERE oi.order_id = ANY(v_expiring_order_ids)
      AND oi.status IN ('reserved','waiting')
      AND oi.variant_id IS NOT NULL
      AND greatest(coalesce(oi.quantity, 0), 0) > 0
      AND NOT EXISTS (
        SELECT 1
        FROM public.order_item_stock_sources s
        WHERE s.order_item_id = oi.id
          AND greatest(coalesce(s.qty, 0), 0) > 0
      )
  ) x
  WHERE x.warehouse_id IS NOT NULL
    AND x.size_normalized = ''
    AND x.has_size_model = false
  GROUP BY x.variant_id, x.warehouse_id
  ON CONFLICT (variant_id, warehouse_id) DO UPDATE
  SET stock_qty = public.variant_warehouse_stock.stock_qty + excluded.stock_qty,
      updated_at = now();

  -- (Eliminado desde 260: el UPDATE product_variants SET reserved_qty =
  -- reserved_qty + agg.sum_qty que sumaba mal. La liberacion de reserved_qty
  -- para estos pedidos la hace exclusivamente el trigger 188 mas abajo,
  -- al marcar orders.status = 'expired' con las fuentes todavia pobladas.)

  SELECT count(*)::int
  INTO v_legacy_fallback_count
  FROM public.order_items oi
  WHERE oi.order_id = ANY(v_expiring_order_ids)
    AND oi.status IN ('reserved','waiting')
    AND oi.variant_id IS NOT NULL
    AND greatest(coalesce(oi.quantity, 0), 0) > 0
    AND NOT EXISTS (
      SELECT 1
      FROM public.order_item_stock_sources s
      WHERE s.order_item_id = oi.id
        AND greatest(coalesce(s.qty, 0), 0) > 0
    );

  IF coalesce(v_legacy_fallback_count, 0) > 0 THEN
    RAISE WARNING 'rpc_orders_daily_maintenance: fallback legacy sin sources aplicado en % item(s).', v_legacy_fallback_count;
  END IF;

  -- Orden clave del fix de 260 (sin cambios aqui): primero se marcan los
  -- items y el pedido como 'expired' (esto dispara el trigger 188 con
  -- order_item_stock_sources TODAVIA con qty > 0, permitiendole liberar
  -- reserved_qty correctamente); recien despues se borran esas fuentes.
  UPDATE public.order_items oi
  SET status = 'expired'
  WHERE oi.order_id = ANY(v_expiring_order_ids)
    AND oi.status IN ('reserved','picked','waiting','missing');

  UPDATE public.orders
  SET status = 'expired', expired_at = now()
  WHERE id = ANY(v_expiring_order_ids);

  -- FIX 266: se agrega "AND oi.status = 'expired'" -- antes este DELETE
  -- borraba las fuentes de TODOS los items del pedido (incluyendo items que
  -- ya eran 'cancelled' ANTES de esta corrida, con stock todavia pendiente
  -- de que el admin lo confirme con el boton check). Ahora solo se limpian
  -- las fuentes de los items que la funcion ACABA de marcar 'expired' arriba
  -- (los unicos para los que ya se termino de procesar la devolucion).
  DELETE FROM public.order_item_stock_sources s
  WHERE EXISTS (
    SELECT 1
    FROM public.order_items oi
    WHERE oi.id = s.order_item_id
      AND oi.order_id = ANY(v_expiring_order_ids)
      AND oi.status = 'expired'
  );

  -- D.4 Notificaciones (outbox) idempotentes -- identico a 257/260/265
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
