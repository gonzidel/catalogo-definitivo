-- 254_shipping_extract_include_devolucion.sql
-- Objetivo: que un pedido marcado como "devolución" en sent-orders.html se
-- refleje en el Excel de "Extraer" de closed-orders.html (tab Extraer del
-- modal "Imprimir Lista de Envíos").
--
-- Antes: rpc_get_shipping_orders_range solo devolvía pedidos con
-- status = 'sent', así que un pedido marcado como devolución (status pasa a
-- 'devolución') desaparecía del extracto histórico, aunque conserva su
-- sent_at (rpc_mark_order_as_devolucion no lo toca).
--
-- Ahora: se incluyen también los pedidos con status = 'devolución' y se
-- agrega la columna `status` al resultado para que el frontend pueda mostrar
-- "Devolución" en la columna de pago en vez del método de pago original
-- (ej. contrareembolso).

-- Se agrega una columna nueva (`status`) al RETURNS TABLE, lo que Postgres no
-- permite vía CREATE OR REPLACE (error "cannot change return type of
-- existing function"). Hay que dropear la función antes de recrearla.
DROP FUNCTION IF EXISTS public.rpc_get_shipping_orders_range(date, date, uuid);

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
  transport_name text,
  status text
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
    COALESCE(t.name, 'Sin transporte asignado'),
    o.status
  FROM public.orders o
  LEFT JOIN public.customers c ON c.id = o.customer_id
  LEFT JOIN public.transports t ON t.id = COALESCE(o.transport_id, c.transport_id)
  WHERE o.status IN ('sent', 'devolución')
    AND o.sent_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.local_orders lo
      WHERE lo.source_order_id = o.id
        AND lo.status <> 'cancelled'
    )
    AND (o.sent_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
      BETWEEN p_start_date AND p_end_date
    AND (p_transport_id IS NULL OR o.transport_id = p_transport_id OR c.transport_id = p_transport_id)
  ORDER BY o.sent_at, o.id;
END;
$$;

SELECT pg_notify('pgrst', 'reload schema');
