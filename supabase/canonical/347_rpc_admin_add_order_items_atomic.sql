-- 347_rpc_admin_add_order_items_atomic.sql
--
-- Evita que NJ/admin legacy agreguen líneas, stock y total mediante varias
-- transacciones y luego reactiven silenciosamente pedidos cancelled/expired.
--
-- Contrato:
--   rpc_admin_add_order_items_atomic(p_order_id, p_payload, p_idempotency_key)
--   p_payload = {
--     expected_status: text,
--     notes_extras: object opcional,
--     items: [{
--       variant_id, product_name, color, size, quantity, price_snapshot, imagen,
--       status, admin_confirmed_missing, is_special_extra,
--       qty_from_general, qty_from_venta
--     }]
--   }
--
-- Todo ocurre en una sola transacción: lock de pedido, INSERT order_items,
-- inyección/deducción de stock, fuentes, total, notes, estado e idempotencia.
--
-- Riesgo: MEDIO. Nueva RPC aditiva; no cambia datos hasta que los frontends la
-- invoquen. Rollback: 347_ROLLBACK_rpc_admin_add_order_items_atomic.sql.

CREATE TABLE IF NOT EXISTS public.admin_order_edit_idempotency (
  idempotency_key uuid PRIMARY KEY,
  admin_user_id uuid NOT NULL,
  order_id uuid NOT NULL
    REFERENCES public.orders(id) ON DELETE CASCADE,
  payload_hash text NOT NULL,
  status text NOT NULL
    CONSTRAINT admin_order_edit_idempotency_status_chk
      CHECK (status IN ('pending', 'success')),
  response_jsonb jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT admin_order_edit_idempotency_success_response_chk
    CHECK (status <> 'success' OR response_jsonb IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS admin_order_edit_idempotency_order_created_idx
  ON public.admin_order_edit_idempotency(order_id, created_at DESC);

COMMENT ON TABLE public.admin_order_edit_idempotency IS
  '347: idempotencia fuerte para agregar ítems a pedido existente; pending y mutaciones comparten transacción.';

REVOKE ALL ON TABLE public.admin_order_edit_idempotency FROM PUBLIC;
REVOKE ALL ON TABLE public.admin_order_edit_idempotency FROM anon;
REVOKE ALL ON TABLE public.admin_order_edit_idempotency FROM authenticated;

CREATE OR REPLACE FUNCTION public.rpc_admin_add_order_items_atomic(
  p_order_id uuid,
  p_payload jsonb,
  p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_uid uuid;
  v_hash text;
  v_inserted_key uuid;
  v_dedupe public.admin_order_edit_idempotency%rowtype;
  v_order record;
  v_expected_status text;
  v_status text;
  v_items jsonb;
  v_items_eff jsonb := '[]'::jsonb;
  v_item jsonb;
  v_norm_item jsonb;
  v_index int;
  v_qty int;
  v_qty_general int;
  v_qty_venta int;
  v_price numeric;
  v_size text;
  v_variant_id uuid;
  v_is_special boolean;
  v_is_return boolean;
  v_admin_missing boolean;
  v_item_id uuid;
  v_item_ids uuid[] := array[]::uuid[];
  v_manual jsonb := '[]'::jsonb;
  v_deductions jsonb := '[]'::jsonb;
  v_general uuid;
  v_venta uuid;
  v_deduct_result jsonb;
  v_notes jsonb;
  v_notes_patch jsonb;
  v_subtotal numeric := 0;
  v_shipping numeric := 0;
  v_discount numeric := 0;
  v_extras_amount numeric := 0;
  v_extras_percentage numeric := 0;
  v_total numeric := 0;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION
      'rpc_admin_add_order_items_atomic: p_idempotency_key es obligatorio'
      USING ERRCODE = '22023';
  END IF;

  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'rpc_admin_add_order_items_atomic: order_id inválido'
      USING ERRCODE = '22023';
  END IF;

  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'rpc_admin_add_order_items_atomic: usuario no autenticado';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.admins a
    WHERE a.user_id = v_uid
  ) THEN
    RAISE EXCEPTION 'rpc_admin_add_order_items_atomic: forbidden (solo admins)';
  END IF;

  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION
      'rpc_admin_add_order_items_atomic: p_payload debe ser objeto jsonb'
      USING ERRCODE = '22023';
  END IF;

  v_hash := fyl_private.admin_order_payload_sha256(
    jsonb_build_object('order_id', p_order_id, 'payload', p_payload)
  );

  INSERT INTO public.admin_order_edit_idempotency (
    idempotency_key,
    admin_user_id,
    order_id,
    payload_hash,
    status
  )
  VALUES (
    p_idempotency_key,
    v_uid,
    p_order_id,
    v_hash,
    'pending'
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING idempotency_key INTO v_inserted_key;

  IF v_inserted_key IS NULL THEN
    SELECT *
    INTO v_dedupe
    FROM public.admin_order_edit_idempotency d
    WHERE d.idempotency_key = p_idempotency_key;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'rpc_admin_add_order_items_atomic: idempotencia inconsistente';
    END IF;

    IF v_dedupe.admin_user_id IS DISTINCT FROM v_uid
       OR v_dedupe.order_id IS DISTINCT FROM p_order_id
    THEN
      RAISE EXCEPTION
        'rpc_admin_add_order_items_atomic: idempotency key pertenece a otra operación';
    END IF;

    IF v_dedupe.payload_hash IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION
        'rpc_admin_add_order_items_atomic: IDEMPOTENCY_CONFLICT — misma clave con payload distinto'
        USING ERRCODE = 'P0001';
    END IF;

    IF v_dedupe.status = 'success' THEN
      RETURN coalesce(v_dedupe.response_jsonb, '{}'::jsonb)
        || jsonb_build_object(
             'idempotency',
             jsonb_build_object('replay', true)
           );
    END IF;

    RAISE EXCEPTION
      'rpc_admin_add_order_items_atomic: operación en curso; reintentá';
  END IF;

  SELECT
    o.id,
    o.status,
    o.customer_id,
    o.order_number,
    o.total_amount,
    o.notes
  INTO v_order
  FROM public.orders o
  WHERE o.id = p_order_id
  FOR UPDATE;

  IF v_order.id IS NULL THEN
    RAISE EXCEPTION
      'rpc_admin_add_order_items_atomic: ORDER_NOT_FOUND — pedido inexistente'
      USING ERRCODE = 'P0001';
  END IF;

  v_status := lower(trim(coalesce(v_order.status, '')));
  v_expected_status := lower(
    trim(coalesce(p_payload->>'expected_status', ''))
  );

  IF v_expected_status <> '' AND v_expected_status IS DISTINCT FROM v_status THEN
    RAISE EXCEPTION
      'rpc_admin_add_order_items_atomic: ORDER_STATE_CHANGED — esperado %, actual %',
      v_expected_status,
      v_status
      USING ERRCODE = 'P0001';
  END IF;

  -- Allowlist operativa: Activos / Espera / Apartados y Cerrados aún no enviados.
  -- cancelled/expired/stock_pending/sent/devolución se rechazan para no resucitar
  -- ni mutar pedidos terminales desde el alta admin.
  IF v_status NOT IN (
    'active',
    'closing_soon',
    'closed'
  ) THEN
    RAISE EXCEPTION
      'rpc_admin_add_order_items_atomic: ORDER_STATE_BLOCKED — no se puede editar estado %',
      v_status
      USING ERRCODE = 'P0001';
  END IF;

  v_items := p_payload->'items';
  IF v_items IS NULL
     OR jsonb_typeof(v_items) <> 'array'
     OR jsonb_array_length(v_items) = 0
  THEN
    RAISE EXCEPTION
      'rpc_admin_add_order_items_atomic: items debe ser un array no vacío'
      USING ERRCODE = '22023';
  END IF;

  SELECT w.id INTO v_general
  FROM public.warehouses w
  WHERE w.code = 'general'
  LIMIT 1;

  SELECT w.id INTO v_venta
  FROM public.warehouses w
  WHERE w.code = 'venta-publico'
  LIMIT 1;

  IF v_general IS NULL OR v_venta IS NULL THEN
    RAISE EXCEPTION
      'rpc_admin_add_order_items_atomic: warehouses general o venta-publico no encontrados';
  END IF;

  FOR v_index IN 0..jsonb_array_length(v_items) - 1 LOOP
    v_item := v_items->v_index;

    IF jsonb_typeof(v_item) <> 'object' THEN
      RAISE EXCEPTION
        'rpc_admin_add_order_items_atomic: ítem % inválido',
        v_index + 1
        USING ERRCODE = '22023';
    END IF;

    v_qty := coalesce((v_item->>'quantity')::int, 0);
    IF v_qty <= 0 THEN
      RAISE EXCEPTION
        'rpc_admin_add_order_items_atomic: quantity debe ser > 0 (ítem %)',
        v_index + 1
        USING ERRCODE = '22023';
    END IF;

    IF nullif(trim(coalesce(v_item->>'product_name', '')), '') IS NULL THEN
      RAISE EXCEPTION
        'rpc_admin_add_order_items_atomic: product_name requerido (ítem %)',
        v_index + 1
        USING ERRCODE = '22023';
    END IF;

    BEGIN
      v_price := coalesce((v_item->>'price_snapshot')::numeric, 0);
    EXCEPTION
      WHEN invalid_text_representation THEN
        RAISE EXCEPTION
          'rpc_admin_add_order_items_atomic: price_snapshot inválido (ítem %)',
          v_index + 1
          USING ERRCODE = '22023';
    END;

    v_is_special := coalesce(
      (v_item->>'is_special_extra')::boolean,
      false
    );
    v_is_return := v_price < 0;
    v_size := fyl_private.normalize_size_admin_order(v_item->>'size');
    v_qty_general := coalesce((v_item->>'qty_from_general')::int, 0);
    v_qty_venta := coalesce((v_item->>'qty_from_venta')::int, 0);

    IF v_qty_general < 0 OR v_qty_venta < 0 THEN
      RAISE EXCEPTION
        'rpc_admin_add_order_items_atomic: split negativo (ítem %)',
        v_index + 1
        USING ERRCODE = '22023';
    END IF;

    IF nullif(trim(coalesce(v_item->>'variant_id', '')), '') IS NULL THEN
      IF NOT v_is_special THEN
        RAISE EXCEPTION
          'rpc_admin_add_order_items_atomic: variant_id requerido salvo extra especial (ítem %)',
          v_index + 1
          USING ERRCODE = '22023';
      END IF;
      v_variant_id := NULL;
      v_qty_general := 0;
      v_qty_venta := 0;
      v_admin_missing := false;
      v_size := '';
    ELSE
      BEGIN
        v_variant_id := (trim(v_item->>'variant_id'))::uuid;
      EXCEPTION
        WHEN invalid_text_representation THEN
          RAISE EXCEPTION
            'rpc_admin_add_order_items_atomic: variant_id UUID inválido (ítem %)',
            v_index + 1
            USING ERRCODE = '22023';
      END;

      IF v_is_return THEN
        v_qty_general := 0;
        v_qty_venta := 0;
        v_admin_missing := false;
      ELSE
        v_admin_missing := coalesce(
          (v_item->>'admin_confirmed_missing')::boolean,
          false
        );

        IF v_size <> ''
           AND v_qty_general + v_qty_venta <> v_qty
        THEN
          v_admin_missing := true;
        END IF;
      END IF;
    END IF;

    IF lower(trim(coalesce(v_item->>'status', 'picked'))) NOT IN (
      'picked',
      'reserved',
      'waiting',
      'missing'
    ) THEN
      RAISE EXCEPTION
        'rpc_admin_add_order_items_atomic: status de ítem inválido (ítem %)',
        v_index + 1
        USING ERRCODE = '22023';
    END IF;

    v_norm_item := v_item || jsonb_build_object(
      'variant_id', v_variant_id,
      'size', nullif(v_size, ''),
      'quantity', v_qty,
      'price_snapshot', v_price,
      'qty_from_general', v_qty_general,
      'qty_from_venta', v_qty_venta,
      'status', lower(trim(coalesce(v_item->>'status', 'picked'))),
      'admin_confirmed_missing', v_admin_missing,
      'is_special_extra', v_is_special
    );

    v_items_eff := v_items_eff || jsonb_build_array(v_norm_item);
  END LOOP;

  FOR v_index IN 0..jsonb_array_length(v_items_eff) - 1 LOOP
    v_item := v_items_eff->v_index;

    INSERT INTO public.order_items (
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
    )
    VALUES (
      p_order_id,
      nullif(v_item->>'variant_id', '')::uuid,
      trim(v_item->>'product_name'),
      nullif(v_item->>'color', ''),
      nullif(v_item->>'size', ''),
      (v_item->>'quantity')::int,
      (v_item->>'price_snapshot')::numeric,
      nullif(v_item->>'imagen', ''),
      v_item->>'status',
      coalesce((v_item->>'admin_confirmed_missing')::boolean, false)
    )
    RETURNING id INTO v_item_id;

    v_item_ids := array_append(v_item_ids, v_item_id);
  END LOOP;

  FOR v_index IN 0..jsonb_array_length(v_items_eff) - 1 LOOP
    v_item := v_items_eff->v_index;

    IF coalesce((v_item->>'admin_confirmed_missing')::boolean, false)
       AND coalesce((v_item->>'price_snapshot')::numeric, 0) >= 0
       AND nullif(v_item->>'variant_id', '') IS NOT NULL
       AND fyl_private.normalize_size_admin_order(v_item->>'size') <> ''
    THEN
      v_manual := v_manual || jsonb_build_array(
        jsonb_build_object(
          'variant_id', (v_item->>'variant_id')::uuid,
          'size', fyl_private.normalize_size_admin_order(v_item->>'size'),
          'warehouse_id', v_general,
          'qty', (v_item->>'quantity')::int,
          'order_item_id', v_item_ids[v_index + 1]
        )
      );
    ELSIF coalesce((v_item->>'price_snapshot')::numeric, 0) >= 0
       AND fyl_private.admin_order_item_qualifies_deduction(v_item)
    THEN
      v_qty_general := coalesce((v_item->>'qty_from_general')::int, 0);
      v_qty_venta := coalesce((v_item->>'qty_from_venta')::int, 0);

      IF v_qty_general > 0 THEN
        v_deductions := v_deductions || jsonb_build_array(
          jsonb_build_object(
            'variant_id', (v_item->>'variant_id')::uuid,
            'size', fyl_private.normalize_size_admin_order(v_item->>'size'),
            'warehouse_id', v_general,
            'qty_to_deduct', v_qty_general,
            'order_item_id', v_item_ids[v_index + 1]
          )
        );
      END IF;

      IF v_qty_venta > 0 THEN
        v_deductions := v_deductions || jsonb_build_array(
          jsonb_build_object(
            'variant_id', (v_item->>'variant_id')::uuid,
            'size', fyl_private.normalize_size_admin_order(v_item->>'size'),
            'warehouse_id', v_venta,
            'qty_to_deduct', v_qty_venta,
            'order_item_id', v_item_ids[v_index + 1]
          )
        );
      END IF;
    END IF;
  END LOOP;

  IF jsonb_array_length(v_manual) > 0 THEN
    PERFORM public.rpc_admin_manual_inject_and_deduct(
      v_manual,
      p_order_id
    );
  END IF;

  IF jsonb_array_length(v_deductions) > 0 THEN
    SELECT public.rpc_apply_order_stock_deduction(
      v_deductions,
      p_order_id,
      'order_edit'
    )
    INTO v_deduct_result;

    IF NOT coalesce((v_deduct_result->>'ok')::boolean, false) THEN
      RAISE EXCEPTION
        'rpc_admin_add_order_items_atomic: descuento de stock sin confirmación';
    END IF;

    -- 166 descuenta stock y reserved_qty, pero no escribe OISS. Sin estas
    -- fuentes, cancelación/devolución posteriores no restauran el depósito
    -- correcto. Se insertan en la misma transacción, una por línea+depósito.
    FOR v_index IN 0..jsonb_array_length(v_deductions) - 1 LOOP
      INSERT INTO public.order_item_stock_sources (
        order_item_id,
        warehouse_id,
        qty
      )
      VALUES (
        (v_deductions->v_index->>'order_item_id')::uuid,
        (v_deductions->v_index->>'warehouse_id')::uuid,
        (v_deductions->v_index->>'qty_to_deduct')::int
      );
    END LOOP;
  END IF;

  BEGIN
    v_notes := coalesce(nullif(v_order.notes, '')::jsonb, '{}'::jsonb);
    IF jsonb_typeof(v_notes) <> 'object' THEN
      v_notes := '{}'::jsonb;
    END IF;
  EXCEPTION
    WHEN OTHERS THEN
      v_notes := '{}'::jsonb;
  END;

  v_notes_patch := p_payload->'notes_extras';
  IF v_notes_patch IS NOT NULL
     AND jsonb_typeof(v_notes_patch) = 'object'
  THEN
    v_notes := v_notes || v_notes_patch;
  END IF;

  IF nullif(trim(coalesce(v_notes->>'extras_label', '')), '') IS NULL THEN
    v_notes := v_notes - 'extras_label' - 'extras_name';
  END IF;

  SELECT coalesce(
    sum(oi.price_snapshot * oi.quantity),
    0
  )
  INTO v_subtotal
  FROM public.order_items oi
  WHERE oi.order_id = p_order_id
    AND lower(trim(coalesce(oi.status, ''))) NOT IN ('cancelled', 'expired');

  BEGIN
    v_shipping := coalesce(nullif(v_notes->>'shipping', '')::numeric, 0);
    v_discount := coalesce(nullif(v_notes->>'discount', '')::numeric, 0);
    v_extras_amount := coalesce(
      nullif(v_notes->>'extras_amount', '')::numeric,
      0
    );
    v_extras_percentage := coalesce(
      nullif(v_notes->>'extras_percentage', '')::numeric,
      0
    );
  EXCEPTION
    WHEN invalid_text_representation THEN
      RAISE EXCEPTION
        'rpc_admin_add_order_items_atomic: valores extra inválidos'
        USING ERRCODE = '22023';
  END;

  v_total :=
    v_subtotal
    + v_shipping
    - v_discount
    + v_extras_amount
    + CASE
        WHEN v_extras_percentage > 0
          THEN v_subtotal * v_extras_percentage / 100
        ELSE 0
      END;

  UPDATE public.orders o
  SET
    -- Preservar closed; solo normalizar active/closing_soon a active para
    -- mantener el pedido operativo en el Kanban.
    status = CASE
      WHEN v_status IN ('active', 'closing_soon') THEN 'active'
      ELSE o.status
    END,
    total_amount = v_total,
    notes = v_notes::text,
    updated_at = now()
  WHERE o.id = p_order_id;

  v_result := jsonb_build_object(
    'ok', true,
    'order_id', p_order_id,
    'order_number', v_order.order_number,
    'order_status', CASE
      WHEN v_status IN ('active', 'closing_soon') THEN 'active'
      ELSE v_order.status
    END,
    'total_amount', v_total,
    'inserted_items', (
      SELECT coalesce(
        jsonb_agg(
          jsonb_build_object(
            'id', oi.id,
            'variant_id', oi.variant_id,
            'size', oi.size,
            'quantity', oi.quantity,
            'admin_confirmed_missing', oi.admin_confirmed_missing
          )
          ORDER BY oi.created_at, oi.id
        ),
        '[]'::jsonb
      )
      FROM public.order_items oi
      WHERE oi.id = ANY(v_item_ids)
    ),
    'stock', jsonb_build_object(
      'manual_processed', jsonb_array_length(v_manual),
      'deduction_applied_items',
        CASE
          WHEN jsonb_array_length(v_deductions) > 0
            THEN coalesce((v_deduct_result->>'applied_items')::int, 0)
          ELSE 0
        END,
      'source', 'order_edit'
    ),
    'idempotency', jsonb_build_object('replay', false)
  );

  UPDATE public.admin_order_edit_idempotency d
  SET
    status = 'success',
    response_jsonb = v_result,
    completed_at = now()
  WHERE d.idempotency_key = p_idempotency_key;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.rpc_admin_add_order_items_atomic(uuid, jsonb, uuid) IS
  'canonical:347 | Admin: agrega ítems, stock/fuentes, total, notes y estado en una transacción; bloquea cancelled/expired/stock_pending e incluye idempotencia fuerte.';

REVOKE ALL ON FUNCTION public.rpc_admin_add_order_items_atomic(uuid, jsonb, uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_admin_add_order_items_atomic(uuid, jsonb, uuid)
  FROM anon;
REVOKE ALL ON FUNCTION public.rpc_admin_add_order_items_atomic(uuid, jsonb, uuid)
  FROM authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_admin_add_order_items_atomic(uuid, jsonb, uuid)
  TO authenticated, service_role;

SELECT pg_notify('pgrst', 'reload schema');
