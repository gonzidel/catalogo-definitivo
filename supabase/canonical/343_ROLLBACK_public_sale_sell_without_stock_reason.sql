-- 343_ROLLBACK_public_sale_sell_without_stock_reason.sql
--
-- Revierte 343_public_sale_sell_without_stock_reason.sql:
--   1) Restaura rpc_create_public_sale (5 args) a la version pre-343 (sin
--      persistir sell_without_stock / sell_without_stock_reason).
--   2) Restaura las vistas 341 a su version pre-343 (solo heuristica, sin
--      motivo/admin agregados).
--   3) Elimina las columnas sell_without_stock / sell_without_stock_reason de
--      public_sale_items (PERDIDA DE DATOS: cualquier motivo cargado desde
--      que se aplico 343 se pierde).
--
-- Usar solo si 343 causo un problema real. Confirmar antes con el equipo si
-- hay motivos cargados que valga la pena exportar antes de este rollback.

-- ============================================================================
-- 1) rpc_create_public_sale (5 args) — version pre-343 (identica a la que
--    corria en produccion antes de esta migracion).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.rpc_create_public_sale(
  p_items jsonb,
  p_customer_id uuid DEFAULT NULL::uuid,
  p_notes text DEFAULT NULL::text,
  p_apply_credit boolean DEFAULT true,
  p_total_amount numeric DEFAULT NULL::numeric
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_user_id uuid;
  v_sale_id uuid;
  v_sale_number text;
  v_total_amount numeric(15,2) := 0;
  v_item_count int := 0;
  v_credit_used numeric(15,2) := 0;
  v_total_credit numeric(15,2) := 0;
  v_item jsonb;
  v_variant_id uuid;
  v_qty int;
  v_price numeric(15,2);
  v_is_return boolean;
  v_is_special_extra boolean;
  v_product_name text;
  v_stock_data jsonb;
  v_general_stock int;
  v_venta_publico_stock int;
  v_remaining_credit numeric(15,2);
  v_credit_record record;
  v_qty_venta_publico int;
  v_qty_general int;
  v_calculated_subtotal numeric(15,2);
  v_size text;
  v_general_warehouse_id uuid;
  v_venta_publico_warehouse_id uuid;
  v_size_stock_general int;
  v_size_stock_venta_publico int;
  v_normalized_size text;
  v_has_size_model boolean;
  v_return_rows int;
  v_size_row record;
  v_line_idx int := 0;
  v_persist_vp int;
  v_persist_g int;
  v_ins_vp int;
  v_ins_g int;
  v_ins_snap text;
  v_sold_size_snap text;
  v_ord bigint;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Usuario no autenticado';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = v_user_id) THEN
    RAISE EXCEPTION 'No tienes permiso para realizar ventas';
  END IF;

  SELECT id INTO v_general_warehouse_id FROM public.warehouses WHERE code = 'general' LIMIT 1;
  SELECT id INTO v_venta_publico_warehouse_id FROM public.warehouses WHERE code = 'venta-publico' LIMIT 1;

  v_sale_number := public.generate_sale_number();

  IF p_customer_id IS NOT NULL AND p_apply_credit THEN
    SELECT public.rpc_get_customer_total_credit(p_customer_id) INTO v_total_credit;
  END IF;

  DROP TABLE IF EXISTS tmp_psi_deduction;
  CREATE TEMP TABLE tmp_psi_deduction (
    idx int PRIMARY KEY,
    qty_venta_publico int,
    qty_general int,
    sold_size_normalized text NULL
  );
  v_line_idx := 0;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_is_special_extra := COALESCE((v_item->>'is_special_extra')::boolean, false);
    v_product_name := v_item->>'product_name';

    IF v_is_special_extra OR (v_item->>'variant_id') IS NULL OR (v_item->>'variant_id') = 'null' OR (v_item->>'variant_id') = '' THEN
      v_qty := COALESCE((v_item->>'qty')::int, 1);
      v_price := (v_item->>'price')::numeric(15,2);
      v_is_return := COALESCE((v_item->>'is_return')::boolean, false);

      IF v_is_return THEN
        v_total_amount := v_total_amount - (v_price * v_qty);
      ELSE
        v_total_amount := v_total_amount + (v_price * v_qty);
      END IF;
      v_item_count := v_item_count + 1;

      v_line_idx := v_line_idx + 1;
      INSERT INTO tmp_psi_deduction (idx, qty_venta_publico, qty_general, sold_size_normalized)
      VALUES (v_line_idx, NULL, NULL, NULL);

      CONTINUE;
    END IF;

    v_variant_id := (v_item->>'variant_id')::uuid;
    v_qty := (v_item->>'qty')::int;
    v_price := (v_item->>'price')::numeric(15,2);
    v_is_return := COALESCE((v_item->>'is_return')::boolean, false);
    v_qty_venta_publico := 0;
    v_qty_general := 0;
        v_size := NULL;
        v_normalized_size := NULL;
        IF v_item->>'size' IS NOT NULL AND v_item->>'size' != '' AND v_item->>'size' != 'null' THEN
          v_size := TRIM((v_item->>'size')::text);
          v_normalized_size := TRIM(v_size);
          IF v_normalized_size ~ '^\d+(\.\d+)?$' THEN
            v_normalized_size := SPLIT_PART(v_normalized_size, '.', 1);
          END IF;
        END IF;

    DECLARE
      v_from_local_order boolean := COALESCE((v_item->>'from_local_order')::boolean, false);
      v_skip_stock_deduction boolean := false;
    BEGIN
      v_skip_stock_deduction := (
        COALESCE((v_item->>'sell_without_stock')::boolean, false)
        OR (
          v_item->'source' IS NOT NULL
          AND COALESCE((v_item->'source'->>'venta_publico')::int, 0) = 0
          AND COALESCE((v_item->'source'->>'general')::int, 0) = 0
          AND v_qty > 0
        )
      );

      IF v_variant_id IS NOT NULL THEN
        PERFORM 1
        FROM public.product_variants pv
        WHERE pv.id = v_variant_id
        FOR UPDATE;
      END IF;

      IF NOT v_is_return THEN
        IF NOT v_from_local_order THEN
          IF NOT v_skip_stock_deduction THEN
          IF v_size IS NOT NULL AND v_size != '' AND v_general_warehouse_id IS NOT NULL AND v_venta_publico_warehouse_id IS NOT NULL THEN
            INSERT INTO public.variant_size_warehouse_stock (variant_id, size, warehouse_id, stock_qty)
            VALUES (v_variant_id, v_normalized_size, v_general_warehouse_id, 0)
            ON CONFLICT (variant_id, size, warehouse_id) DO NOTHING;
            INSERT INTO public.variant_size_warehouse_stock (variant_id, size, warehouse_id, stock_qty)
            VALUES (v_variant_id, v_normalized_size, v_venta_publico_warehouse_id, 0)
            ON CONFLICT (variant_id, size, warehouse_id) DO NOTHING;

            v_size_stock_general := 0;
            v_size_stock_venta_publico := 0;
            FOR v_size_row IN
              SELECT warehouse_id, stock_qty
              FROM public.variant_size_warehouse_stock
              WHERE variant_id = v_variant_id
                AND size = v_normalized_size
                AND warehouse_id IN (v_general_warehouse_id, v_venta_publico_warehouse_id)
              ORDER BY warehouse_id
              FOR UPDATE
            LOOP
              IF v_size_row.warehouse_id = v_general_warehouse_id THEN
                v_size_stock_general := COALESCE(v_size_row.stock_qty, 0);
              ELSIF v_size_row.warehouse_id = v_venta_publico_warehouse_id THEN
                v_size_stock_venta_publico := COALESCE(v_size_row.stock_qty, 0);
              END IF;
            END LOOP;

            IF v_size_stock_general = 0 AND v_size_stock_venta_publico = 0 THEN
              RAISE EXCEPTION 'No hay stock disponible para la variante % talle %', v_variant_id, v_size;
            END IF;

            IF v_qty > (v_size_stock_general + v_size_stock_venta_publico) THEN
              RAISE EXCEPTION 'Stock insuficiente para talle %. Disponible: %, Solicitado: %',
                v_size, (v_size_stock_general + v_size_stock_venta_publico), v_qty;
            END IF;

            v_qty_venta_publico := 0;
            v_qty_general := 0;

            IF v_item->'source' IS NOT NULL THEN
              v_qty_venta_publico := COALESCE((v_item->'source'->>'venta_publico')::int, 0);
              v_qty_general := COALESCE((v_item->'source'->>'general')::int, 0);

              IF (v_qty_venta_publico + v_qty_general) != v_qty THEN
                v_qty_venta_publico := 0;
                v_qty_general := 0;
              END IF;
            END IF;

            IF v_qty_venta_publico = 0 AND v_qty_general = 0 THEN
              IF v_size_stock_venta_publico > 0 THEN
                IF v_qty <= v_size_stock_venta_publico THEN
                  v_qty_venta_publico := v_qty;
                  v_qty_general := 0;
                ELSE
                  v_qty_venta_publico := v_size_stock_venta_publico;
                  v_qty_general := v_qty - v_size_stock_venta_publico;
                END IF;
              ELSE
                v_qty_venta_publico := 0;
                v_qty_general := v_qty;
              END IF;
            END IF;

            IF v_qty_venta_publico > v_size_stock_venta_publico THEN
              RAISE EXCEPTION 'Stock insuficiente en venta-publico para talle %. Disponible: %, Solicitado: %',
                v_size, v_size_stock_venta_publico, v_qty_venta_publico;
            END IF;

            IF v_qty_general > v_size_stock_general THEN
              RAISE EXCEPTION 'Stock insuficiente en general para talle %. Disponible: %, Solicitado: %',
                v_size, v_size_stock_general, v_qty_general;
            END IF;

            IF v_qty_venta_publico > 0 THEN
              INSERT INTO public.variant_size_warehouse_stock (variant_id, size, warehouse_id, stock_qty)
              VALUES (v_variant_id, v_normalized_size, v_venta_publico_warehouse_id, 0)
              ON CONFLICT (variant_id, size, warehouse_id) DO NOTHING;

              UPDATE public.variant_size_warehouse_stock
              SET stock_qty = stock_qty - v_qty_venta_publico,
                  updated_at = now()
              WHERE variant_id = v_variant_id
                AND size = v_normalized_size
                AND warehouse_id = v_venta_publico_warehouse_id;
            END IF;

            IF v_qty_general > 0 THEN
              INSERT INTO public.variant_size_warehouse_stock (variant_id, size, warehouse_id, stock_qty)
              VALUES (v_variant_id, v_normalized_size, v_general_warehouse_id, 0)
              ON CONFLICT (variant_id, size, warehouse_id) DO NOTHING;

              UPDATE public.variant_size_warehouse_stock
              SET stock_qty = stock_qty - v_qty_general,
                  updated_at = now()
              WHERE variant_id = v_variant_id
                AND size = v_normalized_size
                AND warehouse_id = v_general_warehouse_id;
            END IF;
          ELSE
            SELECT (
              EXISTS (
                SELECT 1
                FROM public.variant_size_warehouse_stock
                WHERE variant_id = v_variant_id
                LIMIT 1
              )
              OR EXISTS (
                SELECT 1
                FROM public.variant_sizes
                WHERE variant_id = v_variant_id
                  AND TRIM(COALESCE(size, '')) <> ''
                LIMIT 1
              )
            )
            INTO v_has_size_model;

            IF COALESCE(v_has_size_model, false) THEN
              RAISE EXCEPTION 'La variante % usa talles. Debes enviar size para vender.', v_variant_id;
            END IF;

            SELECT json_agg(
              json_build_object(
                'warehouse_code', warehouse_code,
                'stock', stock
              )
            ) INTO v_stock_data
            FROM (
              SELECT
                w.code AS warehouse_code,
                COALESCE(vws.stock_qty, 0) AS stock
              FROM public.warehouses w
              LEFT JOIN public.variant_warehouse_stock vws
                ON vws.warehouse_id = w.id
                AND vws.variant_id = v_variant_id
              WHERE w.code IN ('general', 'venta-publico')
              ORDER BY w.code
            ) stock_info;

            v_general_stock := 0;
            v_venta_publico_stock := 0;

            SELECT COALESCE((elem->>'stock')::int, 0) INTO v_general_stock
            FROM jsonb_array_elements(v_stock_data) elem
            WHERE (elem->>'warehouse_code') = 'general'
            LIMIT 1;

            SELECT COALESCE((elem->>'stock')::int, 0) INTO v_venta_publico_stock
            FROM jsonb_array_elements(v_stock_data) elem
            WHERE (elem->>'warehouse_code') = 'venta-publico'
            LIMIT 1;

            IF v_general_stock = 0 AND v_venta_publico_stock = 0 THEN
              RAISE EXCEPTION 'No hay stock disponible para la variante %', v_variant_id;
            END IF;

            IF v_qty > (v_general_stock + v_venta_publico_stock) THEN
              RAISE EXCEPTION 'Stock insuficiente. Disponible: %, Solicitado: %',
                (v_general_stock + v_venta_publico_stock), v_qty;
            END IF;

            v_qty_venta_publico := 0;
            v_qty_general := 0;

            IF v_item->'source' IS NOT NULL THEN
              v_qty_venta_publico := COALESCE((v_item->'source'->>'venta_publico')::int, 0);
              v_qty_general := COALESCE((v_item->'source'->>'general')::int, 0);

              IF (v_qty_venta_publico + v_qty_general) != v_qty THEN
                v_qty_venta_publico := 0;
                v_qty_general := 0;
              END IF;
            END IF;

            IF v_qty_venta_publico = 0 AND v_qty_general = 0 THEN
              IF v_venta_publico_stock > 0 THEN
                IF v_qty <= v_venta_publico_stock THEN
                  v_qty_venta_publico := v_qty;
                  v_qty_general := 0;
                ELSE
                  v_qty_venta_publico := v_venta_publico_stock;
                  v_qty_general := v_qty - v_venta_publico_stock;
                END IF;
              ELSE
                v_qty_venta_publico := 0;
                v_qty_general := v_qty;
              END IF;
            END IF;

            IF v_qty_venta_publico > v_venta_publico_stock THEN
              RAISE EXCEPTION 'Stock insuficiente en venta-publico. Disponible: %, Solicitado: %',
                v_venta_publico_stock, v_qty_venta_publico;
            END IF;

            IF v_qty_general > v_general_stock THEN
              RAISE EXCEPTION 'Stock insuficiente en general. Disponible: %, Solicitado: %',
                v_general_stock, v_qty_general;
            END IF;

            IF v_qty_venta_publico > 0 THEN
              UPDATE public.variant_warehouse_stock
              SET stock_qty = stock_qty - v_qty_venta_publico,
                  updated_at = now()
              WHERE variant_id = v_variant_id
                AND warehouse_id = v_venta_publico_warehouse_id;
            END IF;

            IF v_qty_general > 0 THEN
              UPDATE public.variant_warehouse_stock
              SET stock_qty = stock_qty - v_qty_general,
                  updated_at = now()
              WHERE variant_id = v_variant_id
                AND warehouse_id = v_general_warehouse_id;
            END IF;
          END IF;
          END IF;
        END IF;
      ELSE
        IF v_size IS NOT NULL AND TRIM(v_size) != '' AND v_venta_publico_warehouse_id IS NOT NULL THEN
          v_normalized_size := TRIM(v_size::text);
          IF v_normalized_size ~ '^\d+(\.\d+)?$' THEN
            v_normalized_size := SPLIT_PART(v_normalized_size, '.', 1);
          END IF;

          INSERT INTO public.variant_size_warehouse_stock (variant_id, warehouse_id, size, stock_qty)
          VALUES (
            v_variant_id,
            v_venta_publico_warehouse_id,
            v_normalized_size,
            0
          )
          ON CONFLICT (variant_id, warehouse_id, size) DO NOTHING;

          PERFORM 1
          FROM public.variant_size_warehouse_stock
          WHERE variant_id = v_variant_id
            AND size = v_normalized_size
            AND warehouse_id = v_venta_publico_warehouse_id
          FOR UPDATE;

          UPDATE public.variant_size_warehouse_stock
          SET stock_qty = stock_qty + v_qty,
              updated_at = now()
          WHERE variant_id = v_variant_id
            AND size = v_normalized_size
            AND warehouse_id = v_venta_publico_warehouse_id;

          RAISE NOTICE 'Devolución procesada: variant_id=%, size=%, qty=%, warehouse=venta-publico',
            v_variant_id, v_normalized_size, v_qty;
        ELSE
          SELECT (
            EXISTS (
              SELECT 1
              FROM public.variant_size_warehouse_stock
              WHERE variant_id = v_variant_id
              LIMIT 1
            )
            OR EXISTS (
              SELECT 1
              FROM public.variant_sizes
              WHERE variant_id = v_variant_id
                AND TRIM(COALESCE(size, '')) <> ''
              LIMIT 1
            )
          )
          INTO v_has_size_model;

          IF COALESCE(v_has_size_model, false) THEN
            RAISE EXCEPTION 'La variante % usa talles. Debes enviar size para devolución.', v_variant_id;
          END IF;

          UPDATE public.variant_warehouse_stock
          SET stock_qty = stock_qty + v_qty,
              updated_at = now()
          WHERE variant_id = v_variant_id
            AND warehouse_id = v_venta_publico_warehouse_id;
          GET DIAGNOSTICS v_return_rows = ROW_COUNT;

          IF v_return_rows = 0 THEN
            INSERT INTO public.variant_warehouse_stock (variant_id, warehouse_id, stock_qty)
            VALUES (
              v_variant_id,
              v_venta_publico_warehouse_id,
              v_qty
            );
          END IF;
        END IF;
      END IF;

      IF v_is_return THEN
        v_total_amount := v_total_amount - (v_price * v_qty);
      ELSE
        v_total_amount := v_total_amount + (v_price * v_qty);
      END IF;
      v_item_count := v_item_count + 1;

      IF v_is_return THEN
        v_persist_vp := v_qty;
        v_persist_g := 0;
      ELSIF v_from_local_order THEN
        v_persist_vp := 0;
        v_persist_g := 0;
        IF v_item->'source' IS NOT NULL THEN
          v_persist_vp := GREATEST(0, COALESCE((v_item->'source'->>'venta_publico')::int, 0));
          v_persist_g := GREATEST(0, COALESCE((v_item->'source'->>'general')::int, 0));
        END IF;
        IF (v_persist_vp + v_persist_g) <> v_qty THEN
          v_persist_vp := v_qty;
          v_persist_g := 0;
        END IF;
      ELSIF v_skip_stock_deduction THEN
        v_persist_vp := 0;
        v_persist_g := 0;
      ELSE
        v_persist_vp := v_qty_venta_publico;
        v_persist_g := v_qty_general;
      END IF;

      v_sold_size_snap := NULL;
      IF v_is_return THEN
        IF v_size IS NOT NULL AND TRIM(v_size) != '' AND v_venta_publico_warehouse_id IS NOT NULL THEN
          v_sold_size_snap := v_normalized_size;
        END IF;
      ELSIF v_from_local_order OR v_skip_stock_deduction THEN
        IF v_size IS NOT NULL AND v_size != '' THEN
          v_sold_size_snap := v_normalized_size;
        END IF;
      ELSE
        IF v_size IS NOT NULL AND v_size != '' AND v_general_warehouse_id IS NOT NULL AND v_venta_publico_warehouse_id IS NOT NULL THEN
          v_sold_size_snap := v_normalized_size;
        END IF;
      END IF;

      v_line_idx := v_line_idx + 1;
      INSERT INTO tmp_psi_deduction (idx, qty_venta_publico, qty_general, sold_size_normalized)
      VALUES (v_line_idx, v_persist_vp, v_persist_g, v_sold_size_snap);
    END;
  END LOOP;

  IF p_total_amount IS NOT NULL THEN
    v_calculated_subtotal := 0;
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
      v_is_special_extra := COALESCE((v_item->>'is_special_extra')::boolean, false);

      IF v_is_special_extra OR (v_item->>'variant_id') IS NULL OR (v_item->>'variant_id') = 'null' OR (v_item->>'variant_id') = '' THEN
        v_qty := COALESCE((v_item->>'qty')::int, 1);
        v_price := (v_item->>'price')::numeric(15,2);
        v_is_return := COALESCE((v_item->>'is_return')::boolean, false);

        IF v_is_return THEN
          v_calculated_subtotal := v_calculated_subtotal - (v_price * v_qty);
        ELSE
          v_calculated_subtotal := v_calculated_subtotal + (v_price * v_qty);
        END IF;
      ELSE
        v_variant_id := (v_item->>'variant_id')::uuid;
        v_qty := (v_item->>'qty')::int;
        v_price := (v_item->>'price')::numeric(15,2);
        v_is_return := COALESCE((v_item->>'is_return')::boolean, false);

        IF v_is_return THEN
          v_calculated_subtotal := v_calculated_subtotal - (v_price * v_qty);
        ELSE
          v_calculated_subtotal := v_calculated_subtotal + (v_price * v_qty);
        END IF;
      END IF;
    END LOOP;

    IF v_total_credit > 0 AND p_apply_credit AND v_calculated_subtotal > p_total_amount THEN
      v_credit_used := LEAST(v_calculated_subtotal - p_total_amount, v_total_credit);
    END IF;

    v_total_amount := p_total_amount;

    IF v_credit_used > 0 THEN
      v_remaining_credit := v_credit_used;
      FOR v_credit_record IN
        SELECT id, amount
        FROM public.public_sales_customer_credits
        WHERE customer_id = p_customer_id
          AND expires_at > now()
          AND amount > 0
        ORDER BY expires_at ASC
      LOOP
        IF v_remaining_credit <= 0 THEN
          EXIT;
        END IF;

        IF v_credit_record.amount <= v_remaining_credit THEN
          UPDATE public.public_sales_customer_credits
          SET amount = 0
          WHERE id = v_credit_record.id;
          v_remaining_credit := v_remaining_credit - v_credit_record.amount;
        ELSE
          UPDATE public.public_sales_customer_credits
          SET amount = amount - v_remaining_credit
          WHERE id = v_credit_record.id;
          v_remaining_credit := 0;
        END IF;
      END LOOP;
    END IF;
  ELSE
    IF v_total_credit > 0 AND p_apply_credit AND v_total_amount > 0 THEN
      IF v_total_credit >= v_total_amount THEN
        v_credit_used := v_total_amount;
        v_total_amount := 0;
      ELSE
        v_credit_used := v_total_credit;
        v_total_amount := v_total_amount - v_credit_used;
      END IF;

      v_remaining_credit := v_credit_used;
      FOR v_credit_record IN
        SELECT id, amount
        FROM public.public_sales_customer_credits
        WHERE customer_id = p_customer_id
          AND expires_at > now()
          AND amount > 0
        ORDER BY expires_at ASC
      LOOP
        IF v_remaining_credit <= 0 THEN
          EXIT;
        END IF;

        IF v_credit_record.amount <= v_remaining_credit THEN
          UPDATE public.public_sales_customer_credits
          SET amount = 0
          WHERE id = v_credit_record.id;
          v_remaining_credit := v_remaining_credit - v_credit_record.amount;
        ELSE
          UPDATE public.public_sales_customer_credits
          SET amount = amount - v_remaining_credit
          WHERE id = v_credit_record.id;
          v_remaining_credit := 0;
        END IF;
      END LOOP;
    END IF;
  END IF;

  INSERT INTO public.public_sales (
    sale_number,
    sold_by,
    customer_id,
    total_amount,
    item_count,
    credit_used,
    notes
  )
  VALUES (
    v_sale_number,
    v_user_id,
    p_customer_id,
    v_total_amount,
    v_item_count,
    v_credit_used,
    p_notes
  )
  RETURNING id INTO v_sale_id;

  FOR v_item, v_ord IN
    SELECT elem, ord FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(elem, ord)
  LOOP
    SELECT d.qty_venta_publico, d.qty_general, d.sold_size_normalized INTO v_ins_vp, v_ins_g, v_ins_snap
    FROM tmp_psi_deduction d
    WHERE d.idx = v_ord::int;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'tmp_psi_deduction desalineado con p_items (falta idx %)', v_ord;
    END IF;

    v_is_special_extra := COALESCE((v_item->>'is_special_extra')::boolean, false);
    v_product_name := v_item->>'product_name';

    IF v_is_special_extra OR (v_item->>'variant_id') IS NULL OR (v_item->>'variant_id') = 'null' OR (v_item->>'variant_id') = '' THEN
      INSERT INTO public.public_sale_items (
        sale_id,
        variant_id,
        product_name,
        qty,
        price_snapshot,
        is_return,
        qty_venta_publico,
        qty_general,
        sold_size_normalized
      )
      VALUES (
        v_sale_id,
        NULL,
        COALESCE(v_product_name, 'Extra especial'),
        COALESCE((v_item->>'qty')::int, 1),
        (v_item->>'price')::numeric(15,2),
        COALESCE((v_item->>'is_return')::boolean, false),
        v_ins_vp,
        v_ins_g,
        v_ins_snap
      );
    ELSE
      INSERT INTO public.public_sale_items (
        sale_id,
        variant_id,
        qty,
        price_snapshot,
        is_return,
        qty_venta_publico,
        qty_general,
        sold_size_normalized
      )
      VALUES (
        v_sale_id,
        (v_item->>'variant_id')::uuid,
        (v_item->>'qty')::int,
        (v_item->>'price')::numeric(15,2),
        COALESCE((v_item->>'is_return')::boolean, false),
        v_ins_vp,
        v_ins_g,
        v_ins_snap
      );
    END IF;
  END LOOP;

  RETURN json_build_object(
    'success', true,
    'sale_id', v_sale_id,
    'sale_number', v_sale_number,
    'total_amount', v_total_amount,
    'credit_used', v_credit_used,
    'item_count', v_item_count
  );
END $function$;

-- ============================================================================
-- 2) Vistas 341 — version pre-343 (solo heuristica, sin motivo/admin agregados)
-- ============================================================================
CREATE OR REPLACE VIEW public.vw_stock_audit_untracked_sales AS
SELECT
  'public_sale_sin_stock'::text AS source_type,
  psi.created_at AS event_at,
  pv.product_id,
  COALESCE(p.name, psi.product_name) AS product_name,
  psi.variant_id,
  pv.color AS variant_color,
  pv.sku AS variant_sku,
  NULLIF(TRIM(COALESCE(psi.sold_size_normalized::text, '')), '') AS size,
  psi.qty,
  psi.sale_id AS reference_id,
  ps.sold_by AS admin_user_id,
  'sell_without_stock: venta publica confirmada sin descuento en variant_size_warehouse_stock (sistema ya mostraba 0/0 en ese talle)'::text AS reason
FROM public.public_sale_items psi
JOIN public.public_sales ps ON ps.id = psi.sale_id
LEFT JOIN public.product_variants pv ON pv.id = psi.variant_id
LEFT JOIN public.products p ON p.id = pv.product_id
WHERE psi.variant_id IS NOT NULL
  AND COALESCE(psi.is_return, false) = false
  AND ps.voided_at IS NULL
  AND psi.qty_venta_publico IS NOT NULL
  AND psi.qty_general IS NOT NULL
  AND psi.qty_venta_publico = 0
  AND psi.qty_general = 0

UNION ALL

SELECT
  'admin_order_confirmado_sin_verificar'::text AS source_type,
  oi.created_at AS event_at,
  pv.product_id,
  oi.product_name,
  oi.variant_id,
  oi.color AS variant_color,
  pv.sku AS variant_sku,
  NULLIF(TRIM(COALESCE(oi.size::text, '')), '') AS size,
  oi.quantity AS qty,
  oi.order_id AS reference_id,
  o.created_by_user_id AS admin_user_id,
  'admin_confirmed_missing: pedido admin marcado apartado por confirmacion manual (neto stock = 0 via rpc_admin_manual_inject_and_deduct), sin verificacion del sistema'::text AS reason
FROM public.order_items oi
JOIN public.orders o ON o.id = oi.order_id
LEFT JOIN public.product_variants pv ON pv.id = oi.variant_id
WHERE oi.variant_id IS NOT NULL
  AND COALESCE(oi.admin_confirmed_missing, false) = true
  AND oi.status IN ('picked', 'missing')
  AND NULLIF(TRIM(COALESCE(oi.size::text, '')), '') IS NOT NULL;

COMMENT ON VIEW public.vw_stock_audit_untracked_sales IS
  '341: eventos donde se vendio/aparto un talle sin descontar realmente variant_size_warehouse_stock (venta publica sell_without_stock o alta admin admin_confirmed_missing). Cada fila es candidata a generar overselling online si el conteo previo ya estaba inflado.';

CREATE OR REPLACE VIEW public.vw_stock_audit_untracked_sales_watchlist AS
SELECT
  variant_id,
  product_name,
  variant_color,
  variant_sku,
  size,
  count(*)::int AS untracked_events_30d,
  sum(qty)::int AS untracked_qty_30d,
  max(event_at) AS last_event_at,
  array_agg(DISTINCT source_type) AS source_types
FROM public.vw_stock_audit_untracked_sales
WHERE event_at >= now() - interval '30 days'
GROUP BY variant_id, product_name, variant_color, variant_sku, size
ORDER BY last_event_at DESC;

COMMENT ON VIEW public.vw_stock_audit_untracked_sales_watchlist IS
  '341: agregado por variante+talle de eventos "sin descuento real de stock" en los ultimos 30 dias. Priorizar conteo fisico de estos talles antes de que el catalogo online los venda como disponibles.';

GRANT SELECT ON public.vw_stock_audit_untracked_sales TO authenticated;
GRANT SELECT ON public.vw_stock_audit_untracked_sales_watchlist TO authenticated;

-- ============================================================================
-- 3) Columnas — eliminar (PERDIDA DE DATOS de motivos cargados desde 343)
-- ============================================================================
ALTER TABLE public.public_sale_items
  DROP COLUMN IF EXISTS sell_without_stock,
  DROP COLUMN IF EXISTS sell_without_stock_reason;

SELECT pg_notify('pgrst', 'reload schema');
