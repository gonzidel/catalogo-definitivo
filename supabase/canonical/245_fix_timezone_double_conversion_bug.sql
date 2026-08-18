-- 245_fix_timezone_double_conversion_bug.sql
-- Bug preexistente: varias funciones convertían timestamptz a hora Argentina con
-- "AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires'" (doble
-- conversión). Ese patrón es correcto SOLO para columnas timestamp SIN zona
-- horaria que ya guardan valores en UTC. Aplicado a un timestamptz real (que es
-- el tipo real de orders.sent_at, public_sales.created_at, invoices.created_at)
-- desplaza el resultado ~3hs para el lado equivocado y puede cambiar el día
-- calculado. Verificado con datos reales antes de corregir: 78/2944 pedidos
-- enviados quedaban bajo el día de envío equivocado en la Lista de Envíos, y
-- las 5516 filas de ventas "local" en daily_sales tenían el horario mal
-- calculado (4 de ellas también con el día equivocado).

-- 1) rpc_get_shipping_orders: corrige el día de envío usado para filtrar
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
    AND (o.sent_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date = p_date
    AND (o.transport_id = p_transport_id OR c.transport_id = p_transport_id)
  ORDER BY o.sent_at, o.id;
END;
$$;

-- 2) rpc_get_shipping_orders_range: mismo fix
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
    AND (o.sent_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
      BETWEEN p_start_date AND p_end_date
    AND (p_transport_id IS NULL OR o.transport_id = p_transport_id OR c.transport_id = p_transport_id)
  ORDER BY o.sent_at, o.id;
END;
$$;

-- 3) register_local_sale_to_daily_sales: corrige el trigger que inserta ventas
-- locales en daily_sales (esto sí escribe datos, no solo consulta)
CREATE OR REPLACE FUNCTION public.register_local_sale_to_daily_sales()
RETURNS trigger
LANGUAGE plpgsql
AS $$
declare
  v_customer_name text;
  v_sale_time time;
  v_total_items int;
begin
  if NEW.customer_id is not null then
    select coalesce(
      nullif(trim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')), ''),
      'Cliente sin nombre'
    )
    into v_customer_name
    from public.public_sales_customers
    where id = NEW.customer_id;
  else
    v_customer_name := 'Cliente sin nombre';
  end if;

  v_sale_time := ((NEW.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::time);
  v_total_items := NEW.item_count;

  insert into public.daily_sales (
    public_sale_id,
    sale_date,
    sale_type,
    sale_time,
    customer_name,
    product_quantity,
    sale_amount,
    created_by
  ) values (
    NEW.id,
    (NEW.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date,
    'local',
    v_sale_time,
    v_customer_name,
    v_total_items,
    NEW.total_amount,
    NEW.sold_by
  )
  on conflict (public_sale_id) do nothing;

  return NEW;
end;
$$;

-- 4) Backfill: recalcular sale_date/sale_time de las filas ya guardadas de
-- ventas "local", usando la fecha real intacta en public_sales.created_at.
-- Es la única categoría de daily_sales con un enlace confiable (public_sale_id)
-- para poder recalcular con seguridad; "envios" no tiene ese enlace y su
-- trigger (register_envio_to_daily_sales) ya estaba correcto, por eso no se
-- toca acá.
UPDATE public.daily_sales ds
SET
  sale_date = (ps.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date,
  sale_time = (ps.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::time,
  updated_at = now()
FROM public.public_sales ps
WHERE ds.public_sale_id = ps.id
  AND ds.sale_type = 'local'
  AND (
    ds.sale_date <> (ps.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
    OR ds.sale_time <> (ps.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::time
  );

SELECT pg_notify('pgrst', 'reload schema');
