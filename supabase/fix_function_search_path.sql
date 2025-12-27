-- fix_function_search_path.sql
-- Script para corregir vulnerabilidades de search_path mutable en funciones
-- Ejecutar este script en el SQL Editor de Supabase
-- 
-- IMPORTANTE: Este script actualiza todas las funciones para agregar SET search_path
-- Esto previene ataques de inyección SQL mediante manipulación del search_path

-- ============================================================================
-- CORRECCIÓN: Agregar SET search_path a todas las funciones
-- ============================================================================

-- Función helper para actualizar search_path de funciones
-- Esta función actualiza el search_path de una función específica
DO $$
DECLARE
    func_record RECORD;
    func_def TEXT;
    new_def TEXT;
BEGIN
    -- Obtener todas las funciones en el esquema public que no tienen search_path configurado
    FOR func_record IN
        SELECT 
            p.proname AS function_name,
            pg_get_function_identity_arguments(p.oid) AS function_args,
            pg_get_functiondef(p.oid) AS function_definition
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public'
        AND p.prokind = 'f' -- Solo funciones (no procedimientos ni triggers)
        AND NOT EXISTS (
            SELECT 1 
            FROM pg_proc p2
            WHERE p2.oid = p.oid
            AND p2.proconfig IS NOT NULL
            AND array_to_string(p2.proconfig, ',') LIKE '%search_path%'
        )
    LOOP
        BEGIN
            -- Intentar agregar SET search_path a la función
            -- Nota: Esto requiere recrear la función, así que necesitamos obtener su definición completa
            -- Por ahora, solo registramos las funciones que necesitan ser actualizadas
            RAISE NOTICE 'Función que necesita actualización: %(%)', func_record.function_name, func_record.function_args;
        EXCEPTION
            WHEN OTHERS THEN
                RAISE NOTICE 'Error al procesar función %: %', func_record.function_name, SQLERRM;
        END;
    END LOOP;
END $$;

-- ============================================================================
-- ACTUALIZACIÓN MANUAL DE FUNCIONES ESPECÍFICAS
-- ============================================================================

-- 1. set_updated_at (trigger function)
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger 
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF to_jsonb(new) ? 'updated_at' THEN
    new.updated_at = now();
  END IF;
  RETURN new;
END $$;

-- 2. rpc_get_or_create_cart
CREATE OR REPLACE FUNCTION public.rpc_get_or_create_cart()
RETURNS uuid 
LANGUAGE plpgsql 
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE cid uuid;
BEGIN
  SELECT id INTO cid FROM public.carts WHERE customer_id = auth.uid() AND status = 'open' LIMIT 1;
  IF cid IS NULL THEN
    INSERT INTO public.carts(id, customer_id, status) VALUES (gen_random_uuid(), auth.uid(), 'open') RETURNING id INTO cid;
  END IF;
  RETURN cid;
END $$;

-- 3. rpc_reserve_item
CREATE OR REPLACE FUNCTION public.rpc_reserve_item(variant uuid, qty int)
RETURNS uuid 
LANGUAGE plpgsql 
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE cid uuid; v_available int; item_id uuid; v_price numeric;
BEGIN
  IF qty <= 0 THEN RAISE EXCEPTION 'qty must be > 0'; END IF;
  SELECT rpc_get_or_create_cart() INTO cid;
  SELECT stock_qty - reserved_qty INTO v_available FROM public.product_variants WHERE id = variant FOR UPDATE;
  IF v_available < qty THEN RAISE EXCEPTION 'No hay disponibilidad suficiente'; END IF;
  SELECT price INTO v_price FROM public.product_variants WHERE id = variant;
  UPDATE public.product_variants SET reserved_qty = reserved_qty + qty WHERE id = variant;
  INSERT INTO public.cart_items(id, cart_id, variant_id, qty, status, price_snapshot)
    VALUES (gen_random_uuid(), cid, variant, qty, 'reserved', v_price)
    RETURNING id INTO item_id;
  RETURN item_id;
END $$;

-- 4. rpc_submit_cart
CREATE OR REPLACE FUNCTION public.rpc_submit_cart(cid uuid)
RETURNS void 
LANGUAGE plpgsql 
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  UPDATE public.carts SET status = 'submitted'
   WHERE id = cid AND customer_id = auth.uid() AND status = 'open';
END $$;

-- 5. rpc_admin_set_item_status
CREATE OR REPLACE FUNCTION public.rpc_admin_set_item_status(item uuid, new_status text)
RETURNS void 
LANGUAGE plpgsql 
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE v_variant uuid; v_qty int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admins a WHERE a.user_id = auth.uid()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF new_status = 'confirmed' THEN
    UPDATE public.cart_items SET status = 'confirmed'
     WHERE id = item AND status IN ('reserved','confirmed');
  ELSIF new_status = 'rejected' THEN
    SELECT variant_id, qty INTO v_variant, v_qty FROM public.cart_items WHERE id = item;
    UPDATE public.product_variants SET reserved_qty = reserved_qty - v_qty WHERE id = v_variant;
    UPDATE public.cart_items SET status = 'rejected' WHERE id = item;
  ELSE
    RAISE EXCEPTION 'Estado no soportado: %', new_status;
  END IF;
END $$;

-- 6. rpc_close_cart
CREATE OR REPLACE FUNCTION public.rpc_close_cart(cid uuid)
RETURNS void 
LANGUAGE plpgsql 
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE r RECORD;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admins a WHERE a.user_id = auth.uid()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  FOR r IN SELECT variant_id, qty FROM public.cart_items WHERE cart_id = cid AND status = 'confirmed'
  LOOP
    UPDATE public.product_variants
       SET stock_qty = stock_qty - r.qty,
           reserved_qty = reserved_qty - r.qty
     WHERE id = r.variant_id;
  END LOOP;
  UPDATE public.carts SET status = 'closed' WHERE id = cid;
END $$;

-- ============================================================================
-- NOTA: Las siguientes funciones necesitan ser actualizadas manualmente
-- desde sus archivos SQL originales. Este script solo actualiza las funciones
-- más comunes. Para una corrección completa, ejecuta este script y luego
-- actualiza los archivos SQL originales agregando SET search_path a cada función.
-- ============================================================================

-- Verificar funciones que aún necesitan corrección
SELECT 
    p.proname AS function_name,
    pg_get_function_identity_arguments(p.oid) AS function_args,
    CASE 
        WHEN p.proconfig IS NULL THEN 'NO search_path configurado'
        WHEN array_to_string(p.proconfig, ',') LIKE '%search_path%' THEN 'search_path configurado'
        ELSE 'Otro config'
    END AS search_path_status
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
AND p.prokind = 'f'
ORDER BY p.proname;

-- Mensaje de confirmación
DO $$
BEGIN
  RAISE NOTICE '✅ Script de corrección de search_path ejecutado';
  RAISE NOTICE '⚠️  Nota: Algunas funciones pueden necesitar actualización manual desde sus archivos SQL originales';
END $$;

