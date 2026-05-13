-- 81_rpc_get_shipping_orders.sql — Lista de envíos por fecha y transporte (sin límite de filas)
-- Resuelve el problema de que la lista "Imprimir Lista de Envíos" solo mostraba 24 pedidos:
-- la consulta se ejecuta en el servidor (RPC) y devuelve todos los pedidos sin límite PostgREST.
-- Criterio: orders con status = 'sent' cuya fecha (sent_at/closed_at/updated_at en hora Argentina) = p_date
-- y cuyo transporte (order o customer) = p_transport_id. Alineado con el concepto de envíos del día.

create or replace function public.rpc_get_shipping_orders(
  p_date date,
  p_transport_id uuid
)
returns table (
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
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Solo admins
  if not exists (
    select 1 from public.admins
    where user_id = auth.uid()
  ) then
    raise exception 'Solo administradores pueden consultar la lista de envíos';
  end if;

  return query
  select
    o.id,
    o.order_number,
    coalesce(c.full_name, 'Sin nombre'),
    coalesce(c.dni, ''),
    coalesce(c.address, 'Sin dirección'),
    coalesce(c.city, ''),
    coalesce(c.province, ''),
    coalesce(c.phone, 'Sin teléfono'),
    coalesce(
      (select sum(oi.quantity) from public.order_items oi
       where oi.order_id = o.id and oi.status != 'cancelled'),
      0
    )::bigint,
    coalesce(o.labels_count, 1),
    coalesce(o.total_amount, 0),
    o.payment_method
  from public.orders o
  left join public.customers c on c.id = o.customer_id
  where o.status = 'sent'
    and not exists (
      select 1
      from public.local_orders lo
      where lo.source_order_id = o.id
        and lo.status <> 'cancelled'
    )
    and (
      (o.sent_at is not null and (o.sent_at at time zone 'UTC' at time zone 'America/Argentina/Buenos_Aires')::date = p_date)
      or (o.sent_at is null and o.closed_at is not null and (o.closed_at at time zone 'UTC' at time zone 'America/Argentina/Buenos_Aires')::date = p_date)
      or (o.sent_at is null and o.closed_at is null and o.updated_at is not null and (o.updated_at at time zone 'UTC' at time zone 'America/Argentina/Buenos_Aires')::date = p_date)
    )
    and (o.transport_id = p_transport_id or c.transport_id = p_transport_id)
  order by o.sent_at nulls last, o.closed_at nulls last, o.updated_at nulls last, o.id;
end;
$$;

-- RPC para extracción Excel: mismo criterio de envíos en un rango de fechas (sin límite de filas)
create or replace function public.rpc_get_shipping_orders_range(
  p_start_date date,
  p_end_date date,
  p_transport_id uuid default null
)
returns table (
  sent_at timestamptz,
  customer_name text,
  payment_method text,
  total_amount numeric,
  transport_name text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.admins
    where user_id = auth.uid()
  ) then
    raise exception 'Solo administradores pueden exportar listas de envíos';
  end if;

  return query
  select
    coalesce(o.sent_at, o.closed_at, o.updated_at),
    coalesce(c.full_name, 'Sin nombre'),
    coalesce(o.payment_method, 'Sin especificar'),
    coalesce(o.total_amount, 0),
    coalesce(t.name, 'Sin transporte asignado')
  from public.orders o
  left join public.customers c on c.id = o.customer_id
  left join public.transports t on t.id = coalesce(o.transport_id, c.transport_id)
  where o.status = 'sent'
    and not exists (
      select 1
      from public.local_orders lo
      where lo.source_order_id = o.id
        and lo.status <> 'cancelled'
    )
    and (
      (o.sent_at is not null and (o.sent_at at time zone 'UTC' at time zone 'America/Argentina/Buenos_Aires')::date between p_start_date and p_end_date)
      or (o.sent_at is null and o.closed_at is not null and (o.closed_at at time zone 'UTC' at time zone 'America/Argentina/Buenos_Aires')::date between p_start_date and p_end_date)
      or (o.sent_at is null and o.closed_at is null and o.updated_at is not null and (o.updated_at at time zone 'UTC' at time zone 'America/Argentina/Buenos_Aires')::date between p_start_date and p_end_date)
    )
    and (p_transport_id is null or o.transport_id = p_transport_id or c.transport_id = p_transport_id)
  order by coalesce(o.sent_at, o.closed_at, o.updated_at), o.id;
end;
$$;

select pg_notify('pgrst', 'reload schema');
