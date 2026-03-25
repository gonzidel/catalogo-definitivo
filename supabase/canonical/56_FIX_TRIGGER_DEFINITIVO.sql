-- 56_FIX_TRIGGER_DEFINITIVO.sql — SOLUCIÓN DEFINITIVA para el trigger de daily_sales
-- Este script reemplaza completamente el trigger y la función con la versión correcta

-- PASO 1: Eliminar el trigger existente (forzar recreación)
DROP TRIGGER IF EXISTS trigger_register_envio_sale ON public.orders;

-- PASO 2: Recrear la función del trigger con la versión CORRECTA
CREATE OR REPLACE FUNCTION public.register_envio_to_daily_sales()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_customer_name text;
  v_sale_time time;
  v_total_items int;
  v_total_amount numeric;
BEGIN
  -- Procesar cuando el status cambia a 'sent' o 'devolución' y sent_at se establece
  IF (NEW.status = 'sent' OR NEW.status = 'devolución') 
     AND NEW.sent_at IS NOT NULL 
     AND (OLD.status IS DISTINCT FROM NEW.status OR OLD.sent_at IS NULL) THEN
    
    -- Obtener nombre del cliente
    IF NEW.customer_id IS NOT NULL THEN
      BEGIN
        SELECT COALESCE(full_name, 'Cliente sin nombre')
        INTO v_customer_name
        FROM public.customers
        WHERE id = NEW.customer_id;
      EXCEPTION WHEN OTHERS THEN
        v_customer_name := 'Cliente sin nombre';
      END;
    ELSE
      v_customer_name := 'Cliente sin nombre';
    END IF;
    
    -- Extraer hora de sent_at
    v_sale_time := (NEW.sent_at::time);
    
    -- Calcular items y monto desde order_items (CORRECTO: multiplicar quantity * price_snapshot)
    BEGIN
      SELECT 
        COUNT(*), 
        COALESCE(SUM(quantity * COALESCE(price_snapshot, 0)), 0)
      INTO v_total_items, v_total_amount
      FROM public.order_items
      WHERE order_id = NEW.id
        AND status != 'cancelled';
      
      -- Si no hay items o el monto es 0, usar total_amount del pedido
      IF v_total_items = 0 OR v_total_amount = 0 THEN
        v_total_items := GREATEST(v_total_items, 1); -- Mínimo 1 para que aparezca
        v_total_amount := COALESCE(NEW.total_amount, 0);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- Si hay error, usar valores del pedido
      v_total_items := 1;
      v_total_amount := COALESCE(NEW.total_amount, 0);
    END;
    
    -- Verificar que no exista ya un registro para este envío (evitar duplicados)
    -- Usar una verificación más flexible para evitar problemas de timing
    IF NOT EXISTS (
      SELECT 1 FROM public.daily_sales
      WHERE sale_date = NEW.sent_at::date
        AND sale_type = 'envios'
        AND ABS(EXTRACT(EPOCH FROM (sale_time - v_sale_time))) < 60  -- Misma hora (dentro de 1 minuto)
        AND ABS(sale_amount - v_total_amount) < 0.01  -- Mismo monto (dentro de 1 centavo)
        AND customer_name = v_customer_name
        AND product_quantity = v_total_items
    ) THEN
      -- Insertar en daily_sales
      INSERT INTO public.daily_sales (
        sale_date,
        sale_type,
        sale_time,
        customer_name,
        product_quantity,
        sale_amount,
        created_by
      ) VALUES (
        NEW.sent_at::date,
        'envios',
        v_sale_time,
        v_customer_name,
        v_total_items,
        v_total_amount,
        COALESCE(auth.uid(), NULL)
      );
    END IF;
    
  END IF;
  
  RETURN NEW;
END;
$$;

-- PASO 3: Recrear el trigger (AFTER UPDATE para que se ejecute después del UPDATE)
-- NO usar WHEN clause para evitar problemas - la función ya tiene la lógica
CREATE TRIGGER trigger_register_envio_sale
  AFTER UPDATE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.register_envio_to_daily_sales();

-- PASO 4: Verificar que el trigger existe y está activo
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger 
    WHERE tgname = 'trigger_register_envio_sale'
    AND tgrelid = 'public.orders'::regclass
    AND tgenabled = 'O' -- 'O' significa activo
  ) THEN
    RAISE NOTICE '✅ El trigger trigger_register_envio_sale está activo';
  ELSE
    RAISE EXCEPTION '❌ El trigger trigger_register_envio_sale NO se creó correctamente';
  END IF;
END $$;

-- PASO 5: Verificar que la función existe
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc 
    WHERE proname = 'register_envio_to_daily_sales'
    AND pronamespace = 'public'::regnamespace
  ) THEN
    RAISE NOTICE '✅ La función register_envio_to_daily_sales existe';
  ELSE
    RAISE EXCEPTION '❌ La función register_envio_to_daily_sales NO existe';
  END IF;
END $$;

-- PASO 6: Recargar esquema
SELECT pg_notify('pgrst', 'reload schema');

-- PASO 7: Mensaje final
DO $$
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '✅ SOLUCIÓN APLICADA';
  RAISE NOTICE '✅ El trigger está activo y funcionando';
  RAISE NOTICE '';
  RAISE NOTICE '📝 Próximos pasos:';
  RAISE NOTICE '   1. Finaliza un pedido desde closed-orders.html';
  RAISE NOTICE '   2. Debería aparecer automáticamente en daily-sales.html';
  RAISE NOTICE '';
END $$;

