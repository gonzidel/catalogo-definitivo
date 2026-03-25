-- 40_fix_daily_sales_envios_trigger.sql — Corregir trigger para registrar envíos en daily_sales
-- Este script verifica y corrige el trigger que registra envíos en daily_sales cuando se finalizan pedidos

-- 1. Verificar que el trigger existe
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger 
    WHERE tgname = 'trigger_register_envio_sale'
  ) THEN
    RAISE NOTICE '⚠️ El trigger trigger_register_envio_sale NO existe. Creándolo...';
    
    -- Crear el trigger
    CREATE TRIGGER trigger_register_envio_sale
      AFTER UPDATE ON public.orders
      FOR EACH ROW
      EXECUTE FUNCTION public.register_envio_to_daily_sales();
    
    RAISE NOTICE '✅ Trigger trigger_register_envio_sale creado';
  ELSE
    RAISE NOTICE '✅ El trigger trigger_register_envio_sale ya existe';
  END IF;
END $$;

-- 2. Verificar y corregir la función register_envio_to_daily_sales
-- Asegurarse de que use cart_items en lugar de order_items si es necesario
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
    RAISE NOTICE '🔄 Trigger ejecutado: Pedido % cambió a status=sent con sent_at=%', NEW.id, NEW.sent_at;
    
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
      
      -- Si no hay items en order_items, intentar desde cart_items (por si el pedido viene de un cart)
      IF v_total_items = 0 THEN
        SELECT COUNT(*), COALESCE(SUM(qty * COALESCE(price_snapshot, 0)), 0)
        INTO v_total_items, v_total_amount
        FROM public.cart_items ci
        INNER JOIN public.carts c ON c.id = ci.cart_id
        WHERE c.id = NEW.id OR EXISTS (
          SELECT 1 FROM public.orders o2 
          WHERE o2.id = NEW.id 
          AND o2.customer_id = c.customer_id
          AND c.status = 'closed'
        )
        AND ci.status != 'cancelled';
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- Si hay error, usar valores por defecto
      v_total_items := 0;
      v_total_amount := 0;
    END;
    
    -- Si no hay items, usar total_amount del pedido y cantidad 0
    IF v_total_items = 0 THEN
      v_total_items := 0;
      v_total_amount := COALESCE(NEW.total_amount, 0);
    END IF;
    
    -- Verificar que no exista ya un registro para este envío
    -- Usamos una combinación única para evitar duplicados
    IF NOT EXISTS (
      SELECT 1 FROM public.daily_sales
      WHERE sale_date = NEW.sent_at::date
        AND sale_type = 'envios'
        AND sale_time = v_sale_time
        AND sale_amount = COALESCE(v_total_amount, NEW.total_amount, 0)
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
        COALESCE(v_total_amount, NEW.total_amount, 0),
        COALESCE(auth.uid(), NULL)  -- NULL si no hay contexto de autenticación
      );
      
      RAISE NOTICE '✅ Registro de envío creado en daily_sales para pedido % - Fecha: %, Hora: %, Monto: %', 
        NEW.id, NEW.sent_at::date, v_sale_time, COALESCE(v_total_amount, NEW.total_amount, 0);
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

-- 3. Verificar que la función existe y está correcta
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

-- 4. Crear función RPC para sincronizar pedidos "sent" que no están en daily_sales
CREATE OR REPLACE FUNCTION public.rpc_sync_sent_orders_to_daily_sales()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order record;
  v_customer_name text;
  v_sale_time time;
  v_total_items int;
  v_total_amount numeric;
  v_inserted_count int := 0;
  v_skipped_count int := 0;
BEGIN
  -- Verificar que el usuario es admin (solo si hay contexto de autenticación)
  -- Si se ejecuta como postgres desde SQL Editor, permitir la ejecución
  IF auth.uid() IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()) THEN
      RETURN json_build_object(
        'success', false,
        'message', 'Solo administradores pueden sincronizar envíos'
      );
    END IF;
  END IF;
  -- Si auth.uid() IS NULL, asumimos que se ejecuta como postgres y permitimos la ejecución

  -- Iterar sobre todos los pedidos marcados como "sent" o "devolución" con sent_at
  FOR v_order IN
    SELECT o.id, o.customer_id, o.sent_at, o.total_amount, o.order_number
    FROM public.orders o
    WHERE o.status IN ('sent', 'devolución')  -- Incluir también "devolución"
      AND o.sent_at IS NOT NULL
    ORDER BY o.sent_at
  LOOP
    -- Obtener nombre del cliente
    IF v_order.customer_id IS NOT NULL THEN
      SELECT COALESCE(full_name, 'Cliente sin nombre')
      INTO v_customer_name
      FROM public.customers
      WHERE id = v_order.customer_id;
    ELSE
      v_customer_name := 'Cliente sin nombre';
    END IF;
    
    -- Extraer hora de sent_at
    v_sale_time := (v_order.sent_at::time);
    
    -- Contar items del pedido desde order_items
    BEGIN
      SELECT COUNT(*), COALESCE(SUM(quantity * COALESCE(price_snapshot, 0)), 0)
      INTO v_total_items, v_total_amount
      FROM public.order_items
      WHERE order_id = v_order.id
        AND status != 'cancelled';
      
      -- Si no hay items, usar total_amount del pedido
      IF v_total_items = 0 THEN
        v_total_items := 0;
        v_total_amount := COALESCE(v_order.total_amount, 0);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- Si hay error, usar valores por defecto
      v_total_items := 0;
      v_total_amount := COALESCE(v_order.total_amount, 0);
    END;
    
    -- Verificar que no existe ya un registro para este envío
    -- Usamos una combinación más flexible para evitar duplicados
    IF NOT EXISTS (
      SELECT 1 FROM public.daily_sales
      WHERE sale_date = v_order.sent_at::date
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
        v_order.sent_at::date,
        'envios',
        v_sale_time,
        v_customer_name,
        v_total_items,
        v_total_amount,
        COALESCE(auth.uid(), NULL)  -- NULL si se ejecuta como postgres
      );
      
      v_inserted_count := v_inserted_count + 1;
    ELSE
      v_skipped_count := v_skipped_count + 1;
    END IF;
  END LOOP;
  
  RETURN json_build_object(
    'success', true,
    'inserted', v_inserted_count,
    'skipped', v_skipped_count,
    'message', format('Sincronización completada: %s envíos registrados, %s omitidos', v_inserted_count, v_skipped_count)
  );
END;
$$;

-- Otorgar permisos de ejecución
GRANT EXECUTE ON FUNCTION public.rpc_sync_sent_orders_to_daily_sales TO authenticated;

-- 5. Recargar esquema
SELECT pg_notify('pgrst', 'reload schema');

-- 6. Mensaje de confirmación
DO $$
BEGIN
  RAISE NOTICE '✅ Script de corrección completado';
  RAISE NOTICE '✅ El trigger trigger_register_envio_sale está activo';
  RAISE NOTICE '✅ La función register_envio_to_daily_sales está actualizada';
  RAISE NOTICE '✅ La función rpc_sync_sent_orders_to_daily_sales está creada';
  RAISE NOTICE '';
  RAISE NOTICE '📝 Para sincronizar pedidos ya enviados:';
  RAISE NOTICE '   Ejecuta: SELECT rpc_sync_sent_orders_to_daily_sales();';
  RAISE NOTICE '';
  RAISE NOTICE '📝 Para probar nuevos envíos:';
  RAISE NOTICE '   1. Ve a http://localhost:5500/admin/closed-orders.html';
  RAISE NOTICE '   2. Finaliza un pedido (márcalo como enviado)';
  RAISE NOTICE '   3. Ve a http://localhost:5500/admin/daily-sales.html';
  RAISE NOTICE '   4. Deberías ver el envío registrado en las ventas diarias';
END $$;

