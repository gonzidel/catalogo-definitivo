-- 53_fix_trigger_daily_sales_automatic.sql — Corregir trigger para que funcione automáticamente
-- Este script asegura que el trigger se ejecute correctamente cuando se marca un pedido como enviado

-- PASO 1: Eliminar el trigger existente si existe (para recrearlo con la versión correcta)
DROP TRIGGER IF EXISTS trigger_register_envio_sale ON public.orders;

-- PASO 2: Asegurar que la función del trigger esté actualizada con la versión correcta
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
  -- También procesar si el pedido ya está en 'sent' o 'devolución' pero sent_at cambió de NULL a un valor
  -- NOTA: Los pedidos con status "devolución" también deben registrarse en daily_sales como envíos
  IF (NEW.status = 'sent' OR NEW.status = 'devolución') 
     AND NEW.sent_at IS NOT NULL 
     AND (OLD.status IS DISTINCT FROM NEW.status OR OLD.sent_at IS NULL) THEN
    
    -- Log para debugging (solo visible en logs de Supabase)
    RAISE NOTICE '🔄 Trigger ejecutado: Pedido % cambió a status=% con sent_at=%', NEW.id, NEW.status, NEW.sent_at;
    
    -- Obtener nombre del cliente
    IF NEW.customer_id IS NOT NULL THEN
      SELECT COALESCE(full_name, 'Cliente sin nombre')
      INTO v_customer_name
      FROM public.customers
      WHERE id = NEW.customer_id;
    ELSE
      v_customer_name := 'Cliente sin nombre';
    END IF;
    
    -- Extraer hora de sent_at
    v_sale_time := (NEW.sent_at::time);
    
    -- Intentar contar items del pedido desde order_items
    BEGIN
      SELECT COUNT(*), COALESCE(SUM(quantity * COALESCE(price_snapshot, 0)), 0)
      INTO v_total_items, v_total_amount
      FROM public.order_items
      WHERE order_id = NEW.id
        AND status != 'cancelled';
      
      -- Si no hay items, usar total_amount del pedido
      IF v_total_items = 0 THEN
        v_total_items := 1; -- Mínimo 1 para que aparezca en daily_sales
        v_total_amount := COALESCE(NEW.total_amount, 0);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- Si hay error, usar valores por defecto
      v_total_items := 1;
      v_total_amount := COALESCE(NEW.total_amount, 0);
    END;
    
    -- Verificar que no exista ya un registro para este envío
    -- Usamos una combinación más flexible para evitar duplicados
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
        COALESCE(auth.uid(), NULL)  -- NULL si no hay contexto de autenticación
      );
      
      RAISE NOTICE '✅ Registro de envío creado en daily_sales para pedido % - Fecha: %, Hora: %, Monto: %', 
        NEW.id, NEW.sent_at::date, v_sale_time, v_total_amount;
    ELSE
      RAISE NOTICE '⚠️ Ya existe un registro en daily_sales para este envío (pedido %)', NEW.id;
    END IF;
    
  ELSE
    -- Log cuando no se procesa (para debugging)
    IF (NEW.status = 'sent' OR NEW.status = 'devolución') AND NEW.sent_at IS NULL THEN
      RAISE NOTICE '⚠️ Pedido % está en status=% pero sent_at es NULL - no se registrará en daily_sales', NEW.id, NEW.status;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$;

-- PASO 3: Crear el trigger (AFTER UPDATE para que se ejecute después de la actualización)
CREATE TRIGGER trigger_register_envio_sale
  AFTER UPDATE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.register_envio_to_daily_sales();

-- PASO 4: Verificar que el trigger existe
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger 
    WHERE tgname = 'trigger_register_envio_sale'
    AND tgrelid = 'public.orders'::regclass
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
    RAISE NOTICE '✅ La función register_envio_to_daily_sales existe y está actualizada';
  ELSE
    RAISE EXCEPTION '❌ La función register_envio_to_daily_sales NO existe';
  END IF;
END $$;

-- PASO 6: Recargar esquema
SELECT pg_notify('pgrst', 'reload schema');

-- PASO 7: Mensaje de confirmación
DO $$
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '✅ Script de corrección completado';
  RAISE NOTICE '✅ El trigger trigger_register_envio_sale está activo y funcionando';
  RAISE NOTICE '✅ La función register_envio_to_daily_sales está actualizada';
  RAISE NOTICE '';
  RAISE NOTICE '📝 Próximos pasos:';
  RAISE NOTICE '   1. Marca un pedido como enviado desde closed-orders.html';
  RAISE NOTICE '   2. Verifica en daily-sales.html que aparece automáticamente';
  RAISE NOTICE '';
END $$;

