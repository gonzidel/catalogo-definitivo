-- 141_public_sale_stock_trace_and_void.sql
-- Desglose por depósito en public_sale_items, void alineado con variant_size_warehouse_stock,
-- RPC rpc_release_public_sale_draft_line (reemplaza upsert JS en removeSaleItem).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'public_sale_items' AND column_name = 'qty_venta_publico'
  ) THEN
    ALTER TABLE public.public_sale_items
      ADD COLUMN qty_venta_publico integer NULL,
      ADD COLUMN qty_general integer NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'public_sale_items' AND column_name = 'sold_size_normalized'
  ) THEN
    ALTER TABLE public.public_sale_items
      ADD COLUMN sold_size_normalized text NULL;
  END IF;
END $$;

COMMENT ON COLUMN public.public_sale_items.qty_venta_publico IS
  'Unidades descontadas de venta-publico al registrar la línea (NULL = legacy / extra).';
COMMENT ON COLUMN public.public_sale_items.qty_general IS
  'Unidades descontadas de general al registrar la línea (NULL = legacy / extra).';
COMMENT ON COLUMN public.public_sale_items.sold_size_normalized IS
  'Talle normalizado usado en variant_size_warehouse_stock al vender (NULL = legacy sin talle / extra). Anulación: preferir sobre product_variants.size.';

CREATE OR REPLACE FUNCTION public.rpc_create_public_sale(
  p_items jsonb,
  p_customer_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_apply_credit boolean DEFAULT TRUE,
  p_total_amount numeric(15,2) DEFAULT NULL
)
RETURNS json 
LANGUAGE plpgsql 
SECURITY DEFINER 
AS $$
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
  v_fallback_stock_qty int;
  v_return_rows int;
  v_line_idx int := 0;
  v_persist_vp int;
  v_persist_g int;
  v_ins_vp int;
  v_ins_g int;
  v_ins_snap text;
  v_sold_size_snap text;
  v_ord bigint;
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
    sold_size_normalized text NULL
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
      INSERT INTO tmp_psi_deduction (idx, qty_venta_publico, qty_general, sold_size_normalized)
      VALUES (v_line_idx, NULL, NULL, NULL);
      
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
      IF NOT v_is_return THEN
        -- Si el item viene de un pedido local, el stock ya fue descontado
        IF NOT v_from_local_order THEN
          IF NOT v_skip_stock_deduction THEN
          -- Si hay tamaño específico, usar variant_size_warehouse_stock
          IF v_size IS NOT NULL AND v_size != '' AND v_general_warehouse_id IS NOT NULL AND v_venta_publico_warehouse_id IS NOT NULL THEN
            -- Validar y descontar stock por talle desde variant_size_warehouse_stock
            -- Usar tamaño normalizado para la búsqueda
            SELECT 
              COALESCE(SUM(CASE WHEN warehouse_id = v_general_warehouse_id THEN stock_qty ELSE 0 END), 0),
              COALESCE(SUM(CASE WHEN warehouse_id = v_venta_publico_warehouse_id THEN stock_qty ELSE 0 END), 0)
            INTO v_size_stock_general, v_size_stock_venta_publico
            FROM public.variant_size_warehouse_stock
            WHERE variant_id = v_variant_id
              AND size = v_normalized_size
              AND warehouse_id IN (v_general_warehouse_id, v_venta_publico_warehouse_id);

            -- FALLBACK: Si no hay stock en warehouses, consultar variant_sizes.stock_qty
            IF v_size_stock_general = 0 AND v_size_stock_venta_publico = 0 THEN
              -- Consultar stock_qty desde variant_sizes usando tamaño normalizado
              SELECT COALESCE(stock_qty, 0) INTO v_fallback_stock_qty
              FROM public.variant_sizes
              WHERE variant_id = v_variant_id
                AND size = v_normalized_size;
              
              -- Si hay stock en variant_sizes, usar como fallback en general
              IF v_fallback_stock_qty > 0 THEN
                v_size_stock_general := v_fallback_stock_qty;
              ELSE
                -- Solo lanzar error si tampoco hay stock en variant_sizes
                RAISE EXCEPTION 'No hay stock disponible para la variante % talle %', v_variant_id, v_size;
              END IF;
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
              -- Fallback desde variant_sizes: solo variant_size_warehouse_stock; el trigger
              -- sync_variant_sizes_stock_from_warehouse recalcula variant_sizes como SUM por talle.
              IF v_fallback_stock_qty > 0 AND v_size_stock_general = v_fallback_stock_qty THEN
                INSERT INTO public.variant_size_warehouse_stock (variant_id, size, warehouse_id, stock_qty)
                VALUES (v_variant_id, v_normalized_size, v_general_warehouse_id, GREATEST(v_fallback_stock_qty - v_qty_general, 0))
                ON CONFLICT (variant_id, size, warehouse_id) 
                DO UPDATE SET 
                  stock_qty = GREATEST(v_fallback_stock_qty - v_qty_general, 0),
                  updated_at = now();
              ELSE
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
            END IF;
          ELSE
            -- Sin tamaño específico, usar variant_warehouse_stock (comportamiento legacy)
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

          UPDATE public.variant_size_warehouse_stock
          SET stock_qty = stock_qty + v_qty,
              updated_at = now()
          WHERE variant_id = v_variant_id
            AND size = v_normalized_size
            AND warehouse_id = v_venta_publico_warehouse_id;
          GET DIAGNOSTICS v_return_rows = ROW_COUNT;

          IF v_return_rows = 0 THEN
            INSERT INTO public.variant_size_warehouse_stock (variant_id, warehouse_id, size, stock_qty)
            VALUES (
              v_variant_id,
              v_venta_publico_warehouse_id,
              v_normalized_size,
              v_qty
            );
          END IF;

          RAISE NOTICE 'Devolución procesada: variant_id=%, size=%, qty=%, warehouse=venta-publico', 
            v_variant_id, v_normalized_size, v_qty;
        ELSE
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
      ELSIF v_from_local_order OR v_skip_stock_deduction THEN
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
      INSERT INTO tmp_psi_deduction (idx, qty_venta_publico, qty_general, sold_size_normalized)
      VALUES (v_line_idx, v_persist_vp, v_persist_g, v_sold_size_snap);
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
END $$;

CREATE OR REPLACE FUNCTION public.rpc_void_public_sale(p_sale_id uuid)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_sale record;
  v_psi record;
  v_wh_vp uuid;
  v_wh_g uuid;
  v_pv_size text;
  v_norm text;
BEGIN
  SELECT id INTO v_wh_vp FROM public.warehouses WHERE code = 'venta-publico' LIMIT 1;
  SELECT id INTO v_wh_g FROM public.warehouses WHERE code = 'general' LIMIT 1;

  IF v_wh_vp IS NULL THEN
    RAISE EXCEPTION 'Warehouse venta-publico no encontrado';
  END IF;
  IF v_wh_g IS NULL THEN
    RAISE EXCEPTION 'Warehouse general no encontrado';
  END IF;

  SELECT id, sale_number, customer_id, credit_used, voided_at INTO v_sale
  FROM public.public_sales WHERE id = p_sale_id;

  IF v_sale.id IS NULL THEN
    RAISE EXCEPTION 'Venta no encontrada';
  END IF;
  IF v_sale.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'La venta ya está anulada';
  END IF;

  FOR v_psi IN
    SELECT psi.*, pv.size AS pv_size
    FROM public.public_sale_items psi
    LEFT JOIN public.product_variants pv ON pv.id = psi.variant_id
    WHERE psi.sale_id = p_sale_id AND psi.variant_id IS NOT NULL
  LOOP
    IF (v_psi.qty_venta_publico IS NULL) <> (v_psi.qty_general IS NULL) THEN
      RAISE EXCEPTION 'public_sale_items id %: qty_venta_publico y qty_general deben ser ambas NULL o ambas NOT NULL',
        v_psi.id;
    END IF;

    IF v_psi.qty_venta_publico IS NULL AND v_psi.qty_general IS NULL THEN
      IF v_psi.is_return THEN
        UPDATE public.variant_warehouse_stock
        SET stock_qty = greatest(0, stock_qty - v_psi.qty), updated_at = now()
        WHERE variant_id = v_psi.variant_id AND warehouse_id = v_wh_vp;
      ELSE
        INSERT INTO public.variant_warehouse_stock (variant_id, warehouse_id, stock_qty)
        VALUES (v_psi.variant_id, v_wh_vp, v_psi.qty)
        ON CONFLICT (variant_id, warehouse_id)
        DO UPDATE SET
          stock_qty = public.variant_warehouse_stock.stock_qty + v_psi.qty,
          updated_at = now();
      END IF;
      CONTINUE;
    END IF;

    -- Preferir talle guardado en la línea (mismo criterio que al descontar); pv.size solo respaldo
    v_norm := NULL;
    IF v_psi.sold_size_normalized IS NOT NULL AND TRIM(v_psi.sold_size_normalized::text) != '' THEN
      v_norm := TRIM(v_psi.sold_size_normalized::text);
      IF v_norm ~ '^\d+(\.\d+)?$' THEN
        v_norm := split_part(v_norm, '.', 1);
      END IF;
    END IF;
    IF v_norm IS NULL OR v_norm = '' THEN
      v_pv_size := v_psi.pv_size;
      IF v_pv_size IS NOT NULL AND TRIM(v_pv_size::text) != '' THEN
        v_norm := TRIM(v_pv_size::text);
        IF v_norm ~ '^\d+(\.\d+)?$' THEN
          v_norm := split_part(v_norm, '.', 1);
        END IF;
      END IF;
    END IF;

    IF v_norm IS NULL OR v_norm = '' THEN
      IF v_psi.is_return THEN
        UPDATE public.variant_warehouse_stock
        SET stock_qty = greatest(0, stock_qty - v_psi.qty), updated_at = now()
        WHERE variant_id = v_psi.variant_id AND warehouse_id = v_wh_vp;
      ELSE
        INSERT INTO public.variant_warehouse_stock (variant_id, warehouse_id, stock_qty)
        VALUES (v_psi.variant_id, v_wh_vp, v_psi.qty)
        ON CONFLICT (variant_id, warehouse_id)
        DO UPDATE SET
          stock_qty = public.variant_warehouse_stock.stock_qty + v_psi.qty,
          updated_at = now();
      END IF;
      CONTINUE;
    END IF;

    IF v_psi.is_return THEN
      IF v_psi.qty_venta_publico > 0 THEN
        UPDATE public.variant_size_warehouse_stock
        SET stock_qty = greatest(0, stock_qty - v_psi.qty_venta_publico), updated_at = now()
        WHERE variant_id = v_psi.variant_id AND size = v_norm AND warehouse_id = v_wh_vp;
      END IF;
    ELSE
      IF v_psi.qty_venta_publico > 0 THEN
        INSERT INTO public.variant_size_warehouse_stock (variant_id, size, warehouse_id, stock_qty)
        VALUES (v_psi.variant_id, v_norm, v_wh_vp, 0)
        ON CONFLICT (variant_id, size, warehouse_id) DO NOTHING;
        UPDATE public.variant_size_warehouse_stock
        SET stock_qty = stock_qty + v_psi.qty_venta_publico, updated_at = now()
        WHERE variant_id = v_psi.variant_id AND size = v_norm AND warehouse_id = v_wh_vp;
      END IF;
      IF v_psi.qty_general > 0 THEN
        INSERT INTO public.variant_size_warehouse_stock (variant_id, size, warehouse_id, stock_qty)
        VALUES (v_psi.variant_id, v_norm, v_wh_g, 0)
        ON CONFLICT (variant_id, size, warehouse_id) DO NOTHING;
        UPDATE public.variant_size_warehouse_stock
        SET stock_qty = stock_qty + v_psi.qty_general, updated_at = now()
        WHERE variant_id = v_psi.variant_id AND size = v_norm AND warehouse_id = v_wh_g;
      END IF;
    END IF;
  END LOOP;

  IF v_sale.customer_id IS NOT NULL AND coalesce(v_sale.credit_used, 0) > 0 THEN
    PERFORM public.rpc_add_customer_credit(
      v_sale.customer_id,
      v_sale.credit_used,
      'Crédito restaurado por anulación de venta ' || v_sale.sale_number
    );
  END IF;

  UPDATE public.public_sales SET voided_at = now() WHERE id = p_sale_id;

  RETURN json_build_object('success', true, 'sale_number', v_sale.sale_number);
END $$;

CREATE OR REPLACE FUNCTION public.rpc_release_public_sale_draft_line(
  p_variant_id uuid,
  p_size text,
  p_qty int
)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_uid uuid;
  v_wh_vp uuid;
  v_norm text;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Usuario no autenticado';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = v_uid) THEN
    RAISE EXCEPTION 'No tienes permiso';
  END IF;
  IF p_qty IS NULL OR p_qty <= 0 THEN
    RAISE EXCEPTION 'p_qty debe ser mayor que 0';
  END IF;

  SELECT id INTO v_wh_vp FROM public.warehouses WHERE code = 'venta-publico' LIMIT 1;
  IF v_wh_vp IS NULL THEN
    RAISE EXCEPTION 'Warehouse venta-publico no encontrado';
  END IF;

  v_norm := TRIM(COALESCE(p_size, ''));
  IF v_norm = '' THEN
    RAISE EXCEPTION 'p_size vacío';
  END IF;
  IF v_norm ~ '^\d+(\.\d+)?$' THEN
    v_norm := split_part(v_norm, '.', 1);
  END IF;

  INSERT INTO public.variant_size_warehouse_stock (variant_id, size, warehouse_id, stock_qty)
  VALUES (p_variant_id, v_norm, v_wh_vp, p_qty)
  ON CONFLICT (variant_id, size, warehouse_id)
  DO UPDATE SET
    stock_qty = public.variant_size_warehouse_stock.stock_qty + p_qty,
    updated_at = now();

  RETURN json_build_object('success', true);
END $$;

GRANT EXECUTE ON FUNCTION public.rpc_release_public_sale_draft_line(uuid, text, int) TO authenticated;
