-- 67_DAILY_SALES_ENVIOS_DESDE_CERO.sql — Solución desde cero para registrar envíos en daily_sales
-- Esta solución modifica directamente rpc_mark_order_as_sent para insertar en daily_sales
-- Sin depender de triggers complicados

-- PASO 1: Eliminar triggers y funciones antiguas relacionadas con envíos
DROP TRIGGER IF EXISTS trigger_register_envio_sale ON public.orders;
DROP FUNCTION IF EXISTS public.register_envio_to_daily_sales();

-- PASO 2: Asegurar que la política RLS permite inserciones desde funciones SECURITY DEFINER
DROP POLICY IF EXISTS daily_sales_admin_all ON public.daily_sales;

CREATE POLICY daily_sales_admin_all ON public.daily_sales
  FOR ALL
  USING (
    -- Permitir si es admin autenticado
    (auth.role() = 'authenticated' AND EXISTS (SELECT 1 FROM public.admins a WHERE a.user_id = auth.uid()))
    OR
    -- Permitir si created_by es NULL (inserción desde función SECURITY DEFINER)
    created_by IS NULL
  )
  WITH CHECK (
    -- Permitir si es admin autenticado
    (auth.role() = 'authenticated' AND EXISTS (SELECT 1 FROM public.admins a WHERE a.user_id = auth.uid()))
    OR
    -- Permitir si created_by es NULL (inserción desde función SECURITY DEFINER)
    created_by IS NULL
  );

-- PASO 3: Recrear rpc_mark_order_as_sent con inserción directa en daily_sales
DROP FUNCTION IF EXISTS public.rpc_mark_order_as_sent(uuid);

CREATE OR REPLACE FUNCTION public.rpc_mark_order_as_sent(p_order_id uuid)
RETURNS void 
LANGUAGE plpgsql 
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order_record RECORD;
  v_customer_name text;
  v_sale_time time;
  v_total_items int;
  v_total_amount numeric;
  v_sent_at timestamptz;
BEGIN
  -- Verificar que el usuario es admin
  IF NOT EXISTS (
    SELECT 1 FROM public.admins
    WHERE user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Solo administradores pueden marcar pedidos como terminados';
  END IF;

  -- Obtener información del pedido
  SELECT 
    o.id,
    o.status,
    o.customer_id,
    o.total_amount,
    o.sent_at,
    now() as new_sent_at
  INTO v_order_record
  FROM public.orders o
  WHERE o.id = p_order_id;

  -- Verificar que el pedido existe
  IF v_order_record.id IS NULL THEN
    RAISE EXCEPTION 'El pedido no existe';
  END IF;

  -- Verificar que el pedido está cerrado
  IF v_order_record.status != 'closed' THEN
    RAISE EXCEPTION 'El pedido debe estar cerrado antes de marcarlo como enviado';
  END IF;

  -- Establecer sent_at
  v_sent_at := now();

  -- Actualizar el estado del pedido a 'sent' (terminado/enviado) y establecer sent_at
  UPDATE public.orders
  SET status = 'sent',
      sent_at = v_sent_at,
      updated_at = now()
  WHERE id = p_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No se pudo marcar el pedido como terminado';
  END IF;

  -- ============================================
  -- INSERTAR DIRECTAMENTE EN daily_sales
  -- ============================================
  
  -- Obtener nombre del cliente
  IF v_order_record.customer_id IS NOT NULL THEN
    BEGIN
      SELECT COALESCE(full_name, 'Cliente sin nombre')
      INTO v_customer_name
      FROM public.customers
      WHERE id = v_order_record.customer_id;
    EXCEPTION WHEN OTHERS THEN
      v_customer_name := 'Cliente sin nombre';
    END;
  ELSE
    v_customer_name := 'Cliente sin nombre';
  END IF;
  
  -- Extraer hora de sent_at
  v_sale_time := (v_sent_at::time);
  
  -- Calcular cantidad de items y monto total
  BEGIN
    SELECT 
      COUNT(*), 
      COALESCE(SUM(quantity * COALESCE(price_snapshot, 0)), 0)
    INTO v_total_items, v_total_amount
    FROM public.order_items
    WHERE order_id = p_order_id
      AND status != 'cancelled';
    
    -- Si no hay items o el monto es 0, usar total_amount del pedido
    IF v_total_items = 0 OR v_total_amount = 0 THEN
      v_total_items := 1; -- Mínimo 1 para que aparezca
      v_total_amount := COALESCE(v_order_record.total_amount, 0);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Si hay error, usar valores del pedido
    v_total_items := 1;
    v_total_amount := COALESCE(v_order_record.total_amount, 0);
  END;
  
  -- Verificar que no exista ya un registro para este envío
  -- Usamos una combinación de campos para evitar duplicados
  IF NOT EXISTS (
    SELECT 1 FROM public.daily_sales
    WHERE sale_date = v_sent_at::date
      AND sale_type = 'envios'
      AND sale_time = v_sale_time
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
      v_sent_at::date,
      'envios',
      v_sale_time,
      v_customer_name,
      v_total_items,
      v_total_amount,
      NULL  -- NULL porque estamos en una función SECURITY DEFINER
    );
    
    RAISE NOTICE '✅ Pedido marcado como enviado y registrado en daily_sales: Fecha=%, Hora=%, Cliente=%, Monto=%', 
      v_sent_at::date, v_sale_time, v_customer_name, v_total_amount;
  ELSE
    RAISE NOTICE '⚠️ Ya existe un registro similar en daily_sales para este pedido';
  END IF;

END;
$$;

-- PASO 4: Verificar que todo está correcto
DO $$
BEGIN
  -- Verificar función
  IF EXISTS (
    SELECT 1 FROM pg_proc 
    WHERE proname = 'rpc_mark_order_as_sent'
  ) THEN
    RAISE NOTICE '✅ Función rpc_mark_order_as_sent recreada correctamente';
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
  
  RAISE NOTICE '✅ ✅ ✅ Solución implementada desde cero';
  RAISE NOTICE '📝 Ahora cuando marques un pedido como TERMINADO, se registrará automáticamente en daily_sales';
  RAISE NOTICE '📝 Prueba marcando un pedido como terminado y verifica que aparece en daily-sales.html';
END $$;

-- PASO 5: Recargar esquema
SELECT pg_notify('pgrst', 'reload schema');

