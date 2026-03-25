-- 57_TRIGGER_SIMPLE_FUNCIONAL.sql — Versión simple y funcional del trigger
-- Basado en el trigger original que funcionaba, pero con el cálculo del monto corregido

-- PASO 1: Eliminar trigger existente
DROP TRIGGER IF EXISTS trigger_register_envio_sale ON public.orders;

-- PASO 2: Recrear función SIMPLE basada en la original que funcionaba
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
  -- Procesar cuando el status es 'sent' o 'devolución' y sent_at está establecido
  -- Simplificado: ejecutar SIEMPRE que el status sea 'sent'/'devolución' y sent_at no sea NULL
  -- Esto asegura que se ejecute cuando rpc_mark_order_as_sent actualiza el pedido
  IF (NEW.status = 'sent' OR NEW.status = 'devolución') 
     AND NEW.sent_at IS NOT NULL THEN
    
    -- Log para debugging (visible en logs de Supabase)
    RAISE NOTICE '🔄 Trigger ejecutado: Pedido % - Status: %, sent_at: %, OLD.status: %', 
      NEW.id, NEW.status, NEW.sent_at, OLD.status;
    
    BEGIN
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
      
      -- Contar items y calcular monto CORRECTAMENTE (quantity * price_snapshot)
      BEGIN
        SELECT 
          COUNT(*), 
          COALESCE(SUM(quantity * COALESCE(price_snapshot, 0)), 0)
        INTO v_total_items, v_total_amount
        FROM public.order_items
        WHERE order_id = NEW.id
          AND status != 'cancelled';
        
        -- Si no hay items, usar total_amount del pedido
        IF v_total_items = 0 OR v_total_amount = 0 THEN
          v_total_items := 1; -- Mínimo 1 para que aparezca
          v_total_amount := COALESCE(NEW.total_amount, 0);
        END IF;
      EXCEPTION WHEN OTHERS THEN
        -- Si hay error, usar valores del pedido
        v_total_items := 1;
        v_total_amount := COALESCE(NEW.total_amount, 0);
      END;
      
      -- Verificar que no exista ya un registro para este envío
      IF NOT EXISTS (
        SELECT 1 FROM public.daily_sales
        WHERE sale_date = NEW.sent_at::date
          AND sale_type = 'envios'
          AND sale_time = v_sale_time
          AND ABS(sale_amount - v_total_amount) < 0.01  -- Mismo monto (dentro de 1 centavo)
          AND customer_name = v_customer_name
          AND product_quantity = v_total_items
      ) THEN
        -- Insertar en daily_sales
        -- NOTA: created_by puede ser NULL si auth.uid() no está disponible en el contexto del trigger
        -- La política RLS permite inserciones desde funciones SECURITY DEFINER
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
          COALESCE(auth.uid(), NULL)  -- NULL si no hay contexto de autenticación (normal en triggers)
        );
        
        RAISE NOTICE '✅ Registro insertado en daily_sales: Fecha=%, Hora=%, Cliente=%, Monto=%', 
          NEW.sent_at::date, v_sale_time, v_customer_name, v_total_amount;
      ELSE
        RAISE NOTICE '⚠️ Ya existe un registro similar en daily_sales para este pedido';
      END IF;
      
    EXCEPTION WHEN OTHERS THEN
      -- Log del error pero no fallar el trigger
      RAISE WARNING 'Error en register_envio_to_daily_sales para pedido %: %', NEW.id, SQLERRM;
    END;
    
  END IF;
  
  RETURN NEW;
END;
$$;

-- PASO 3: Crear trigger (igual que el original que funcionaba)
CREATE TRIGGER trigger_register_envio_sale
  AFTER UPDATE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.register_envio_to_daily_sales();

-- PASO 4: Verificar que se creó correctamente
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger 
    WHERE tgname = 'trigger_register_envio_sale'
    AND tgrelid = 'public.orders'::regclass
  ) THEN
    RAISE NOTICE '✅ Trigger creado correctamente';
  ELSE
    RAISE EXCEPTION '❌ Error: El trigger no se creó';
  END IF;
END $$;

-- PASO 5: Recargar esquema
SELECT pg_notify('pgrst', 'reload schema');

-- PASO 6: Mensaje final
DO $$
BEGIN
  RAISE NOTICE '✅ Script completado. El trigger debería funcionar ahora.';
  RAISE NOTICE '✅ Prueba finalizando un pedido y verifica que aparece en daily-sales.html';
END $$;

