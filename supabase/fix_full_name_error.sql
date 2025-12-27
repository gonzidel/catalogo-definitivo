-- Fix: Corregir error de columna "full_name" que no existe en public_sales_customers
-- Esta función debe usar first_name y last_name en lugar de full_name

CREATE OR REPLACE FUNCTION public.process_public_sale_for_daily_sales()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_customer_name text;
  v_sale_time time;
  v_total_items int;
BEGIN
  -- Obtener nombre del cliente si existe
  IF NEW.customer_id IS NOT NULL THEN
    SELECT COALESCE(
      first_name || ' ' || COALESCE(last_name, ''),
      'Cliente sin nombre'
    )
    INTO v_customer_name
    FROM public.public_sales_customers
    WHERE id = NEW.customer_id;
  ELSE
    v_customer_name := 'Cliente sin nombre';
  END IF;
  
  -- Extraer hora de created_at
  v_sale_time := NEW.created_at::time;
  
  -- Contar items de la venta
  SELECT COUNT(*) INTO v_total_items
  FROM public.public_sale_items
  WHERE sale_id = NEW.id;
  
  -- Insertar o actualizar registro en daily_sales
  INSERT INTO public.daily_sales (
    sale_date,
    sale_type,
    sale_time,
    customer_name,
    product_quantity,
    sale_amount,
    created_by
  )
  VALUES (
    NEW.created_at::date,
    'local',
    v_sale_time,
    v_customer_name,
    v_total_items,
    NEW.total_amount,
    NEW.sold_by
  )
  ON CONFLICT (sale_date, sale_type, sale_time, customer_name) 
  DO UPDATE SET
    product_quantity = daily_sales.product_quantity + v_total_items,
    sale_amount = daily_sales.sale_amount + NEW.total_amount,
    updated_at = now();
  
  RETURN NEW;
END;
$$;
