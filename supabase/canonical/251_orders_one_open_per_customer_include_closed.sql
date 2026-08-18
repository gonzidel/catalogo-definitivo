-- 251_orders_one_open_per_customer_include_closed.sql
--
-- Amplía la regla "un solo pedido abierto por cliente" (índice único creado en
-- 119_order_item_operational_and_empty_order_maint.sql) para que también incluya
-- `closed` (pedido cerrado, pendiente de envío). Antes solo cubría `active` y
-- `closing_soon`, lo que permitía en teoría que un cliente tuviera un pedido
-- `closed` sin resolver y, al mismo tiempo, uno nuevo `active` (vía checkout o
-- creación manual admin) — inconsistente con la regla de negocio "un pedido a
-- la vez". `stock_pending` queda deliberadamente fuera de esta ampliación
-- (decisión explícita, no touched).
--
-- Afecta:
--   1) Índice único parcial `orders_one_open_per_customer_idx` (customer_id).
--   2) rpc_checkout_cart() — bloquea con mensaje claro si el único pedido
--      existente del cliente está `closed` (en vez de crear uno nuevo silenciosamente).
--   3) rpc_create_admin_order_atomic() — amplía el chequeo OPEN_ORDER_EXISTS.
--
-- No se tocan `admin/order-creator.js`, `admin/orders-ops.js` ni
-- `nj/lib/supabase/order-create.ts` en esta migración SQL (cambios de app en
-- archivos JS/TS aparte, mismo commit).

-- 1) Verificación previa: no debe haber violaciones antes de ampliar el índice.
DO $$
DECLARE
  v_bad int;
BEGIN
  SELECT count(*)::int INTO v_bad
  FROM (
    SELECT customer_id
    FROM public.orders
    WHERE status IN ('active', 'closing_soon', 'closed')
    GROUP BY customer_id
    HAVING count(*) > 1
  ) t;

  IF coalesce(v_bad, 0) > 0 THEN
    RAISE EXCEPTION
      '251: hay % cliente(s) con más de un pedido en active/closing_soon/closed. Resolver manualmente antes de ampliar el índice único.',
      v_bad;
  END IF;
END $$;

DROP INDEX IF EXISTS public.orders_one_open_per_customer_idx;

CREATE UNIQUE INDEX orders_one_open_per_customer_idx
  ON public.orders (customer_id)
  WHERE (status IN ('active', 'closing_soon', 'closed'));

COMMENT ON INDEX public.orders_one_open_per_customer_idx IS
  'Un solo pedido abierto (active, closing_soon o closed) por customer_id. Ampliado 2026-07-18 (migración 251) para incluir closed — stock_pending queda fuera a propósito.';

-- 2) rpc_checkout_cart(): bloquear en vez de crear un pedido nuevo si el
--    cliente solo tiene un pedido `closed` sin resolver.
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

  UPDATE public.orders
  SET total_amount = coalesce(total_amount, 0) + coalesce(v_total, 0)
  WHERE id = v_order_id;

  SELECT order_number INTO v_order_number FROM public.orders WHERE id = v_order_id;

  RETURN json_build_object('order_id', v_order_id, 'order_number', coalesce(v_order_number, ''));
END;
$function$;

COMMENT ON FUNCTION public.rpc_checkout_cart() IS
  'canonical:251 | source:supabase/canonical/251_orders_one_open_per_customer_include_closed.sql | bloquea checkout si el cliente solo tiene un pedido closed sin resolver (una vez a la vez, ampliado a closed).';

-- 3) rpc_create_admin_order_atomic(): ampliar el chequeo OPEN_ORDER_EXISTS a `closed`.
CREATE OR REPLACE FUNCTION public.rpc_create_admin_order_atomic(
  p_payload jsonb,
  p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_uid           uuid;
  v_is_admin      boolean;
  v_hash          text;
  v_ins_key       uuid;
  v_row           public.admin_order_create_idempotency%rowtype;
  v_customer_id   uuid;
  v_total         numeric;
  v_notes         text;
  v_extra         jsonb;
  v_items         jsonb;
  v_item          jsonb;
  v_items_eff     jsonb := '[]'::jsonb;
  v_ii            int;
  v_qty           int;
  v_g             int;
  v_v             int;
  v_has_split     boolean;
  v_norm_item     jsonb;
  v_norm_size     text;
  v_order_id      uuid;
  v_order_number  text;
  v_open_order    uuid;
  v_open_order_status text;
  v_general       uuid;
  v_venta         uuid;
  v_resp          jsonb;
  v_manual        jsonb := '[]'::jsonb;
  v_deductions    jsonb := '[]'::jsonb;
  v_item_ids      uuid[] := array[]::uuid[];
  v_oi_id         uuid;
  v_ps            numeric;
  v_deduct_result jsonb;
BEGIN
  if p_idempotency_key is null then
    raise exception 'rpc_create_admin_order_atomic: p_idempotency_key es obligatorio'
      using errcode = '22023';
  end if;

  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'rpc_create_admin_order_atomic: usuario no autenticado';
  end if;

  select exists (select 1 from public.admins a where a.user_id = v_uid)
  into v_is_admin;

  if not v_is_admin then
    raise exception 'rpc_create_admin_order_atomic: forbidden (solo admins)';
  end if;

  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'rpc_create_admin_order_atomic: p_payload debe ser objeto jsonb';
  end if;

  v_hash := fyl_private.admin_order_payload_sha256(p_payload);

  insert into public.admin_order_create_idempotency (
    idempotency_key, admin_user_id, payload_hash, status
  ) values (
    p_idempotency_key, v_uid, v_hash, 'pending'
  )
  on conflict (idempotency_key) do nothing
  returning idempotency_key into v_ins_key;

  if v_ins_key is null then
    select * into v_row
    from public.admin_order_create_idempotency d
    where d.idempotency_key = p_idempotency_key;

    IF NOT FOUND THEN
      raise exception 'rpc_create_admin_order_atomic: idempotency inconsistente';
    END IF;

    if v_row.admin_user_id is distinct from v_uid then
      raise exception 'rpc_create_admin_order_atomic: idempotency key pertenece a otro admin';
    end if;

    if v_row.status = 'success' then
      if v_row.payload_hash is distinct from v_hash then
        raise exception
          'rpc_create_admin_order_atomic: IDEMPOTENCY_CONFLICT — mismo idempotency_key con payload distinto'
          using errcode = 'P0001';
      end if;
      return coalesce(v_row.response_jsonb, '{}'::jsonb)
        || jsonb_build_object(
             'idempotency', jsonb_build_object('replay', true)
           );
    end if;

    raise exception 'rpc_create_admin_order_atomic: reintentá en unos segundos (idempotency en curso)';
  end if;

  v_customer_id := nullif(trim(both from p_payload->>'customer_id'), '')::uuid;
  if v_customer_id is null then
    raise exception 'rpc_create_admin_order_atomic: customer_id inválido';
  end if;

  if not exists (select 1 from public.customers c where c.id = v_customer_id) then
    raise exception
      'rpc_create_admin_order_atomic: CUSTOMER_NOT_FOUND — cliente no encontrado'
      using errcode = 'P0001';
  end if;

  v_extra := p_payload->'extra_notes';
  if v_extra is not null and jsonb_typeof(v_extra) = 'object' and v_extra <> '{}'::jsonb then
    v_notes := v_extra::text;
  elsif p_payload ? 'notes' and p_payload->'notes' is not null then
    if jsonb_typeof(p_payload->'notes') in ('object', 'array') then
      v_notes := (p_payload->'notes')::text;
    else
      v_notes := nullif(trim(both from p_payload->>'notes'), '');
    end if;
  else
    v_notes := null;
  end if;

  v_total := coalesce((p_payload->>'total_amount')::numeric, 0);

  v_items := p_payload->'items';
  if v_items is null or jsonb_typeof(v_items) <> 'array' or jsonb_array_length(v_items) = 0 then
    raise exception 'rpc_create_admin_order_atomic: items debe ser un array no vacío';
  end if;

  for v_ii in 0..jsonb_array_length(v_items) - 1 loop
    v_item := v_items -> v_ii;
    if nullif(trim(both from v_item ->> 'variant_id'), '') is null then
      raise exception 'rpc_create_admin_order_atomic: variant_id requerido en ítem %', v_ii + 1;
    end if;
    begin
      perform (trim(both from v_item ->> 'variant_id'))::uuid;
    exception
      when invalid_text_representation then
        raise exception 'rpc_create_admin_order_atomic: variant_id UUID inválido en ítem %', v_ii + 1;
    end;

    v_qty := coalesce((v_item ->> 'quantity')::int, 0);
    if v_qty <= 0 then
      raise exception 'rpc_create_admin_order_atomic: quantity debe ser > 0 (ítem %)', v_ii + 1;
    end if;

    v_g := coalesce((v_item ->> 'qty_from_general')::int, 0);
    v_v := coalesce((v_item ->> 'qty_from_venta')::int, 0);
    v_has_split := (v_g + v_v) > 0;
    v_norm_size := fyl_private.normalize_size_admin_order(v_item ->> 'size');

    if v_norm_size <> '' and not v_has_split then
      v_norm_item := v_item
        || jsonb_build_object(
             'status', coalesce(nullif(trim(both from v_item ->> 'status'), ''), 'picked'),
             'admin_confirmed_missing', true
           );
    else
      v_norm_item := v_item
        || jsonb_build_object(
             'status', coalesce(nullif(trim(both from v_item ->> 'status'), ''), 'picked'),
             'admin_confirmed_missing', coalesce((v_item ->> 'admin_confirmed_missing')::boolean, false)
           );
    end if;

    v_norm_item := v_norm_item || jsonb_build_object('size', nullif(v_norm_size, ''));
    v_items_eff := v_items_eff || jsonb_build_array(v_norm_item);
  end loop;

  select o.id, o.status
    into v_open_order, v_open_order_status
  from public.orders o
  where o.customer_id = v_customer_id
    and o.status in ('active', 'closing_soon', 'closed')
  order by o.created_at desc
  limit 1;

  if v_open_order is not null then
    raise exception
      'rpc_create_admin_order_atomic: OPEN_ORDER_EXISTS — el cliente ya tiene un pedido % (%s)',
      v_open_order_status, v_open_order
      using errcode = 'P0001';
  end if;

  select w.id into v_general from public.warehouses w where w.code = 'general' limit 1;
  select w.id into v_venta from public.warehouses w where w.code = 'venta-publico' limit 1;

  if v_general is null or v_venta is null then
    raise exception 'rpc_create_admin_order_atomic: warehouses general o venta-publico no encontrados';
  end if;

  insert into public.orders (
    customer_id, status, total_amount, notes, source, created_by_user_id
  ) values (
    v_customer_id, 'active', v_total, v_notes, 'admin', v_uid
  )
  returning id, order_number into v_order_id, v_order_number;

  for v_ii in 0..jsonb_array_length(v_items_eff) - 1 loop
    v_item := v_items_eff -> v_ii;
    v_norm_size := fyl_private.normalize_size_admin_order(v_item ->> 'size');

    if v_item ? 'price_snapshot' and jsonb_typeof(v_item -> 'price_snapshot') = 'number' then
      v_ps := (v_item -> 'price_snapshot')::text::numeric;
    elsif nullif(trim(both from v_item ->> 'price_snapshot'), '') is not null then
      v_ps := trim(both from v_item ->> 'price_snapshot')::numeric;
    else
      v_ps := null;
    end if;

    insert into public.order_items (
      order_id,
      variant_id,
      product_name,
      color,
      size,
      quantity,
      price_snapshot,
      imagen,
      status,
      admin_confirmed_missing
    ) values (
      v_order_id,
      (v_item ->> 'variant_id')::uuid,
      v_item ->> 'product_name',
      v_item ->> 'color',
      nullif(v_norm_size, ''),
      (v_item ->> 'quantity')::int,
      v_ps,
      v_item ->> 'imagen',
      coalesce(nullif(trim(both from v_item ->> 'status'), ''), 'picked'),
      coalesce((v_item ->> 'admin_confirmed_missing')::boolean, false)
    )
    returning id into v_oi_id;

    v_item_ids := array_append(v_item_ids, v_oi_id);
  end loop;

  v_manual := '[]'::jsonb;
  for v_ii in 0..jsonb_array_length(v_items_eff) - 1 loop
    v_item := v_items_eff -> v_ii;
    if coalesce((v_item ->> 'admin_confirmed_missing')::boolean, false)
       and nullif(trim(both from v_item ->> 'variant_id'), '') is not null
       and fyl_private.normalize_size_admin_order(v_item ->> 'size') <> ''
       and coalesce((v_item ->> 'quantity')::int, 0) > 0 then
      v_manual := v_manual || jsonb_build_array(
        jsonb_build_object(
          'variant_id', (v_item ->> 'variant_id')::uuid,
          'size', fyl_private.normalize_size_admin_order(v_item ->> 'size'),
          'warehouse_id', v_general,
          'qty', (v_item ->> 'quantity')::int,
          'order_item_id', v_item_ids[v_ii + 1]
        )
      );
    end if;
  end loop;

  if jsonb_array_length(v_manual) > 0 then
    perform public.rpc_admin_manual_inject_and_deduct(v_manual, v_order_id);
  end if;

  v_deductions := '[]'::jsonb;
  for v_ii in 0..jsonb_array_length(v_items_eff) - 1 loop
    v_item := v_items_eff -> v_ii;
    if not fyl_private.admin_order_item_qualifies_deduction(v_item) then
      continue;
    end if;

    v_norm_size := fyl_private.normalize_size_admin_order(v_item ->> 'size');
    v_qty := (v_item ->> 'quantity')::int;
    v_g := coalesce((v_item ->> 'qty_from_general')::int, 0);
    v_v := coalesce((v_item ->> 'qty_from_venta')::int, 0);

    if v_g > 0 then
      v_deductions := v_deductions || jsonb_build_array(
        jsonb_build_object(
          'variant_id', (v_item ->> 'variant_id')::uuid,
          'size', v_norm_size,
          'warehouse_id', v_general,
          'qty_to_deduct', v_g,
          'order_item_id', v_item_ids[v_ii + 1]
        )
      );
    end if;

    if v_v > 0 then
      v_deductions := v_deductions || jsonb_build_array(
        jsonb_build_object(
          'variant_id', (v_item ->> 'variant_id')::uuid,
          'size', v_norm_size,
          'warehouse_id', v_venta,
          'qty_to_deduct', v_v,
          'order_item_id', v_item_ids[v_ii + 1]
        )
      );
    end if;
  end loop;

  if jsonb_array_length(v_deductions) > 0 then
    select public.rpc_apply_order_stock_deduction(
      v_deductions,
      v_order_id,
      'order_creation'
    )
    into v_deduct_result;
  end if;

  v_resp := jsonb_build_object(
    'ok', true,
    'order_id', v_order_id,
    'order_number', v_order_number,
    'order_items', coalesce(
      (
        select jsonb_agg(
                 jsonb_build_object(
                   'id', oi.id,
                   'variant_id', oi.variant_id,
                   'size', oi.size,
                   'quantity', oi.quantity,
                   'admin_confirmed_missing', oi.admin_confirmed_missing
                 )
                 order by oi.created_at
               )
        from public.order_items oi
        where oi.order_id = v_order_id
      ),
      '[]'::jsonb
    ),
    'stock', jsonb_build_object(
      'manual_processed', coalesce(jsonb_array_length(v_manual), 0),
      'deduction_applied_items',
        case
          when jsonb_array_length(v_deductions) > 0 then coalesce((v_deduct_result ->> 'applied_items')::int, 0)
          else 0
        end,
      'source', 'order_creation'
    ),
    'idempotency', jsonb_build_object('replay', false)
  );

  update public.admin_order_create_idempotency d
     set status = 'success',
         order_id = v_order_id,
         response_jsonb = v_resp,
         completed_at = now()
   where d.idempotency_key = p_idempotency_key;

  return v_resp;
END;
$$;

COMMENT ON FUNCTION public.rpc_create_admin_order_atomic(jsonb, uuid) IS
  'canonical:251 (amplía OPEN_ORDER_EXISTS a closed) | anterior: canonical:217 — ver doc/plan-implementacion-rpc-create-admin-order-atomic-staging-2026-05-15.md.';

SELECT pg_notify('pgrst', 'reload schema');
