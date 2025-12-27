-- 19_enable_order_number_trigger.sql — Habilitar trigger de números de pedido (idempotente)
-- Este script habilita el trigger que asigna números de pedido automáticamente
-- y corrige pedidos existentes sin número

-- 1) Habilitar el trigger
ALTER TABLE public.orders ENABLE TRIGGER assign_order_number_trigger;

-- 2) Asignar números a pedidos existentes sin número
DO $$
DECLARE
  order_record record;
  new_order_number text;
BEGIN
  FOR order_record IN 
    SELECT id, created_at
    FROM public.orders
    WHERE order_number IS NULL
    ORDER BY created_at
  LOOP
    -- Generar número de pedido para este pedido
    SELECT public.generate_order_number() INTO new_order_number;
    
    -- Actualizar el pedido con el número generado
    UPDATE public.orders
    SET order_number = new_order_number
    WHERE id = order_record.id;
    
    RAISE NOTICE 'Pedido % actualizado con número %', order_record.id, new_order_number;
  END LOOP;
END $$;

-- 3) Verificar que el trigger esté habilitado
DO $$
DECLARE
  trigger_status char;
BEGIN
  SELECT tgenabled INTO trigger_status
  FROM pg_trigger
  WHERE tgname = 'assign_order_number_trigger';
  
  IF trigger_status = 'O' THEN
    RAISE NOTICE '✅ Trigger assign_order_number_trigger está HABILITADO';
  ELSIF trigger_status = 'D' THEN
    RAISE WARNING '⚠️ Trigger assign_order_number_trigger está DESHABILITADO';
  ELSIF trigger_status = 'R' THEN
    RAISE WARNING '⚠️ Trigger assign_order_number_trigger está en modo REPLICA';
  ELSIF trigger_status = 'A' THEN
    RAISE WARNING '⚠️ Trigger assign_order_number_trigger está en modo ALWAYS';
  ELSE
    RAISE WARNING '⚠️ Trigger assign_order_number_trigger tiene estado desconocido: %', trigger_status;
  END IF;
END $$;

-- 4) Verificar que la función generate_order_number existe y funciona
DO $$
DECLARE
  test_order_number text;
BEGIN
  SELECT public.generate_order_number() INTO test_order_number;
  RAISE NOTICE '✅ Función generate_order_number funciona correctamente. Número de prueba: %', test_order_number;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '❌ Error en generate_order_number: %', sqlerrm;
END $$;

-- 5) Verificar pedidos sin número de pedido
DO $$
DECLARE
  orders_without_number int;
BEGIN
  SELECT COUNT(*) INTO orders_without_number
  FROM public.orders
  WHERE order_number IS NULL;
  
  IF orders_without_number > 0 THEN
    RAISE WARNING '⚠️ AÚN HAY % pedidos sin número de pedido después de la corrección', orders_without_number;
  ELSE
    RAISE NOTICE '✅ Todos los pedidos tienen número de pedido';
  END IF;
END $$;

select pg_notify('pgrst','reload schema');

