-- 65_FIX_TRIGGER_ENVIOS_DAILY_SALES.sql — Corregir trigger para registrar envíos en daily_sales
-- Este script corrige el trigger que no está registrando pedidos enviados en daily_sales

-- PASO 1: Verificar estado actual del trigger
SELECT 
  tgname as trigger_name,
  CASE tgenabled
    WHEN 'O' THEN '✅ Activo'
    WHEN 'D' THEN '❌ Deshabilitado'
    ELSE '⚠️ Estado: ' || tgenabled::text
  END as estado,
  tgrelid::regclass as tabla
FROM pg_trigger
WHERE tgname = 'trigger_register_envio_sale'
  AND tgrelid = 'public.orders'::regclass;

-- PASO 2: Verificar política RLS actual
SELECT 
  policyname,
  cmd,
  qual,
  with_check
FROM pg_policies
WHERE tablename = 'daily_sales'
ORDER BY policyname;

-- PASO 3: Corregir la función del trigger
-- El problema: La condición es demasiado restrictiva y el cálculo del monto es incorrecto
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
  -- IMPORTANTE: Verificar que el status cambió a 'sent' o que sent_at cambió de NULL a un valor
  IF (NEW.status = 'sent' OR NEW.status = 'devolución') 
     AND NEW.sent_at IS NOT NULL 
     AND (OLD.status IS DISTINCT FROM NEW.status OR OLD.sent_at IS NULL) THEN
    
    -- Log para debugging
    RAISE NOTICE '🔄 Trigger ejecutado: Pedido % - Status: % -> %, sent_at: % -> %', 
      NEW.id, OLD.status, NEW.status, OLD.sent_at, NEW.sent_at;
    
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
        
        -- Si no hay items o el monto es 0, usar total_amount del pedido
        IF v_total_items = 0 OR v_total_amount = 0 THEN
          v_total_items := 1; -- Mínimo 1 para que aparezca
          v_total_amount := COALESCE(NEW.total_amount, 0);
        END IF;
      EXCEPTION WHEN OTHERS THEN
        -- Si hay error, usar valores del pedido
        v_total_items := 1;
        v_total_amount := COALESCE(NEW.total_amount, 0);
        RAISE WARNING 'Error calculando items/monto para pedido %: %', NEW.id, SQLERRM;
      END;
      
      -- Verificar que no exista ya un registro para este envío
      -- Usamos una combinación de campos para evitar duplicados
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

-- PASO 4: Asegurar que el trigger existe y está activo
DROP TRIGGER IF EXISTS trigger_register_envio_sale ON public.orders;

CREATE TRIGGER trigger_register_envio_sale
  AFTER UPDATE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.register_envio_to_daily_sales();

-- PASO 5: Asegurar que la política RLS permite inserciones desde el trigger
DROP POLICY IF EXISTS daily_sales_admin_all ON public.daily_sales;

CREATE POLICY daily_sales_admin_all ON public.daily_sales
  FOR ALL
  USING (
    -- Permitir si es admin autenticado
    (auth.role() = 'authenticated' AND EXISTS (SELECT 1 FROM public.admins a WHERE a.user_id = auth.uid()))
    OR
    -- Permitir si created_by es NULL (inserción desde trigger con SECURITY DEFINER)
    created_by IS NULL
  )
  WITH CHECK (
    -- Permitir si es admin autenticado
    (auth.role() = 'authenticated' AND EXISTS (SELECT 1 FROM public.admins a WHERE a.user_id = auth.uid()))
    OR
    -- Permitir si created_by es NULL (inserción desde trigger)
    created_by IS NULL
  );

-- PASO 6: Verificar que todo está correcto
DO $$
BEGIN
  -- Verificar trigger
  IF EXISTS (
    SELECT 1 FROM pg_trigger 
    WHERE tgname = 'trigger_register_envio_sale'
    AND tgrelid = 'public.orders'::regclass
    AND tgenabled = 'O'
  ) THEN
    RAISE NOTICE '✅ Trigger creado y activo';
  ELSE
    RAISE EXCEPTION '❌ Error: El trigger no está activo';
  END IF;
  
  -- Verificar función
  IF EXISTS (
    SELECT 1 FROM pg_proc 
    WHERE proname = 'register_envio_to_daily_sales'
  ) THEN
    RAISE NOTICE '✅ Función register_envio_to_daily_sales existe';
  ELSE
    RAISE EXCEPTION '❌ Error: La función no existe';
  END IF;
  
  -- Verificar política RLS
  IF EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'daily_sales'
    AND policyname = 'daily_sales_admin_all'
  ) THEN
    RAISE NOTICE '✅ Política RLS configurada correctamente';
  ELSE
    RAISE EXCEPTION '❌ Error: La política RLS no existe';
  END IF;
  
  RAISE NOTICE '✅ ✅ ✅ Todo está configurado correctamente';
  RAISE NOTICE '📝 Prueba finalizando un pedido y verifica que aparece en daily-sales.html';
END $$;

-- PASO 7: Recargar esquema
SELECT pg_notify('pgrst', 'reload schema');

