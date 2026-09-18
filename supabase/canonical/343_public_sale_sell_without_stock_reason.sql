-- 343_public_sale_sell_without_stock_reason.sql
--
-- Opción C del audit de stock fantasma (2026-09-14): hoy, cuando un vendedor
-- confirma "agregar sin stock" en admin/public-sales.js, la venta se registra
-- SIN dejar ningún rastro explícito de que eso pasó ni por qué. La única forma
-- de detectarlo después es la heurística de la vista 341
-- (qty_venta_publico = 0 AND qty_general = 0 con qty > 0), que funciona pero
-- no dice el motivo ni permite un texto libre.
--
-- Este cambio es puramente ADITIVO:
--   1) Agrega 2 columnas nuevas a public_sale_items (sell_without_stock,
--      sell_without_stock_reason). Default false / NULL, no rompe filas viejas.
--   2) rpc_create_public_sale (firma de 5 args, la que corre hoy en producción)
--      persiste esas 2 columnas por línea. NO SE TOCA ninguna validación ni
--      ninguna cantidad de descuento/reposición de stock: el flujo de
--      v_skip_stock_deduction (quién descuenta cuánto de qué depósito) queda
--      carácter por carácter igual que antes.
--   3) admin/public-sales.js manda opcionalmente `sell_without_stock_reason`
--      en el payload del item cuando el vendedor escribe un motivo (campo
--      opcional, no bloquea la venta si se deja vacío).
--   4) La vista 341 (vw_stock_audit_untracked_sales) pasa a usar el flag
--      explícito OR la heurística vieja (retrocompatible con ventas previas a
--      esta migración), y muestra el motivo real cuando existe.
--   5) La watchlist agregada (vw_stock_audit_untracked_sales_watchlist) suma
--      quién fue el último admin que confirmó "sin stock" y su último motivo,
--      para que la tarjeta de admin/stock-audit.html pueda mostrar
--      qué + cuándo + quién + por qué en un solo lugar.
--
-- Riesgo: BAJO. No cambia disponibilidad del catálogo, no cambia montos de
-- venta, no cambia qué se descuenta de qué depósito. Solo agrega columnas y
-- las persiste; el resto de rpc_create_public_sale es copia exacta de la
-- versión vigente en producción (verificada vía pg_get_functiondef antes de
-- escribir este archivo).
-- Rollback: 343_ROLLBACK_public_sale_sell_without_stock_reason.sql

-- ============================================================================
-- 1) Columnas nuevas (aditivas)
-- ============================================================================
ALTER TABLE public.public_sale_items
  ADD COLUMN IF NOT EXISTS sell_without_stock boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sell_without_stock_reason text NULL;

COMMENT ON COLUMN public.public_sale_items.sell_without_stock IS
  '343: true si el vendedor confirmo "agregar sin stock" en admin/public-sales.js (no hubo descuento real en variant_size_warehouse_stock para esta linea).';
COMMENT ON COLUMN public.public_sale_items.sell_without_stock_reason IS
  '343: motivo opcional escrito por el vendedor al confirmar "agregar sin stock" (ej. conteo desactualizado, prenda extra en el local). Puede ser NULL.';

-- ============================================================================
-- 2) rpc_create_public_sale (5 args) — copia exacta de la version vigente en
--    produccion + persistencia de sell_without_stock / sell_without_stock_reason.
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
  -- 343: nuevas variables para persistir motivo/flag de "sin stock"
  v_ins_sws boolean;
  v_ins_sws_reason text;
BEGIN
  -- Obtener usuario actual
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Usuario no autenticado';
  END IF;

  -- Validar que sea admin
  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = v_user_id) THEN
    RAISE EXCEPTION 'No tienes permiso para realizar ventas';
  END IF;

  -- Obtener IDs de warehouses una sola vez
  SELECT id INTO v_general_warehouse_id FROM public.warehouses WHERE code = 'general' LIMIT 1;
  SELECT id INTO v_venta_publico_warehouse_id FROM public.warehouses WHERE code = 'venta-publico' LIMIT 1;

  -- Generar número de venta
  v_sale_number := public.generate_sale_number();

  -- Calcular crédito disponible si hay cliente
  IF p_customer_id IS NOT NULL AND p_apply_credit THEN
    SELECT public.rpc_get_customer_total_credit(p_customer_id) INTO v_total_credit;
  END IF;

  DROP TABLE IF EXISTS tmp_psi_deduction;
  CREATE TEMP TABLE tmp_psi_deduction (
    idx int PRIMARY KEY,
    qty_venta_publico int,
    qty_general int,
    sold_size_normalized text NULL,
    sell_without_stock boolean NOT NULL DEFAULT false,
    sell_without_stock_reason text NULL
  );
  v_line_idx := 0;

  -- Procesar items y calcular total
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    -- Detectar si es un extra especial (sin variant_id)
    v_is_special_extra := COALESCE((v_item->>'is_special_extra')::boolean, false);
    v_product_name := v_item->>'product_name';

    -- Si es extra especial, procesar de forma diferente (solo contar y sumar al total, no descontar stock)
    IF v_is_special_extra OR (v_item->>'variant_id') IS NULL OR (v_item->>'variant_id') = 'null' OR (v_item->>'variant_id') = '' THEN
      v_qty := COALESCE((v_item->>'qty')::int, 1);
      v_price := (v_item->>'price')::numeric(15,2);
      v_is_return := COALESCE((v_item->>'is_return')::boolean, false);

      -- Sumar al total
      IF v_is_return THEN
        v_total_amount := v_total_amount - (v_price * v_qty);
      ELSE
        v_total_amount := v_total_amount + (v_price * v_qty);
      END IF;
      v_item_count := v_item_count + 1;

      v_line_idx := v_line_idx + 1;
      INSERT INTO tmp_psi_deduction (idx, qty_venta_publico, qty_general, sold_size_normalized, sell_without_stock, sell_without_stock_reason)
      VALUES (v_line_idx, NULL, NULL, NULL, false, NULL);

      -- Continuar al siguiente item sin procesar stock
      CONTINUE;
    END IF;

    -- Procesar item normal con variant_id
    v_variant_id := (v_item->>'variant_id')::uuid;
    v_qty := (v_item->>'qty')::int;
    v_price := (v_item->>'price')::numeric(15,2);
    v_is_return := COALESCE((v_item->>'is_return')::boolean, false);
    v_qty_venta_publico := 0;
    v_qty_general := 0;
        -- Obtener tamaño si está disponible (convertir a string y normalizar)
        v_size := NULL;
        v_normalized_size := NULL;
        IF v_item->>'size' IS NOT NULL AND v_item->>'size' != '' AND v_item->>'size' != 'null' THEN
          v_size := TRIM((v_item->>'size')::text);
          -- Normalizar tamaño (similar a normalizeSize en JavaScript)
          -- Remover espacios y truncar decimales si es número
          v_normalized_size := TRIM(v_size);
          -- Si es un número, truncar decimales
          IF v_normalized_size ~ '^\d+(\.\d+)?$' THEN
            v_normalized_size := SPLIT_PART(v_normalized_size, '.', 1);
          END IF;
        END IF;

    DECLARE
      v_from_local_order boolean := COALESCE((v_item->>'from_local_order')::boolean, false);
      -- Usuario confirmó "agregar sin stock" (frontend envía source venta_publico=0 y general=0 con qty>0)
      v_skip_stock_deduction boolean := false;
      -- 343: motivo opcional escrito por el vendedor al confirmar "sin stock"
      v_reason text := NULL;
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

      IF v_skip_stock_deduction THEN
        v_reason := NULLIF(TRIM(COALESCE(v_item->>'sell_without_stock_reason', '')), '');
      END IF;

      IF v_variant_id IS NOT NULL THEN
        PERFORM 1
        FROM public.product_variants pv
        WHERE pv.id = v_variant_id
        FOR UPDATE;
      END IF;

      IF NOT v_is_return THEN
        -- Si el item viene de un pedido local, el stock ya fue descontado
        IF NOT v_from_local_order THEN
          IF NOT v_skip_stock_deduction THEN
          -- Si hay tamaño específico, usar variant_size_warehouse_stock
          IF v_size IS NOT NULL AND v_size != '' AND v_general_warehouse_id IS NOT NULL AND v_venta_publico_warehouse_id IS NOT NULL THEN
            -- Validar y descontar stock por talle desde variant_size_warehouse_stock
            -- Usar tamaño normalizado para la búsqueda con lock explícito de filas objetivo
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

            -- Obtener fuente del stock desde el item
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

            -- Si no se especificó fuente, usar lógica automática (priorizar venta-publico)
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

            -- Validar stock en cada almacén
            IF v_qty_venta_publico > v_size_stock_venta_publico THEN
              RAISE EXCEPTION 'Stock insuficiente en venta-publico para talle %. Disponible: %, Solicitado: %',
                v_size, v_size_stock_venta_publico, v_qty_venta_publico;
            END IF;

            IF v_qty_general > v_size_stock_general THEN
              RAISE EXCEPTION 'Stock insuficiente en general para talle %. Disponible: %, Solicitado: %',
                v_size, v_size_stock_general, v_qty_general;
            END IF;

            -- Descontar del almacén correspondiente por talle
            -- Usar tamaño normalizado para actualizar
            IF v_qty_venta_publico > 0 THEN
              -- Asegurar que existe el registro antes de actualizar
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
              -- Stock normal desde variant_size_warehouse_stock, solo actualizar
              -- Asegurar que existe el registro antes de actualizar
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
            -- Sin tamaño específico, usar variant_warehouse_stock solo si la variante no usa talles
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

            -- Comportamiento legacy sin talle
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

            -- Obtener stock de cada almacén
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

            -- Obtener fuente del stock desde el item
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

            -- Si no se especificó fuente, usar lógica automática
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

            -- Validar stock en cada almacén
            IF v_qty_venta_publico > v_venta_publico_stock THEN
              RAISE EXCEPTION 'Stock insuficiente en venta-publico. Disponible: %, Solicitado: %',
                v_venta_publico_stock, v_qty_venta_publico;
            END IF;

            IF v_qty_general > v_general_stock THEN
              RAISE EXCEPTION 'Stock insuficiente en general. Disponible: %, Solicitado: %',
                v_general_stock, v_qty_general;
            END IF;

            -- Descontar del almacén correspondiente (legacy)
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
          END IF; -- Fin de IF v_size IS NOT NULL
          END IF; -- v_skip_stock_deduction: no validar ni descontar
        END IF; -- Cerrar bloque "if not v_from_local_order"
      ELSE
        -- Es devolución: sumar stock SOLO a venta-publico (nunca tocar general)
        IF v_size IS NOT NULL AND TRIM(v_size) != '' AND v_venta_publico_warehouse_id IS NOT NULL THEN
          -- Devolución con tamaño específico: UPDATE solo fila venta-publico, INSERT si no existe
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

          -- Devolución sin tamaño específico (legacy): UPDATE solo venta-publico, INSERT si no existe
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
      END IF; -- Cerrar bloque "if not v_is_return"

      -- Calcular total: sumar ventas, restar devoluciones
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
        -- Aunque el stock ya fue descontado antes (pedido local),
        -- necesitamos persistir la fuente para que rpc_void_public_sale
        -- pueda devolver correctamente al anular.
        v_persist_vp := 0;
        v_persist_g := 0;
        IF v_item->'source' IS NOT NULL THEN
          v_persist_vp := GREATEST(0, COALESCE((v_item->'source'->>'venta_publico')::int, 0));
          v_persist_g := GREATEST(0, COALESCE((v_item->'source'->>'general')::int, 0));
        END IF;
        -- Fallback defensivo: si no viene source o viene inconsistente, asumir venta-publico.
        IF (v_persist_vp + v_persist_g) <> v_qty THEN
          v_persist_vp := v_qty;
          v_persist_g := 0;
        END IF;
      ELSIF v_skip_stock_deduction THEN
        -- Venta confirmada sin stock: no hubo descuento real, tampoco debe haber reposición en void.
        v_persist_vp := 0;
        v_persist_g := 0;
      ELSE
        v_persist_vp := v_qty_venta_publico;
        v_persist_g := v_qty_general;
      END IF;

      -- Talle persistido = el normalizado usado en ramas por talle (alinear void con create)
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
      INSERT INTO tmp_psi_deduction (idx, qty_venta_publico, qty_general, sold_size_normalized, sell_without_stock, sell_without_stock_reason)
      VALUES (v_line_idx, v_persist_vp, v_persist_g, v_sold_size_snap, v_skip_stock_deduction, v_reason);
    END; -- Cerrar bloque "declare"
  END LOOP;

  -- Si se proporciona p_total_amount, usarlo (incluye extras y crédito calculados en el frontend)
  IF p_total_amount IS NOT NULL THEN
    -- Calcular subtotal desde items (incluyendo extras especiales) para determinar crédito usado
    v_calculated_subtotal := 0;
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
      -- Detectar si es extra especial
      v_is_special_extra := COALESCE((v_item->>'is_special_extra')::boolean, false);

      -- Si es extra especial o no tiene variant_id, incluir en el subtotal
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
        -- Item normal con variant_id
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

    -- Si hay crédito disponible y el subtotal es mayor que el total proporcionado, calcular crédito usado
    -- El total proporcionado ya incluye extras y crédito aplicado
    IF v_total_credit > 0 AND p_apply_credit AND v_calculated_subtotal > p_total_amount THEN
      v_credit_used := LEAST(v_calculated_subtotal - p_total_amount, v_total_credit);
    END IF;

    -- Usar el total proporcionado (ya incluye extras y crédito)
    v_total_amount := p_total_amount;

    -- Descontar créditos usados (FIFO) si se usó crédito
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
    -- Aplicar crédito si existe y se solicita (solo si NO se proporcionó p_total_amount)
    IF v_total_credit > 0 AND p_apply_credit AND v_total_amount > 0 THEN
      IF v_total_credit >= v_total_amount THEN
        v_credit_used := v_total_amount;
        v_total_amount := 0;
      ELSE
        v_credit_used := v_total_credit;
        v_total_amount := v_total_amount - v_credit_used;
      END IF;

      -- Descontar créditos usados (FIFO)
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

  -- Crear registro de venta
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

  -- Crear items de venta (alineado con tmp_psi_deduction por orden)
  FOR v_item, v_ord IN
    SELECT elem, ord FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(elem, ord)
  LOOP
    SELECT d.qty_venta_publico, d.qty_general, d.sold_size_normalized, d.sell_without_stock, d.sell_without_stock_reason
    INTO v_ins_vp, v_ins_g, v_ins_snap, v_ins_sws, v_ins_sws_reason
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
        sold_size_normalized,
        sell_without_stock,
        sell_without_stock_reason
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
        v_ins_snap,
        v_ins_sws,
        v_ins_sws_reason
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
        sold_size_normalized,
        sell_without_stock,
        sell_without_stock_reason
      )
      VALUES (
        v_sale_id,
        (v_item->>'variant_id')::uuid,
        (v_item->>'qty')::int,
        (v_item->>'price')::numeric(15,2),
        COALESCE((v_item->>'is_return')::boolean, false),
        v_ins_vp,
        v_ins_g,
        v_ins_snap,
        v_ins_sws,
        v_ins_sws_reason
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

COMMENT ON FUNCTION public.rpc_create_public_sale(jsonb, uuid, text, boolean, numeric) IS
  '343: igual a la version anterior + persiste sell_without_stock / sell_without_stock_reason por linea en public_sale_items. No cambia ninguna validacion ni cantidad de descuento de stock.';

-- ============================================================================
-- 3) Vista 341 actualizada: usa el flag explicito (nuevo) OR la heuristica
--    vieja (retrocompatible con ventas anteriores a esta migracion), y expone
--    el motivo real cuando el vendedor lo escribio.
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
  COALESCE(
    NULLIF(TRIM(COALESCE(psi.sell_without_stock_reason, '')), ''),
    'sell_without_stock: venta publica confirmada sin descuento en variant_size_warehouse_stock (sistema ya mostraba 0/0 en ese talle)'
  )::text AS reason
FROM public.public_sale_items psi
JOIN public.public_sales ps ON ps.id = psi.sale_id
LEFT JOIN public.product_variants pv ON pv.id = psi.variant_id
LEFT JOIN public.products p ON p.id = pv.product_id
WHERE psi.variant_id IS NOT NULL
  AND COALESCE(psi.is_return, false) = false
  AND ps.voided_at IS NULL
  AND (
    psi.sell_without_stock = true
    OR (
      psi.qty_venta_publico IS NOT NULL
      AND psi.qty_general IS NOT NULL
      AND psi.qty_venta_publico = 0
      AND psi.qty_general = 0
    )
  )

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
  '343: igual a 341 + usa el flag explicito sell_without_stock (persistido desde esta migracion) ademas de la heuristica vieja (retrocompatible), y muestra el motivo real escrito por el vendedor cuando existe.';

-- ============================================================================
-- 4) Watchlist agregada: suma quien fue el ultimo admin que confirmo "sin
--    stock" para ese variante+talle y su ultimo motivo, para que la tarjeta
--    de admin/stock-audit.html pueda mostrar que + cuando + quien + por que.
-- ============================================================================
CREATE OR REPLACE VIEW public.vw_stock_audit_untracked_sales_watchlist AS
SELECT
  w.variant_id,
  w.product_name,
  w.variant_color,
  w.variant_sku,
  w.size,
  w.untracked_events_30d,
  w.untracked_qty_30d,
  w.last_event_at,
  w.source_types,
  last_ev.admin_user_id AS last_admin_user_id,
  a.email AS last_admin_email,
  last_ev.reason AS last_reason
FROM (
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
) w
LEFT JOIN LATERAL (
  SELECT s.admin_user_id, s.reason
  FROM public.vw_stock_audit_untracked_sales s
  WHERE s.variant_id IS NOT DISTINCT FROM w.variant_id
    AND s.size IS NOT DISTINCT FROM w.size
    AND s.event_at >= now() - interval '30 days'
  ORDER BY s.event_at DESC
  LIMIT 1
) last_ev ON true
LEFT JOIN public.admins a ON a.user_id = last_ev.admin_user_id
ORDER BY w.last_event_at DESC;

COMMENT ON VIEW public.vw_stock_audit_untracked_sales_watchlist IS
  '343: igual a 341 + agrega quien fue el ultimo admin (email) y su ultimo motivo para cada variante+talle, para mostrar en la tarjeta de admin/stock-audit.html.';

GRANT SELECT ON public.vw_stock_audit_untracked_sales TO authenticated;
GRANT SELECT ON public.vw_stock_audit_untracked_sales_watchlist TO authenticated;

SELECT pg_notify('pgrst', 'reload schema');
