-- 242_customer_invoice_preferences.sql
-- Preferencias de facturación por cliente: algunos clientes piden factura por el
-- 100% del pedido (en vez del 30% por defecto) y/o siempre Factura A sin importar
-- los dígitos del DNI/CUIT cargado. Se configuran en la ficha del cliente
-- (admin/customers.html) y se usan al facturar desde la Lista de Envíos.

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS invoice_full_amount boolean NOT NULL DEFAULT false;

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS invoice_always_a boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.customers.invoice_full_amount IS
  'Si es true, al facturar este cliente se declara el 100% del total del pedido en vez del 30% por defecto.';
COMMENT ON COLUMN public.customers.invoice_always_a IS
  'Si es true, al facturar este cliente siempre se emite Factura A, sin importar los dígitos del DNI/CUIT cargado.';

-- Cambia el conteo de parámetros de ambas funciones: hay que dropearlas antes de
-- recrearlas, si no queda un overload viejo colgado junto al nuevo.
DROP FUNCTION IF EXISTS public.rpc_update_admin_customer(uuid, text, text, text, text, text, text, text, jsonb);
DROP FUNCTION IF EXISTS public.rpc_create_admin_customer(text, text, text, text, text, text, text, jsonb);

-- Limpieza adicional: ya existían overloads aún más viejos (previos a
-- 237_customers_additional_names, sin p_additional_names) que habían quedado
-- colgados sin dropear en su momento. Se eliminan acá para no acumular más
-- versiones ambiguas de estas mismas funciones.
DROP FUNCTION IF EXISTS public.rpc_create_admin_customer(text, text, text, text, text, text, text);
DROP FUNCTION IF EXISTS public.rpc_update_admin_customer(uuid, text, text, text, text, text, text, text);

CREATE OR REPLACE FUNCTION public.rpc_update_admin_customer(
  p_customer_id uuid,
  p_full_name text,
  p_email text DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_dni text DEFAULT NULL,
  p_address text DEFAULT NULL,
  p_city text DEFAULT NULL,
  p_province text DEFAULT NULL,
  p_additional_names jsonb DEFAULT '[]'::jsonb,
  p_invoice_full_amount boolean DEFAULT false,
  p_invoice_always_a boolean DEFAULT false
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_admin_check boolean;
  v_additional_names jsonb;
BEGIN
  SELECT EXISTS(SELECT 1 FROM public.admins WHERE user_id = auth.uid()) INTO v_admin_check;
  IF NOT v_admin_check THEN
    RETURN json_build_object('success', false, 'message', 'No autorizado. Solo administradores pueden actualizar clientes.');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.customers WHERE id = p_customer_id) THEN
    RETURN json_build_object('success', false, 'message', 'Cliente no encontrado');
  END IF;

  IF p_additional_names IS NULL THEN
    v_additional_names := '[]'::jsonb;
  ELSIF jsonb_typeof(p_additional_names) <> 'array' THEN
    RETURN json_build_object('success', false, 'message', 'Nombres adicionales inválidos');
  ELSIF jsonb_array_length(p_additional_names) > 3 THEN
    RETURN json_build_object('success', false, 'message', 'Máximo 3 nombres adicionales');
  ELSE
    v_additional_names := p_additional_names;
  END IF;

  UPDATE public.customers
  SET
    full_name = p_full_name,
    email = COALESCE(p_email, email),
    phone = p_phone,
    dni = COALESCE(p_dni, dni),
    address = p_address,
    city = p_city,
    province = p_province,
    additional_names = v_additional_names,
    invoice_full_amount = COALESCE(p_invoice_full_amount, false),
    invoice_always_a = COALESCE(p_invoice_always_a, false),
    updated_at = now()
  WHERE id = p_customer_id;

  RETURN json_build_object(
    'success', true,
    'customer_id', p_customer_id,
    'message', 'Cliente actualizado con éxito'
  );

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('success', false, 'message', SQLERRM);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_create_admin_customer(
  p_full_name text,
  p_email text DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_dni text DEFAULT NULL,
  p_address text DEFAULT NULL,
  p_city text DEFAULT NULL,
  p_province text DEFAULT NULL,
  p_additional_names jsonb DEFAULT '[]'::jsonb,
  p_invoice_full_amount boolean DEFAULT false,
  p_invoice_always_a boolean DEFAULT false
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_customer_id uuid;
  v_admin_check boolean;
  v_customer_number text;
  v_additional_names jsonb;
BEGIN
  SELECT EXISTS(SELECT 1 FROM public.admins WHERE user_id = auth.uid()) INTO v_admin_check;
  IF NOT v_admin_check THEN
    RETURN json_build_object('success', false, 'message', 'No autorizado');
  END IF;

  IF p_additional_names IS NULL THEN
    v_additional_names := '[]'::jsonb;
  ELSIF jsonb_typeof(p_additional_names) <> 'array' THEN
    RETURN json_build_object('success', false, 'message', 'Nombres adicionales inválidos');
  ELSIF jsonb_array_length(p_additional_names) > 3 THEN
    RETURN json_build_object('success', false, 'message', 'Máximo 3 nombres adicionales');
  ELSE
    v_additional_names := p_additional_names;
  END IF;

  v_customer_id := gen_random_uuid();
  SELECT public.generate_customer_number() INTO v_customer_number;

  INSERT INTO public.customers (
    id,
    customer_number,
    full_name,
    email,
    phone,
    dni,
    address,
    city,
    province,
    additional_names,
    invoice_full_amount,
    invoice_always_a,
    created_by_admin,
    created_at,
    updated_at
  ) VALUES (
    v_customer_id,
    v_customer_number,
    p_full_name,
    p_email,
    p_phone,
    p_dni,
    p_address,
    p_city,
    p_province,
    v_additional_names,
    COALESCE(p_invoice_full_amount, false),
    COALESCE(p_invoice_always_a, false),
    true,
    now(),
    now()
  );

  RETURN json_build_object(
    'success', true,
    'customer_id', v_customer_id,
    'customer_number', v_customer_number,
    'message', 'Cliente creado con éxito'
  );

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('success', false, 'message', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_update_admin_customer(uuid, text, text, text, text, text, text, text, jsonb, boolean, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_create_admin_customer(text, text, text, text, text, text, text, jsonb, boolean, boolean) TO authenticated;

-- rpc_get_shipping_orders: sumar los dos flags del cliente para que la Lista de
-- Envíos sepa, por pedido, si hay que facturar 100% y/o forzar Factura A.
DROP FUNCTION IF EXISTS public.rpc_get_shipping_orders(date, uuid);

CREATE OR REPLACE FUNCTION public.rpc_get_shipping_orders(
  p_date date,
  p_transport_id uuid
)
RETURNS TABLE (
  id uuid,
  order_number text,
  customer_name text,
  primary_customer_name text,
  dni text,
  address text,
  city text,
  province text,
  phone text,
  items_count bigint,
  packages_count integer,
  total_amount numeric,
  payment_method text,
  invoice_full_amount boolean,
  invoice_always_a boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.admins
    WHERE user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Solo administradores pueden consultar la lista de envíos';
  END IF;

  RETURN QUERY
  SELECT
    o.id,
    o.order_number,
    COALESCE(NULLIF(btrim(o.label_customer_name), ''), c.full_name, 'Sin nombre'),
    COALESCE(NULLIF(btrim(c.full_name), ''), 'Sin nombre'),
    COALESCE(NULLIF(btrim(o.label_customer_dni), ''), c.dni, ''),
    COALESCE(c.address, 'Sin dirección'),
    COALESCE(c.city, ''),
    COALESCE(c.province, ''),
    COALESCE(c.phone, 'Sin teléfono'),
    COALESCE(
      (SELECT SUM(oi.quantity) FROM public.order_items oi
       WHERE oi.order_id = o.id AND oi.status != 'cancelled'),
      0
    )::bigint,
    COALESCE(o.labels_count, 1),
    COALESCE(o.total_amount, 0),
    o.payment_method,
    COALESCE(c.invoice_full_amount, false),
    COALESCE(c.invoice_always_a, false)
  FROM public.orders o
  LEFT JOIN public.customers c ON c.id = o.customer_id
  WHERE o.status = 'sent'
    AND o.sent_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.local_orders lo
      WHERE lo.source_order_id = o.id
        AND lo.status <> 'cancelled'
    )
    AND (o.sent_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date = p_date
    AND (o.transport_id = p_transport_id OR c.transport_id = p_transport_id)
  ORDER BY o.sent_at, o.id;
END;
$$;

SELECT pg_notify('pgrst', 'reload schema');
