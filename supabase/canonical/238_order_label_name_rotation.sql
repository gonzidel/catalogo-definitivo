-- 238_order_label_name_rotation.sql
-- Rótulos/listas: rotación nombre principal + sub-nombres por cliente.

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS label_name_cursor integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.customers.label_name_cursor IS
  'Índice circular para elegir el nombre del rótulo (principal + sub-nombres).';

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS label_customer_name text,
  ADD COLUMN IF NOT EXISTS label_customer_dni text;

COMMENT ON COLUMN public.orders.label_customer_name IS
  'Nombre impreso en rótulo/lista de envío para este pedido (fijado al imprimir).';
COMMENT ON COLUMN public.orders.label_customer_dni IS
  'DNI asociado al nombre del rótulo para este pedido.';

CREATE OR REPLACE FUNCTION public.rpc_resolve_order_label_identity(p_order_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_admin_check boolean;
  v_order record;
  v_customer record;
  v_pool jsonb := '[]'::jsonb;
  v_pool_len int;
  v_idx int;
  v_entry jsonb;
  v_name text;
  v_dni text;
  v_additional jsonb;
  v_item jsonb;
  v_sub_name text;
  i int;
  v_max_sub int;
BEGIN
  SELECT EXISTS(SELECT 1 FROM public.admins WHERE user_id = auth.uid()) INTO v_admin_check;
  IF NOT v_admin_check THEN
    RETURN json_build_object('success', false, 'message', 'No autorizado');
  END IF;

  SELECT o.id, o.customer_id, o.label_customer_name, o.label_customer_dni
  INTO v_order
  FROM public.orders o
  WHERE o.id = p_order_id;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'message', 'Pedido no encontrado');
  END IF;

  IF v_order.label_customer_name IS NOT NULL AND btrim(v_order.label_customer_name) <> '' THEN
    RETURN json_build_object(
      'success', true,
      'customer_name', v_order.label_customer_name,
      'customer_dni', COALESCE(v_order.label_customer_dni, ''),
      'reused', true
    );
  END IF;

  SELECT
    c.full_name,
    c.dni,
    COALESCE(c.additional_names, '[]'::jsonb) AS additional_names,
    COALESCE(c.label_name_cursor, 0) AS label_name_cursor
  INTO v_customer
  FROM public.customers c
  WHERE c.id = v_order.customer_id;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'message', 'Cliente no encontrado');
  END IF;

  v_pool := jsonb_build_array(
    jsonb_build_object(
      'full_name', COALESCE(NULLIF(btrim(v_customer.full_name), ''), 'Sin nombre'),
      'dni', NULLIF(btrim(v_customer.dni), '')
    )
  );

  v_additional := COALESCE(v_customer.additional_names, '[]'::jsonb);
  IF jsonb_typeof(v_additional) = 'array' THEN
    v_max_sub := LEAST(jsonb_array_length(v_additional), 3);
    FOR i IN 0..v_max_sub - 1 LOOP
      v_item := v_additional -> i;
      v_sub_name := COALESCE(
        NULLIF(btrim(v_item ->> 'full_name'), ''),
        NULLIF(btrim(concat_ws(' ', v_item ->> 'first_name', v_item ->> 'last_name')), ''),
        NULLIF(btrim(v_item ->> 'name'), '')
      );
      IF v_sub_name IS NOT NULL THEN
        v_pool := v_pool || jsonb_build_array(
          jsonb_build_object(
            'full_name', v_sub_name,
            'dni', NULLIF(btrim(v_item ->> 'dni'), '')
          )
        );
      END IF;
    END LOOP;
  END IF;

  v_pool_len := jsonb_array_length(v_pool);
  v_idx := CASE
    WHEN v_pool_len <= 1 THEN 0
    ELSE COALESCE(v_customer.label_name_cursor, 0) % v_pool_len
  END;

  v_entry := v_pool -> v_idx;
  v_name := v_entry ->> 'full_name';
  v_dni := v_entry ->> 'dni';

  IF v_pool_len > 1 THEN
    UPDATE public.customers
    SET
      label_name_cursor = (v_idx + 1) % v_pool_len,
      updated_at = now()
    WHERE id = v_order.customer_id;
  END IF;

  UPDATE public.orders
  SET
    label_customer_name = v_name,
    label_customer_dni = v_dni,
    updated_at = now()
  WHERE id = p_order_id;

  RETURN json_build_object(
    'success', true,
    'customer_name', v_name,
    'customer_dni', COALESCE(v_dni, ''),
    'reused', false,
    'pool_size', v_pool_len
  );

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('success', false, 'message', SQLERRM);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_get_shipping_orders(
  p_date date,
  p_transport_id uuid
)
RETURNS TABLE (
  id uuid,
  order_number text,
  customer_name text,
  dni text,
  address text,
  city text,
  province text,
  phone text,
  items_count bigint,
  packages_count integer,
  total_amount numeric,
  payment_method text
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
    o.payment_method
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

CREATE OR REPLACE FUNCTION public.rpc_get_shipping_orders_range(
  p_start_date date,
  p_end_date date,
  p_transport_id uuid DEFAULT NULL
)
RETURNS TABLE (
  sent_at timestamptz,
  customer_name text,
  payment_method text,
  total_amount numeric,
  transport_name text
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
    RAISE EXCEPTION 'Solo administradores pueden exportar listas de envíos';
  END IF;

  RETURN QUERY
  SELECT
    o.sent_at,
    COALESCE(NULLIF(btrim(o.label_customer_name), ''), c.full_name, 'Sin nombre'),
    COALESCE(o.payment_method, 'Sin especificar'),
    COALESCE(o.total_amount, 0),
    COALESCE(t.name, 'Sin transporte asignado')
  FROM public.orders o
  LEFT JOIN public.customers c ON c.id = o.customer_id
  LEFT JOIN public.transports t ON t.id = COALESCE(o.transport_id, c.transport_id)
  WHERE o.status = 'sent'
    AND o.sent_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.local_orders lo
      WHERE lo.source_order_id = o.id
        AND lo.status <> 'cancelled'
    )
    AND (o.sent_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
      BETWEEN p_start_date AND p_end_date
    AND (p_transport_id IS NULL OR o.transport_id = p_transport_id OR c.transport_id = p_transport_id)
  ORDER BY o.sent_at, o.id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_resolve_order_label_identity(uuid) TO authenticated;

SELECT pg_notify('pgrst', 'reload schema');
