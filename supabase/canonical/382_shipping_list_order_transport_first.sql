-- 382 — Lista de envíos: un pedido aparece en una sola planilla de transporte.
--
-- Problema: rpc_get_shipping_orders / rpc_get_shipping_orders_range filtraban
-- (o.transport_id = X OR c.transport_id = X). Si el transporte del pedido y el
-- de la ficha del cliente diferían (ej. cliente pasó de SEDE a Expreso Norte),
-- el pedido salía en las dos planillas.
--
-- Criterio: transporte del pedido; si es NULL, el de la ficha del cliente
-- (COALESCE(o.transport_id, c.transport_id)).
--
-- Para que el transporte del pedido coincida con el rótulo, rpc_mark_labels_printed
-- guarda en orders.transport_id el mismo transporte que usa el rótulo en
-- admin/closed-orders.js (ficha del cliente primero, pedido como fallback).
-- rpc_update_customer_transport no toca pedidos con rótulos impresos (patch 322),
-- así que sin este snapshot un cambio + reimpresión dejaría el pedido con el
-- transporte viejo.
--
-- CREATE OR REPLACE conserva owner y grants (authenticated + service_role).
-- Rollback: 382_ROLLBACK_shipping_list_order_transport_first.sql

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
    AND COALESCE(o.transport_id, c.transport_id) = p_transport_id
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
    AND (p_transport_id IS NULL OR COALESCE(o.transport_id, c.transport_id) = p_transport_id)
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

  -- Mismo orden que el rótulo en admin/closed-orders.js: ficha del cliente, luego pedido.
  update public.orders o
     set labels_printed = true,
         transport_id = coalesce(
           (select c.transport_id from public.customers c where c.id = o.customer_id),
           o.transport_id
         ),
         updated_at = now()
   where o.id = p_order_id;

  if not found then
    raise exception 'Pedido no encontrado';
  end if;
end;
$function$;

COMMIT;
