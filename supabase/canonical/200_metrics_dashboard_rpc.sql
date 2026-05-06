-- 200_metrics_dashboard_rpc.sql
-- RPC principal para el dashboard de métricas (B2B FYL).
-- Devuelve un único JSON con métricas negocio/operación/producto/comportamiento.

create or replace function public.metrics_dashboard(
  p_from date,
  p_to date
)
returns json
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_result json;
  v_from_utc timestamptz;
  v_to_utc_excl timestamptz;
begin
  if not public.is_admin() then
    raise exception 'Solo administradores pueden acceder a métricas';
  end if;

  if p_from is null or p_to is null then
    raise exception 'p_from/p_to no pueden ser null';
  end if;

  if p_to < p_from then
    raise exception 'p_to debe ser >= p_from';
  end if;

  -- Interpretar p_from/p_to como fechas locales (America/Argentina/Cordoba)
  -- y construir rango UTC [from_utc, to_utc_excl).
  v_from_utc := (p_from::timestamp) AT TIME ZONE 'America/Argentina/Cordoba';
  v_to_utc_excl := ((p_to + 1)::timestamp) AT TIME ZONE 'America/Argentina/Cordoba';

  with
  bounds as (
    select v_from_utc as from_utc, v_to_utc_excl as to_utc_excl
  ),

  -- Orders por estado (filtrado por timestamp del evento asociado)
  orders_active as (
    select o.id, o.customer_id
    from public.orders o
    join bounds b on true
    where o.status = 'active'
      and o.created_at >= b.from_utc
      and o.created_at <  b.to_utc_excl
  ),
  -- Apartado real FYL: todos los ítems operacionales en picked,
  -- sin waiting/reserved/missing y fuera de estados finales.
  orders_apartado as (
    select o.id, o.customer_id
    from public.orders o
    join bounds b on true
    where o.created_at >= b.from_utc
      and o.created_at <  b.to_utc_excl
      and o.status not in ('closed', 'sent', 'devolución', 'stock_pending')
      and exists (
        select 1
        from public.order_items oi
        where oi.order_id = o.id
          and coalesce(oi.status, '') <> 'cancelled'
      )
      and not exists (
        select 1
        from public.order_items oi
        where oi.order_id = o.id
          and coalesce(oi.status, '') <> 'cancelled'
          and oi.status in ('reserved', 'waiting', 'missing')
      )
      and not exists (
        select 1
        from public.order_items oi
        where oi.order_id = o.id
          and coalesce(oi.status, '') <> 'cancelled'
          and oi.status <> 'picked'
      )
  ),
  orders_enviado as (
    select o.id, o.customer_id, o.total_amount, o.sent_at
    from public.orders o
    join bounds b on true
    where o.status = 'sent'
      and o.sent_at is not null
      and o.sent_at >= b.from_utc
      and o.sent_at <  b.to_utc_excl
  ),
  orders_cerrado as (
    select o.id, o.customer_id, o.total_amount, o.sent_at, o.closed_at
    from public.orders o
    join bounds b on true
    where o.status = 'closed'
      and o.closed_at is not null
      and o.closed_at >= b.from_utc
      and o.closed_at <  b.to_utc_excl
  ),
  -- Cancelado: usar estado cancelado si existe en orders o pedidos con items cancelados.
  orders_cancelado as (
    select o.id, o.customer_id
    from public.orders o
    join bounds b on true
    where coalesce(o.updated_at, o.created_at) >= b.from_utc
      and coalesce(o.updated_at, o.created_at) <  b.to_utc_excl
      and (
        o.status = 'cancelled'
        or exists (
          select 1
          from public.order_items oi
          where oi.order_id = o.id
            and oi.status = 'cancelled'
        )
      )
  ),
  orders_devolucion as (
    select o.id, o.customer_id, o.total_amount, o.updated_at
    from public.orders o
    join bounds b on true
    where o.status = 'devolución'
      and o.updated_at is not null
      and o.updated_at >= b.from_utc
      and o.updated_at <  b.to_utc_excl
  ),

  -- Agregaciones escalares (SIN joins a order_items)
  agg_active as (
    select count(distinct id) as pedidos_activos from orders_active
  ),
  agg_apartado as (
    select count(distinct id) as pedidos_apartados from orders_apartado
  ),
  agg_enviado as (
    select
      count(distinct id) as pedidos_enviados,
      coalesce(sum(total_amount), 0) as ventas_enviadas
    from orders_enviado
  ),
  agg_cerrado as (
    select
      count(distinct id) as pedidos_cerrados,
      avg(extract(epoch from (sent_at - created_at)) / 3600.0) as tiempo_promedio_cierre_hours
    from public.orders o
    join bounds b on true
    where o.status = 'sent'
      and o.sent_at is not null
      and o.created_at is not null
      and o.sent_at >= b.from_utc
      and o.sent_at <  b.to_utc_excl
  ),
  agg_cancelado as (
    select count(distinct id) as pedidos_cancelados from orders_cancelado
  ),
  agg_devolucion as (
    select
      count(distinct id) as pedidos_devueltos,
      coalesce(sum(total_amount), 0) as devoluciones_amount
    from orders_devolucion
  ),

  -- Clientes: universo basado SOLO en pedidos enviados del rango
  customers_in_range as (
    select distinct o.customer_id
    from orders_enviado o
    where o.customer_id is not null
  ),
  first_purchases as (
    -- CLIENTE NUEVO = primera compra histórica (primer sent_at) sobre TODA orders.
    select
      o.customer_id,
      min(o.sent_at) as first_purchase_at
    from public.orders o
    where o.status = 'sent'
      and o.sent_at is not null
      and o.customer_id is not null
    group by o.customer_id
  ),
  agg_clients as (
    select
      count(*) as clientes_totales,
      count(*) filter (where fp.first_purchase_at >= b.from_utc and fp.first_purchase_at < b.to_utc_excl) as clientes_nuevos,
      count(*) filter (where fp.first_purchase_at <  b.from_utc) as clientes_recurrentes,
      count(*) filter (where fp.first_purchase_at <  b.from_utc) as clientes_que_volvieron
    from customers_in_range cir
    join first_purchases fp on fp.customer_id = cir.customer_id
    join bounds b on true
  ),

  -- Ventas netas: VENTA NETA = enviados - devoluciones
  agg_revenue as (
    select
      (ae.ventas_enviadas - ad.devoluciones_amount) as ventas_netas
    from agg_enviado ae
    cross join agg_devolucion ad
  ),

  -- Producto: ranking por VENTA NETA (sent_items - devolucion_items)
  item_lines as (
    select
      pv.product_id,
      p.name as product_name,
      pv.id as variant_id,
      pv.sku,
      pv.color,
      oi.size as talle,
      oi.quantity,
      coalesce(oi.price_snapshot, 0) as price_snapshot,
      case
        when o.status = 'sent' then oi.quantity
        when o.status = 'devolución' then -oi.quantity
        else 0
      end as units_signed,
      case
        when o.status = 'sent' then oi.quantity * coalesce(oi.price_snapshot, 0)
        when o.status = 'devolución' then -oi.quantity * coalesce(oi.price_snapshot, 0)
        else 0
      end as revenue_signed
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
    join bounds b on true
    join public.product_variants pv on pv.id = oi.variant_id
    join public.products p on p.id = pv.product_id
    where
      oi.variant_id is not null
      and oi.status <> 'cancelled'
      and (
        (o.status = 'sent' and o.sent_at is not null and o.sent_at >= b.from_utc and o.sent_at < b.to_utc_excl)
        or
        (o.status = 'devolución' and o.updated_at is not null and o.updated_at >= b.from_utc and o.updated_at < b.to_utc_excl)
      )
  ),
  top_productos as (
    select json_agg(x) as top_productos
    from (
      select
        il.product_id,
        il.product_name,
        sum(il.units_signed)::int as units_neta,
        sum(il.revenue_signed)::numeric as revenue_neta
      from item_lines il
      group by il.product_id, il.product_name
      order by revenue_neta desc
      limit 10
    ) x
  ),
  top_variantes as (
    select json_agg(x) as top_variantes
    from (
      select
        il.variant_id,
        il.sku,
        il.color,
        il.talle,
        sum(il.units_signed)::int as units_neta,
        sum(il.revenue_signed)::numeric as revenue_neta
      from item_lines il
      group by il.variant_id, il.sku, il.color, il.talle
      order by revenue_neta desc
      limit 10
    ) x
  ),
  top_talles as (
    select json_agg(x) as top_talles
    from (
      select
        trim(il.talle) as talle,
        sum(il.units_signed)::int as units_neta,
        sum(il.revenue_signed)::numeric as revenue_neta
      from item_lines il
      where il.talle is not null and trim(il.talle) <> ''
      group by trim(il.talle)
      order by revenue_neta desc
      limit 10
    ) x
  )

  select
    json_build_object(
      -- BLOQUE NEGOCIO
      'ventas_netas', ar.ventas_netas,
      'pedidos_enviados', ae.pedidos_enviados,
      'ticket_promedio', case
        when ae.pedidos_enviados > 0 then (ar.ventas_netas / ae.pedidos_enviados)
        else 0
      end,
      'clientes_nuevos', ac.clientes_nuevos,
      'clientes_recurrentes', ac.clientes_recurrentes,

      -- BLOQUE OPERACIÓN
      'pedidos_activos', aa.pedidos_activos,
      'pedidos_apartados', ap.pedidos_apartados,
      'pedidos_cerrados', acer.pedidos_cerrados,
      'pedidos_cancelados', anc.pedidos_cancelados,
      'pedidos_devueltos', ad.pedidos_devueltos,

      'tasa_cancelacion', case
        when (ae.pedidos_enviados + anc.pedidos_cancelados) > 0
          then round(100.0 * anc.pedidos_cancelados / (ae.pedidos_enviados + anc.pedidos_cancelados), 2)
        else 0
      end,
      'tasa_devolucion', case
        when ae.pedidos_enviados > 0
          then round(100.0 * ad.pedidos_devueltos / ae.pedidos_enviados, 2)
        else 0
      end,
      'tiempo_promedio_cierre', coalesce(acer.tiempo_promedio_cierre_hours, 0),

      -- BLOQUE PRODUCTO
      'top_productos', coalesce(tp.top_productos, '[]'::json),
      'top_variantes', coalesce(tv.top_variantes, '[]'::json),
      'top_talles', coalesce(tt.top_talles, '[]'::json),

      -- BLOQUE COMPORTAMIENTO
      'clientes_totales', ac.clientes_totales,
      'clientes_que_volvieron', ac.clientes_que_volvieron,
      'frecuencia_compra_promedio', case
        when ac.clientes_totales > 0
          then (ae.pedidos_enviados::numeric / ac.clientes_totales)
        else 0
      end
    )
  into v_result
  from agg_revenue ar
  cross join agg_enviado ae
  cross join agg_active aa
  cross join agg_apartado ap
  cross join agg_cerrado acer
  cross join agg_cancelado anc
  cross join agg_devolucion ad
  cross join agg_clients ac
  left join top_productos tp on true
  left join top_variantes tv on true
  left join top_talles tt on true;

  return v_result;
end;
$$;

select pg_notify('pgrst','reload schema');

grant execute on function public.metrics_dashboard(date, date) to authenticated;

