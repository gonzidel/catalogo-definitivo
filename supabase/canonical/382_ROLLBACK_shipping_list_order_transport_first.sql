-- ROLLBACK 382 — restaura las definiciones de producción previas (leídas de fyl-core el 2026-10-11).
-- No revierte orders.transport_id ya actualizados por rpc_mark_labels_printed: esos valores
-- son el transporte con el que se imprimió el rótulo.

BEGIN;

CREATE OR REPLACE FUNCTION public.rpc_get_shipping_orders(p_date date, p_transport_id uuid)
 RETURNS TABLE(id uuid, order_number text, customer_name text, primary_customer_name text, dni text, address text, city text, province text, phone text, items_count bigint, packages_count integer, total_amount numeric, payment_method text, invoice_full_amount boolean, invoice_always_a boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    AND (o.sent_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date = p_date
    AND (o.transport_id = p_transport_id OR c.transport_id = p_transport_id)
  ORDER BY o.sent_at, o.id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rpc_get_shipping_orders_range(p_start_date date, p_end_date date, p_transport_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(sent_at timestamp with time zone, customer_name text, payment_method text, total_amount numeric, transport_name text, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.rpc_mark_labels_printed(p_order_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
begin
  if not exists (
    select 1 from public.admins
    where user_id = auth.uid()
  ) then
    raise exception 'Solo administradores pueden marcar rótulos como impresos';
  end if;

  update public.orders
     set labels_printed = true,
         updated_at = now()
   where id = p_order_id;

  if not found then
    raise exception 'Pedido no encontrado';
  end if;
end;
$function$;

COMMIT;
