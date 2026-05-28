-- 228_rpc_shipping_orders_range_excel_legacy.sql
-- Excel «Extraer»: incluir pedidos sent históricos sin sent_at (fecha = COALESCE(sent_at, closed_at, updated_at) en BA).
-- La lista diaria (rpc_get_shipping_orders) sigue solo sent_at (227).
-- Transporte: COALESCE(customer, order) como en la UI de pedidos cerrados.

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
    COALESCE(o.sent_at, o.closed_at, o.updated_at),
    COALESCE(c.full_name, 'Sin nombre'),
    COALESCE(o.payment_method, 'Sin especificar'),
    COALESCE(o.total_amount, 0),
    COALESCE(t.name, 'Sin transporte asignado')
  FROM public.orders o
  LEFT JOIN public.customers c ON c.id = o.customer_id
  LEFT JOIN public.transports t ON t.id = COALESCE(c.transport_id, o.transport_id)
  WHERE o.status = 'sent'
    AND NOT EXISTS (
      SELECT 1
      FROM public.local_orders lo
      WHERE lo.source_order_id = o.id
        AND lo.status <> 'cancelled'
    )
    AND (
      COALESCE(o.sent_at, o.closed_at, o.updated_at) AT TIME ZONE 'America/Argentina/Buenos_Aires'
    )::date BETWEEN p_start_date AND p_end_date
    AND (
      p_transport_id IS NULL
      OR COALESCE(c.transport_id, o.transport_id) = p_transport_id
      OR (
        COALESCE(c.transport_id, o.transport_id) IS NOT NULL
        AND public.normalize_transport_name(
          (SELECT tr.name FROM public.transports tr WHERE tr.id = COALESCE(c.transport_id, o.transport_id))
        ) = (
          SELECT public.normalize_transport_name(tr2.name)
          FROM public.transports tr2
          WHERE tr2.id = p_transport_id
        )
      )
    )
  ORDER BY COALESCE(o.sent_at, o.closed_at, o.updated_at), o.id;
END;
$$;

SELECT pg_notify('pgrst', 'reload schema');
