-- 14_public_sales_fix_complete.sql — Fix completo del sistema de ventas públicas
-- Este script corrige TODOS los problemas del SQL original:
-- 1. Precisión numérica (overflow)
-- 2. Soporte para stock por talle (variant_size_warehouse_stock)
-- 3. Mantiene compatibilidad con sistema legacy

-- ============================================
-- PARTE 1: Arreglar precisión numérica en todas las tablas
-- ============================================

-- Corregir public_sales.total_amount
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'public_sales' 
    AND column_name = 'total_amount'
  ) THEN
    ALTER TABLE public.public_sales 
      ALTER COLUMN total_amount TYPE numeric(15,2);
    RAISE NOTICE '✅ public_sales.total_amount actualizado a numeric(15,2)';
  END IF;
END $$;

-- Corregir public_sales.credit_used
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'public_sales' 
    AND column_name = 'credit_used'
  ) THEN
    ALTER TABLE public.public_sales 
      ALTER COLUMN credit_used TYPE numeric(15,2);
    RAISE NOTICE '✅ public_sales.credit_used actualizado a numeric(15,2)';
  END IF;
END $$;

-- Corregir public_sales_customer_credits.amount
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'public_sales_customer_credits' 
    AND column_name = 'amount'
  ) THEN
    ALTER TABLE public.public_sales_customer_credits 
      ALTER COLUMN amount TYPE numeric(15,2);
    RAISE NOTICE '✅ public_sales_customer_credits.amount actualizado a numeric(15,2)';
  END IF;
END $$;

-- Corregir public_sale_items.price_snapshot
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'public_sale_items' 
    AND column_name = 'price_snapshot'
  ) THEN
    ALTER TABLE public.public_sale_items 
      ALTER COLUMN price_snapshot TYPE numeric(15,2);
    RAISE NOTICE '✅ public_sale_items.price_snapshot actualizado a numeric(15,2)';
  END IF;
END $$;

-- ============================================
-- PARTE 1.5: Modificar esquema de public_sale_items para soportar extras especiales
-- Permitir variant_id NULL y agregar product_name para extras especiales
DO $$
BEGIN
  -- Modificar variant_id para permitir NULL
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'public_sale_items' 
    AND column_name = 'variant_id'
    AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE public.public_sale_items 
    ALTER COLUMN variant_id DROP NOT NULL;
    RAISE NOTICE '✅ Columna variant_id modificada para permitir NULL';
  END IF;
  
  -- Agregar columna product_name si no existe
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'public_sale_items' 
    AND column_name = 'product_name'
  ) THEN
    ALTER TABLE public.public_sale_items 
    ADD COLUMN product_name text;
    RAISE NOTICE '✅ Columna product_name agregada';
  END IF;
  
  -- Agregar constraint para asegurar que siempre haya variant_id O product_name
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'public_sale_items_variant_or_name_check'
  ) THEN
    ALTER TABLE public.public_sale_items 
    ADD CONSTRAINT public_sale_items_variant_or_name_check 
    CHECK (variant_id IS NOT NULL OR product_name IS NOT NULL);
    RAISE NOTICE '✅ Constraint agregado: variant_id o product_name debe existir';
  END IF;
END $$;

-- PARTE 2: Actualizar función rpc_create_public_sale con soporte para stock por talle
-- ============================================

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
      
      -- Continuar al siguiente item sin procesar stock
      CONTINUE;
    END IF;
    
    -- Procesar item normal con variant_id
    v_variant_id := (v_item->>'variant_id')::uuid;
    v_qty := (v_item->>'qty')::int;
    v_price := (v_item->>'price')::numeric(15,2);
    v_is_return := COALESCE((v_item->>'is_return')::boolean, false);
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
    BEGIN
      IF NOT v_is_return THEN
        -- Si el item viene de un pedido local, el stock ya fue descontado
        IF NOT v_from_local_order THEN
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
              -- Si se usó fallback desde variant_sizes, crear registro en variant_size_warehouse_stock
              -- y actualizar variant_sizes.stock_qty
              IF v_fallback_stock_qty > 0 AND v_size_stock_general = v_fallback_stock_qty THEN
                -- Crear registro en variant_size_warehouse_stock con el stock restante después de descontar
                INSERT INTO public.variant_size_warehouse_stock (variant_id, size, warehouse_id, stock_qty)
                VALUES (v_variant_id, v_normalized_size, v_general_warehouse_id, GREATEST(v_fallback_stock_qty - v_qty_general, 0))
                ON CONFLICT (variant_id, size, warehouse_id) 
                DO UPDATE SET 
                  stock_qty = GREATEST(v_fallback_stock_qty - v_qty_general, 0),
                  updated_at = now();
                
                -- Actualizar variant_sizes.stock_qty para reflejar el descuento
                UPDATE public.variant_sizes
                SET stock_qty = GREATEST(stock_qty - v_qty_general, 0),
                    updated_at = now()
                WHERE variant_id = v_variant_id
                  AND size = v_normalized_size;
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

  -- Crear items de venta
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    -- Detectar si es un extra especial
    v_is_special_extra := COALESCE((v_item->>'is_special_extra')::boolean, false);
    v_product_name := v_item->>'product_name';
    
    IF v_is_special_extra OR (v_item->>'variant_id') IS NULL OR (v_item->>'variant_id') = 'null' OR (v_item->>'variant_id') = '' THEN
      -- Insertar extra especial sin variant_id
      INSERT INTO public.public_sale_items (
        sale_id,
        variant_id,
        product_name,
        qty,
        price_snapshot,
        is_return
      )
      VALUES (
        v_sale_id,
        NULL,
        COALESCE(v_product_name, 'Extra especial'),
        COALESCE((v_item->>'qty')::int, 1),
        (v_item->>'price')::numeric(15,2),
        COALESCE((v_item->>'is_return')::boolean, false)
      );
    ELSE
      -- Insertar item normal con variant_id
      INSERT INTO public.public_sale_items (
        sale_id,
        variant_id,
        qty,
        price_snapshot,
        is_return
      )
      VALUES (
        v_sale_id,
        (v_item->>'variant_id')::uuid,
        (v_item->>'qty')::int,
        (v_item->>'price')::numeric(15,2),
        COALESCE((v_item->>'is_return')::boolean, false)
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

-- ============================================
-- PARTE 3: Verificar tipos de datos actuales (para diagnóstico)
-- ============================================

DO $$
DECLARE
  v_total_amount_type text;
  v_credit_used_type text;
  v_amount_type text;
  v_price_snapshot_type text;
BEGIN
  -- Verificar tipo de total_amount
  SELECT data_type || '(' || numeric_precision || ',' || numeric_scale || ')' 
  INTO v_total_amount_type
  FROM information_schema.columns 
  WHERE table_schema = 'public' 
    AND table_name = 'public_sales' 
    AND column_name = 'total_amount';
  
  -- Verificar tipo de credit_used
  SELECT data_type || '(' || numeric_precision || ',' || numeric_scale || ')' 
  INTO v_credit_used_type
  FROM information_schema.columns 
  WHERE table_schema = 'public' 
    AND table_name = 'public_sales' 
    AND column_name = 'credit_used';
  
  -- Verificar tipo de amount
  SELECT data_type || '(' || numeric_precision || ',' || numeric_scale || ')' 
  INTO v_amount_type
  FROM information_schema.columns 
  WHERE table_schema = 'public' 
    AND table_name = 'public_sales_customer_credits' 
    AND column_name = 'amount';
  
  -- Verificar tipo de price_snapshot
  SELECT data_type || '(' || numeric_precision || ',' || numeric_scale || ')' 
  INTO v_price_snapshot_type
  FROM information_schema.columns 
  WHERE table_schema = 'public' 
    AND table_name = 'public_sale_items' 
    AND column_name = 'price_snapshot';
  
  RAISE NOTICE '📊 Tipos de datos después del fix:';
  RAISE NOTICE '   public_sales.total_amount: %', v_total_amount_type;
  RAISE NOTICE '   public_sales.credit_used: %', v_credit_used_type;
  RAISE NOTICE '   public_sales_customer_credits.amount: %', v_amount_type;
  RAISE NOTICE '   public_sale_items.price_snapshot: %', v_price_snapshot_type;
END $$;

