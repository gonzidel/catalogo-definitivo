-- 312_retiro_zona_espera_deferred_stock.sql
--
-- Retiro Zona (local_deferred_pickup): permitir «espera» (Fábrica/Depósito) desde
-- awaiting_apartado sin descontar stock. Al confirmar ✓ en columna Espera, se
-- descuenta del depósito elegido y pasa a Apartados.
--
-- Retiro común: sin cambios (stock ya descontado en checkout, igual que Pedidos).

-- ---------------------------------------------------------------------------
-- 1) Columna deferred_stock_pending
-- ---------------------------------------------------------------------------
ALTER TABLE public.order_items
  ADD COLUMN IF NOT EXISTS deferred_stock_pending boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.order_items.deferred_stock_pending IS
  'Zona retiro diferido (309): true mientras el stock físico aún no se comprometió. '
  'Marcar espera desde awaiting_apartado deja phantom sources; commit al apartar/confirmar en Espera.';

-- Backfill ítems awaiting_apartado en pedidos deferred
UPDATE public.order_items oi
SET deferred_stock_pending = true
FROM public.orders o
WHERE oi.order_id = o.id
  AND coalesce(o.local_deferred_pickup, false) = true
  AND lower(trim(coalesce(oi.status, ''))) = 'awaiting_apartado'
  AND coalesce(oi.deferred_stock_pending, false) = false;

-- Nuevos ítems awaiting_apartado en checkout deferred
CREATE OR REPLACE FUNCTION public.fn_order_items_set_deferred_pending()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF lower(trim(coalesce(NEW.status, ''))) = 'awaiting_apartado'
     AND coalesce(NEW.deferred_stock_pending, false) = false
     AND NEW.order_id IS NOT NULL
  THEN
    IF EXISTS (
      SELECT 1
      FROM public.orders o
      WHERE o.id = NEW.order_id
        AND coalesce(o.local_deferred_pickup, false) = true
    ) THEN
      NEW.deferred_stock_pending := true;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_order_items_deferred_pending ON public.order_items;
CREATE TRIGGER trg_order_items_deferred_pending
  BEFORE INSERT ON public.order_items
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_order_items_set_deferred_pending();

-- ---------------------------------------------------------------------------
-- 2) fn_commit_deferred_order_item_stock — awaiting_apartado auto-split + waiting por depósito elegido
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_commit_deferred_order_item_stock(p_order_item_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_item record;
  v_general_id uuid;
  v_venta_id uuid;
  v_preferred_wh uuid;
  v_qty int;
  v_status text;
  v_general_stock int;
  v_remaining_qty int;
  v_qty_from_general int;
  v_qty_from_venta int;
  v_size_stock_general int;
  v_size_stock_venta int;
  v_wh_stock int;
  v_size_normalized text;
  v_use_size_table boolean;
  v_size_row record;
BEGIN
  SELECT
    oi.id,
    oi.order_id,
    oi.variant_id,
    oi.size,
    oi.quantity,
    oi.status,
    oi.deferred_stock_pending,
    o.local_deferred_pickup
  INTO v_item
  FROM public.order_items oi
  JOIN public.orders o ON o.id = oi.order_id
  WHERE oi.id = p_order_item_id
  FOR UPDATE OF oi;

  IF v_item.id IS NULL THEN
    RAISE EXCEPTION 'Ítem no encontrado';
  END IF;

  IF NOT coalesce(v_item.local_deferred_pickup, false) THEN
    RETURN;
  END IF;

  IF NOT coalesce(v_item.deferred_stock_pending, false) THEN
    RETURN;
  END IF;

  v_status := lower(trim(coalesce(v_item.status, '')));
  IF v_status NOT IN ('awaiting_apartado', 'waiting') THEN
    RETURN;
  END IF;

  v_qty := coalesce(v_item.quantity, 0);
  IF v_qty <= 0 OR v_item.variant_id IS NULL THEN
    RAISE EXCEPTION 'Ítem inválido para apartado';
  END IF;

  SELECT id INTO v_general_id FROM public.warehouses WHERE code = 'general' LIMIT 1;
  SELECT id INTO v_venta_id FROM public.warehouses WHERE code = 'venta-publico' LIMIT 1;

  v_size_normalized := trim(coalesce(v_item.size::text, ''));
  IF v_size_normalized ~ '^\d+(\.\d+)?$' THEN
    v_size_normalized := split_part(v_size_normalized, '.', 1);
  END IF;

  -- Espera diferida: descontar SOLO del depósito preferido (phantom source)
  IF v_status = 'waiting' THEN
    SELECT s.warehouse_id
    INTO v_preferred_wh
    FROM public.order_item_stock_sources s
    WHERE s.order_item_id = p_order_item_id
      AND greatest(coalesce(s.qty, 0), 0) > 0
    ORDER BY s.warehouse_id
    LIMIT 1;

    IF v_preferred_wh IS NULL THEN
      RAISE EXCEPTION 'Ítem en espera diferido sin depósito asignado';
    END IF;

    IF v_size_normalized <> '' THEN
      INSERT INTO public.variant_size_warehouse_stock (variant_id, warehouse_id, size, stock_qty)
      VALUES (v_item.variant_id, v_preferred_wh, v_size_normalized, 0)
      ON CONFLICT (variant_id, warehouse_id, size) DO NOTHING;

      SELECT coalesce(stock_qty, 0)
      INTO v_wh_stock
      FROM public.variant_size_warehouse_stock
      WHERE variant_id = v_item.variant_id
        AND warehouse_id = v_preferred_wh
        AND trim(coalesce(size, '')) = v_size_normalized
      FOR UPDATE;

      IF coalesce(v_wh_stock, 0) < v_qty THEN
        RAISE EXCEPTION 'Stock insuficiente en el depósito seleccionado para confirmar este ítem';
      END IF;

      UPDATE public.variant_size_warehouse_stock
      SET stock_qty = stock_qty - v_qty, updated_at = now()
      WHERE variant_id = v_item.variant_id
        AND warehouse_id = v_preferred_wh
        AND trim(coalesce(size, '')) = v_size_normalized;
    ELSE
      SELECT coalesce(stock_qty, 0)
      INTO v_wh_stock
      FROM public.variant_warehouse_stock
      WHERE variant_id = v_item.variant_id
        AND warehouse_id = v_preferred_wh
      FOR UPDATE;

      IF coalesce(v_wh_stock, 0) < v_qty THEN
        RAISE EXCEPTION 'Stock insuficiente en el depósito seleccionado para confirmar este ítem';
      END IF;

      UPDATE public.variant_warehouse_stock
      SET stock_qty = stock_qty - v_qty, updated_at = now()
      WHERE variant_id = v_item.variant_id
        AND warehouse_id = v_preferred_wh;
    END IF;

    UPDATE public.product_variants
    SET reserved_qty = greatest(reserved_qty - v_qty, 0)
    WHERE id = v_item.variant_id;

    UPDATE public.order_items
    SET deferred_stock_pending = false, updated_at = now()
    WHERE id = p_order_item_id;

    RETURN;
  END IF;

  -- awaiting_apartado: auto-split general → venta-publico (Apartar directo)
  IF NOT public.fn_order_item_physical_stock_available(v_item.variant_id, v_item.size, v_qty) THEN
    RAISE EXCEPTION 'Stock insuficiente para apartar este ítem';
  END IF;

  DELETE FROM public.order_item_stock_sources
  WHERE order_item_id = p_order_item_id;

  v_qty_from_general := 0;
  v_qty_from_venta := 0;
  v_remaining_qty := 0;
  v_use_size_table := false;

  IF v_size_normalized <> '' AND v_general_id IS NOT NULL AND v_venta_id IS NOT NULL THEN
    INSERT INTO public.variant_size_warehouse_stock (variant_id, warehouse_id, size, stock_qty)
    VALUES (v_item.variant_id, v_general_id, v_size_normalized, 0)
    ON CONFLICT (variant_id, warehouse_id, size) DO NOTHING;
    INSERT INTO public.variant_size_warehouse_stock (variant_id, warehouse_id, size, stock_qty)
    VALUES (v_item.variant_id, v_venta_id, v_size_normalized, 0)
    ON CONFLICT (variant_id, warehouse_id, size) DO NOTHING;

    v_size_stock_general := 0;
    v_size_stock_venta := 0;
    FOR v_size_row IN
      SELECT warehouse_id, stock_qty
      FROM public.variant_size_warehouse_stock
      WHERE variant_id = v_item.variant_id
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
      RAISE EXCEPTION 'Stock por talle insuficiente para apartar';
    END IF;

    v_use_size_table := true;
    v_general_stock := coalesce(v_size_stock_general, 0);
    IF v_general_stock >= v_qty THEN
      v_qty_from_general := v_qty;
    ELSIF v_general_stock > 0 THEN
      v_qty_from_general := v_general_stock;
      v_qty_from_venta := v_qty - v_general_stock;
    ELSE
      v_qty_from_venta := v_qty;
    END IF;

    IF v_qty_from_general > 0 THEN
      UPDATE public.variant_size_warehouse_stock
      SET stock_qty = stock_qty - v_qty_from_general, updated_at = now()
      WHERE variant_id = v_item.variant_id
        AND trim(coalesce(size, '')) = v_size_normalized
        AND warehouse_id = v_general_id;
    END IF;
    IF v_qty_from_venta > 0 THEN
      UPDATE public.variant_size_warehouse_stock
      SET stock_qty = stock_qty - v_qty_from_venta, updated_at = now()
      WHERE variant_id = v_item.variant_id
        AND trim(coalesce(size, '')) = v_size_normalized
        AND warehouse_id = v_venta_id;
    END IF;
  END IF;

  IF NOT v_use_size_table AND v_size_normalized = '' THEN
    v_remaining_qty := v_qty;
    SELECT coalesce(stock_qty, 0) INTO v_general_stock
    FROM public.variant_warehouse_stock
    WHERE variant_id = v_item.variant_id AND warehouse_id = v_general_id
    FOR UPDATE;

    IF coalesce(v_general_stock, 0) > 0 THEN
      IF v_general_stock >= v_qty THEN
        UPDATE public.variant_warehouse_stock
        SET stock_qty = stock_qty - v_qty, updated_at = now()
        WHERE variant_id = v_item.variant_id AND warehouse_id = v_general_id;
        v_qty_from_general := v_qty;
        v_remaining_qty := 0;
      ELSE
        UPDATE public.variant_warehouse_stock
        SET stock_qty = 0, updated_at = now()
        WHERE variant_id = v_item.variant_id AND warehouse_id = v_general_id;
        v_qty_from_general := v_general_stock;
        v_remaining_qty := v_qty - v_general_stock;
        v_qty_from_venta := v_remaining_qty;
      END IF;
    ELSE
      v_remaining_qty := v_qty;
      v_qty_from_venta := v_qty;
    END IF;

    IF v_remaining_qty > 0 THEN
      UPDATE public.variant_warehouse_stock
      SET stock_qty = stock_qty - v_remaining_qty, updated_at = now()
      WHERE variant_id = v_item.variant_id AND warehouse_id = v_venta_id;
    END IF;
  END IF;

  UPDATE public.product_variants
  SET reserved_qty = greatest(reserved_qty - v_qty, 0)
  WHERE id = v_item.variant_id;

  IF v_qty_from_general > 0 AND v_general_id IS NOT NULL THEN
    INSERT INTO public.order_item_stock_sources (order_item_id, warehouse_id, qty)
    VALUES (p_order_item_id, v_general_id, v_qty_from_general);
  END IF;
  IF v_qty_from_venta > 0 AND v_venta_id IS NOT NULL THEN
    INSERT INTO public.order_item_stock_sources (order_item_id, warehouse_id, qty)
    VALUES (p_order_item_id, v_venta_id, v_qty_from_venta);
  END IF;

  UPDATE public.order_items
  SET deferred_stock_pending = false, updated_at = now()
  WHERE id = p_order_item_id;
END;
$$;

COMMENT ON FUNCTION public.fn_commit_deferred_order_item_stock(uuid) IS
  '312: commit stock diferido — awaiting_apartado auto-split; waiting descuenta del depósito elegido.';

-- ---------------------------------------------------------------------------
-- 3) rpc_mark_order_item_waiting_source — espera sin descontar en zona deferred
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.rpc_mark_order_item_waiting_source(uuid, text, uuid);

CREATE OR REPLACE FUNCTION public.rpc_mark_order_item_waiting_source(
  p_item_id uuid,
  p_source_code text,
  p_checked_by uuid
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_row record;
  v_order_id uuid;
  v_warehouse_id uuid;
  v_all_picked boolean;
  v_deferred_pending boolean;
  v_status text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Solo administradores pueden marcar ítems en espera';
  END IF;

  IF p_source_code NOT IN ('general', 'venta-publico') THEN
    RAISE EXCEPTION 'Código de depósito inválido: %', p_source_code;
  END IF;

  SELECT id INTO v_warehouse_id
  FROM public.warehouses
  WHERE code = p_source_code
  LIMIT 1;

  IF v_warehouse_id IS NULL THEN
    RAISE EXCEPTION 'Depósito no encontrado: %', p_source_code;
  END IF;

  SELECT
    oi.*,
    o.local_deferred_pickup
  INTO v_row
  FROM public.order_items oi
  JOIN public.orders o ON o.id = oi.order_id
  WHERE oi.id = p_item_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ítem no encontrado';
  END IF;

  v_order_id := v_row.order_id;
  v_status := lower(trim(coalesce(v_row.status, '')));

  IF v_status NOT IN ('reserved', 'awaiting_apartado', 'waiting') THEN
    RAISE EXCEPTION 'Estado inválido para marcar en espera: %', v_row.status;
  END IF;

  v_deferred_pending := coalesce(v_row.local_deferred_pickup, false)
    AND (
      v_status = 'awaiting_apartado'
      OR coalesce(v_row.deferred_stock_pending, false)
    );

  UPDATE public.order_items
  SET
    status = 'waiting',
    checked_by = p_checked_by,
    checked_at = now(),
    deferred_stock_pending = CASE WHEN v_deferred_pending THEN true ELSE deferred_stock_pending END,
    updated_at = now()
  WHERE id = p_item_id;

  DELETE FROM public.order_item_stock_sources
  WHERE order_item_id = p_item_id;

  IF coalesce(v_row.quantity, 0) > 0 THEN
    INSERT INTO public.order_item_stock_sources (order_item_id, warehouse_id, qty)
    VALUES (p_item_id, v_warehouse_id, v_row.quantity);
  END IF;

  SELECT public.has_all_items_picked(v_order_id) INTO v_all_picked;

  RETURN json_build_object(
    'order_id', v_order_id,
    'all_items_picked', v_all_picked,
    'source_code', p_source_code,
    'deferred_pending', v_deferred_pending
  );
END;
$$;

COMMENT ON FUNCTION public.rpc_mark_order_item_waiting_source(uuid, text, uuid) IS
  '312: marca waiting con depósito. Zona deferred: phantom source sin descontar stock hasta confirmar en Espera.';

REVOKE ALL ON FUNCTION public.rpc_mark_order_item_waiting_source(uuid, text, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.rpc_mark_order_item_waiting_source(uuid, text, uuid) TO authenticated;

-- 5) rpc_split_order_item_status — zona deferred desde awaiting_apartado
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.rpc_split_order_item_status(uuid, int, int, int, uuid);

CREATE OR REPLACE FUNCTION public.rpc_split_order_item_status(
  p_item_id uuid,
  p_n_picked int,
  p_n_waiting int,
  p_n_missing int,
  p_checked_by uuid
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.order_items%rowtype;
  v_order_id uuid;
  v_all_picked boolean;
  v_new_picked_id uuid;
  v_new_waiting_id uuid;
  v_new_missing_id uuid;
  v_has_sources boolean := false;
  v_source_total int := 0;
  v_total_remaining int := 0;
  v_last_seq int := 0;
  v_missing_alloc int := 0;
  v_target record;
  v_alloc_total int := 0;
  v_deferred_zone boolean := false;
  v_parent_pending boolean := false;
  v_parent_status text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Solo administradores pueden usar esta función';
  END IF;

  SELECT * INTO v_row FROM public.order_items WHERE id = p_item_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ítem no encontrado';
  END IF;

  IF p_n_picked < 0 OR p_n_waiting < 0 OR p_n_missing < 0 THEN
    RAISE EXCEPTION 'Las cantidades no pueden ser negativas';
  END IF;

  IF (coalesce(p_n_picked, 0) + coalesce(p_n_waiting, 0) + coalesce(p_n_missing, 0)) <> v_row.quantity THEN
    RAISE EXCEPTION
      'La suma de cantidades (apartado + espera + sin stock) debe ser igual a la cantidad del ítem (%); recibido: picked=%, waiting=%, missing=%',
      v_row.quantity, p_n_picked, p_n_waiting, p_n_missing;
  END IF;

  v_order_id := v_row.order_id;
  v_parent_status := lower(trim(coalesce(v_row.status, '')));

  SELECT coalesce(o.local_deferred_pickup, false)
  INTO v_deferred_zone
  FROM public.orders o
  WHERE o.id = v_order_id;

  v_parent_pending := coalesce(v_row.deferred_stock_pending, false)
    OR (v_deferred_zone AND v_parent_status = 'awaiting_apartado');

  IF coalesce(p_n_picked, 0) > 0 THEN
    IF v_parent_pending THEN
      INSERT INTO public.order_items (
        order_id, variant_id, product_name, color, size, quantity, price_snapshot, imagen,
        status, checked_by, checked_at, deferred_stock_pending
      ) VALUES (
        v_order_id, v_row.variant_id, v_row.product_name, v_row.color, v_row.size,
        p_n_picked, v_row.price_snapshot, v_row.imagen,
        'awaiting_apartado', p_checked_by, now(), true
      )
      RETURNING id INTO v_new_picked_id;

      PERFORM public.fn_commit_deferred_order_item_stock(v_new_picked_id);

      UPDATE public.order_items
      SET status = 'picked', updated_at = now()
      WHERE id = v_new_picked_id;
    ELSE
      INSERT INTO public.order_items (
        order_id, variant_id, product_name, color, size, quantity, price_snapshot, imagen,
        status, checked_by, checked_at
      ) VALUES (
        v_order_id, v_row.variant_id, v_row.product_name, v_row.color, v_row.size,
        p_n_picked, v_row.price_snapshot, v_row.imagen,
        'picked', p_checked_by, now()
      )
      RETURNING id INTO v_new_picked_id;
    END IF;
  END IF;

  IF coalesce(p_n_waiting, 0) > 0 THEN
    INSERT INTO public.order_items (
      order_id, variant_id, product_name, color, size, quantity, price_snapshot, imagen,
      status, checked_by, checked_at, deferred_stock_pending
    ) VALUES (
      v_order_id, v_row.variant_id, v_row.product_name, v_row.color, v_row.size,
      p_n_waiting, v_row.price_snapshot, v_row.imagen,
      'waiting', p_checked_by, now(),
      CASE WHEN v_parent_pending THEN true ELSE false END
    )
    RETURNING id INTO v_new_waiting_id;
  END IF;

  IF coalesce(p_n_missing, 0) > 0 THEN
    INSERT INTO public.order_items (
      order_id, variant_id, product_name, color, size, quantity, price_snapshot, imagen,
      status, checked_by, checked_at, deferred_stock_pending
    ) VALUES (
      v_order_id, v_row.variant_id, v_row.product_name, v_row.color, v_row.size,
      p_n_missing, v_row.price_snapshot, v_row.imagen,
      'missing', p_checked_by, now(), false
    )
    RETURNING id INTO v_new_missing_id;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.order_item_stock_sources s
    WHERE s.order_item_id = p_item_id
      AND greatest(coalesce(s.qty, 0), 0) > 0
  ) INTO v_has_sources;

  IF v_has_sources AND NOT v_parent_pending THEN
    CREATE TEMPORARY TABLE IF NOT EXISTS tmp_split_sources (
      warehouse_id uuid PRIMARY KEY,
      remaining_qty int NOT NULL
    ) ON COMMIT DROP;

    CREATE TEMPORARY TABLE IF NOT EXISTS tmp_split_targets (
      seq int PRIMARY KEY,
      item_id uuid NOT NULL,
      qty int NOT NULL
    ) ON COMMIT DROP;

    CREATE TEMPORARY TABLE IF NOT EXISTS tmp_split_alloc (
      warehouse_id uuid PRIMARY KEY,
      alloc_qty int NOT NULL DEFAULT 0,
      remainder numeric NOT NULL DEFAULT 0
    ) ON COMMIT DROP;

    TRUNCATE TABLE tmp_split_sources;
    TRUNCATE TABLE tmp_split_targets;
    TRUNCATE TABLE tmp_split_alloc;

    INSERT INTO tmp_split_sources (warehouse_id, remaining_qty)
    SELECT
      s.warehouse_id,
      sum(greatest(coalesce(s.qty, 0), 0))::int AS remaining_qty
    FROM public.order_item_stock_sources s
    WHERE s.order_item_id = p_item_id
    GROUP BY s.warehouse_id;

    SELECT coalesce(sum(remaining_qty), 0)::int
    INTO v_source_total
    FROM tmp_split_sources;

    IF v_source_total <> v_row.quantity THEN
      RAISE EXCEPTION
        'Inconsistencia en fuentes de stock del ítem %: quantity=%, sum(sources)=%',
        p_item_id, v_row.quantity, v_source_total;
    END IF;

    IF v_new_picked_id IS NOT NULL THEN
      INSERT INTO tmp_split_targets (seq, item_id, qty)
      VALUES (1, v_new_picked_id, p_n_picked);
    END IF;
    IF v_new_waiting_id IS NOT NULL THEN
      INSERT INTO tmp_split_targets (seq, item_id, qty)
      VALUES (2, v_new_waiting_id, p_n_waiting);
    END IF;
    IF v_new_missing_id IS NOT NULL THEN
      INSERT INTO tmp_split_targets (seq, item_id, qty)
      VALUES (3, v_new_missing_id, p_n_missing);
    END IF;

    SELECT coalesce(max(seq), 0) INTO v_last_seq FROM tmp_split_targets;
    v_total_remaining := v_row.quantity;

    FOR v_target IN
      SELECT seq, item_id, qty
      FROM tmp_split_targets
      ORDER BY seq
    LOOP
      IF coalesce(v_target.qty, 0) <= 0 THEN
        CONTINUE;
      END IF;

      IF v_target.seq = v_last_seq THEN
        INSERT INTO public.order_item_stock_sources (order_item_id, warehouse_id, qty)
        SELECT v_target.item_id, s.warehouse_id, s.remaining_qty
        FROM tmp_split_sources s
        WHERE s.remaining_qty > 0;

        UPDATE tmp_split_sources
        SET remaining_qty = 0
        WHERE remaining_qty > 0;

        v_total_remaining := 0;
        CONTINUE;
      END IF;

      IF v_total_remaining <= 0 THEN
        RAISE EXCEPTION 'No hay cantidad remanente para redistribuir fuentes en split de %', p_item_id;
      END IF;

      TRUNCATE TABLE tmp_split_alloc;

      INSERT INTO tmp_split_alloc (warehouse_id, alloc_qty, remainder)
      SELECT
        s.warehouse_id,
        floor((s.remaining_qty::numeric * v_target.qty::numeric) / v_total_remaining::numeric)::int AS alloc_qty,
        ((s.remaining_qty::numeric * v_target.qty::numeric) / v_total_remaining::numeric)
          - floor((s.remaining_qty::numeric * v_target.qty::numeric) / v_total_remaining::numeric) AS remainder
      FROM tmp_split_sources s
      WHERE s.remaining_qty > 0;

      SELECT v_target.qty - coalesce(sum(a.alloc_qty), 0)::int
      INTO v_missing_alloc
      FROM tmp_split_alloc a;

      IF v_missing_alloc > 0 THEN
        UPDATE tmp_split_alloc a
        SET alloc_qty = alloc_qty + 1
        FROM (
          SELECT a2.warehouse_id
          FROM tmp_split_alloc a2
          JOIN tmp_split_sources s2 ON s2.warehouse_id = a2.warehouse_id
          WHERE (s2.remaining_qty - a2.alloc_qty) > 0
          ORDER BY a2.remainder DESC, a2.warehouse_id
          LIMIT v_missing_alloc
        ) inc
        WHERE a.warehouse_id = inc.warehouse_id;
      END IF;

      SELECT coalesce(sum(a.alloc_qty), 0)::int
      INTO v_alloc_total
      FROM tmp_split_alloc a;

      IF v_alloc_total <> v_target.qty THEN
        RAISE EXCEPTION
          'No se pudo asignar exactamente fuentes para split de % (target=%, alloc=%)',
          p_item_id, v_target.qty, v_alloc_total;
      END IF;

      INSERT INTO public.order_item_stock_sources (order_item_id, warehouse_id, qty)
      SELECT v_target.item_id, a.warehouse_id, a.alloc_qty
      FROM tmp_split_alloc a
      WHERE a.alloc_qty > 0;

      UPDATE tmp_split_sources s
      SET remaining_qty = s.remaining_qty - a.alloc_qty
      FROM tmp_split_alloc a
      WHERE s.warehouse_id = a.warehouse_id;

      IF EXISTS (
        SELECT 1
        FROM tmp_split_sources s
        WHERE s.remaining_qty < 0
      ) THEN
        RAISE EXCEPTION 'Redistribución inválida: fuentes negativas en split de %', p_item_id;
      END IF;

      v_total_remaining := v_total_remaining - v_target.qty;
    END LOOP;
  END IF;

  DELETE FROM public.order_items WHERE id = p_item_id;

  SELECT public.has_all_items_picked(v_order_id) INTO v_all_picked;

  RETURN json_build_object(
    'order_id', v_order_id,
    'all_items_picked', v_all_picked,
    'split_item_ids', json_build_object(
      'picked', v_new_picked_id,
      'waiting', v_new_waiting_id,
      'missing', v_new_missing_id
    ),
    'had_sources', v_has_sources,
    'deferred_zone', v_deferred_zone
  );
END;
$$;

COMMENT ON FUNCTION public.rpc_split_order_item_status(uuid, int, int, int, uuid) IS
  '312: split apartado/espera/missing; zona deferred commit al apartar porción picked.';

GRANT EXECUTE ON FUNCTION public.rpc_split_order_item_status(uuid, int, int, int, uuid) TO authenticated;

SELECT pg_notify('pgrst', 'reload schema');
