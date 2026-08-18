-- 239_shipping_list_label_identity.sql
-- Listas de envío / Excel: respetar orders.label_customer_name y label_customer_dni
-- fijados al elegir titular o sub-nombre (pedidos cerrados / enviados).

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

SELECT pg_notify('pgrst', 'reload schema');
