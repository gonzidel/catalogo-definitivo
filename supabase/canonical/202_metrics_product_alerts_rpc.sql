-- 202_metrics_product_alerts_rpc.sql
-- Alertas avanzadas de producto para dashboard v2.

create or replace function public.metrics_product_alerts(
  p_from date,
  p_to date
)
returns json
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_from_utc timestamptz;
  v_to_utc_excl timestamptz;
  v_duration_days int;
  v_days_for_rate numeric;
  v_prev_from_utc timestamptz;
  v_prev_to_utc_excl timestamptz;
  v_new_traction_revenue_threshold numeric := 150000;
  v_result json;
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

  v_from_utc := (p_from::timestamp) AT TIME ZONE 'America/Argentina/Cordoba';
  v_to_utc_excl := ((p_to + 1)::timestamp) AT TIME ZONE 'America/Argentina/Cordoba';

  v_duration_days := greatest((p_to - p_from), 0);
  v_days_for_rate := greatest(v_duration_days::numeric, 1);
  v_prev_from_utc := ((p_from - v_duration_days)::timestamp) AT TIME ZONE 'America/Argentina/Cordoba';
  v_prev_to_utc_excl := (p_from::timestamp) AT TIME ZONE 'America/Argentina/Cordoba';

  with
  current_sales_product as (
    select
      p.id as product_id,
      p.name as product_name,
      sum(oi.quantity)::int as units,
      sum(oi.quantity * coalesce(oi.price_snapshot, 0))::numeric as revenue
    from public.orders o
    join public.order_items oi on oi.order_id = o.id
    join public.product_variants pv on pv.id = oi.variant_id
    join public.products p on p.id = pv.product_id
    where o.status = 'sent'
      and o.sent_at is not null
      and o.sent_at >= v_from_utc
      and o.sent_at <  v_to_utc_excl
      and oi.status <> 'cancelled'
    group by p.id, p.name
  ),
  previous_sales_product as (
    select
      p.id as product_id,
      sum(oi.quantity * coalesce(oi.price_snapshot, 0))::numeric as revenue_prev
    from public.orders o
    join public.order_items oi on oi.order_id = o.id
    join public.product_variants pv on pv.id = oi.variant_id
    join public.products p on p.id = pv.product_id
    where o.status = 'sent'
      and o.sent_at is not null
      and o.sent_at >= v_prev_from_utc
      and o.sent_at <  v_prev_to_utc_excl
      and oi.status <> 'cancelled'
    group by p.id
  ),
  product_stock as (
    select
      p.id as product_id,
      coalesce(vss.stock_total, 0) + coalesce(vws.stock_total, 0) as stock_total
    from public.products p
    left join (
      select
        pv.product_id,
        sum(coalesce(vsws.stock_qty, 0))::int as stock_total
      from public.product_variants pv
      left join public.variant_size_warehouse_stock vsws on vsws.variant_id = pv.id
      group by pv.product_id
    ) vss on vss.product_id = p.id
    left join (
      select
        pv.product_id,
        sum(coalesce(vws.stock_qty, 0))::int as stock_total
      from public.product_variants pv
      left join public.variant_warehouse_stock vws on vws.variant_id = pv.id
      group by pv.product_id
    ) vws on vws.product_id = p.id
  ),
  total_revenue as (
    select coalesce(sum(revenue), 0)::numeric as total_revenue
    from current_sales_product
  ),
  product_metrics as (
    select
      csp.product_id,
      csp.product_name,
      coalesce(ps.stock_total, 0)::numeric as stock_total,
      coalesce(csp.units, 0)::numeric as units,
      coalesce(csp.revenue, 0)::numeric as revenue,
      coalesce(psp.revenue_prev, 0)::numeric as revenue_prev,
      case
        when coalesce(csp.units, 0) > 0 then round((coalesce(ps.stock_total, 0)::numeric * v_days_for_rate) / csp.units, 2)
        else null
      end as cobertura,
      case
        when coalesce(ps.stock_total, 0) > 0 then round(coalesce(csp.units, 0)::numeric / ps.stock_total, 4)
        else 0
      end as rotacion,
      case
        when coalesce(psp.revenue_prev, 0) > 0
          then round(((coalesce(csp.revenue, 0) - psp.revenue_prev) / psp.revenue_prev) * 100, 2)
        else null
      end as growth_percent,
      case
        when tr.total_revenue > 0 then round((coalesce(csp.revenue, 0) / tr.total_revenue) * 100, 2)
        else 0
      end as revenue_share_percent
    from current_sales_product csp
    join product_stock ps on ps.product_id = csp.product_id
    left join previous_sales_product psp on psp.product_id = csp.product_id
    cross join total_revenue tr
  ),
  current_sales_variant_size as (
    select
      oi.variant_id,
      trim(coalesce(oi.size, '')) as size,
      sum(oi.quantity)::int as units
    from public.orders o
    join public.order_items oi on oi.order_id = o.id
    where o.status = 'sent'
      and o.sent_at is not null
      and o.sent_at >= v_from_utc
      and o.sent_at <  v_to_utc_excl
      and oi.status <> 'cancelled'
      and oi.variant_id is not null
      and trim(coalesce(oi.size, '')) <> ''
    group by oi.variant_id, trim(coalesce(oi.size, ''))
  ),
  variant_size_metrics as (
    select
      csvg.variant_id,
      pv.sku,
      p.name as product_name,
      csvg.size,
      coalesce(sum(vsws.stock_qty), 0)::numeric as stock_total,
      csvg.units::numeric as units,
      case
        when csvg.units > 0 then round((coalesce(sum(vsws.stock_qty), 0)::numeric * v_days_for_rate) / csvg.units, 2)
        else null
      end as cobertura,
      case
        when coalesce(sum(vsws.stock_qty), 0) > 0 then round(csvg.units::numeric / coalesce(sum(vsws.stock_qty), 0), 4)
        else 0
      end as rotacion,
      null::numeric as growth_percent
    from current_sales_variant_size csvg
    join public.product_variants pv on pv.id = csvg.variant_id
    join public.products p on p.id = pv.product_id
    left join public.variant_size_warehouse_stock vsws
      on vsws.variant_id = csvg.variant_id
     and trim(coalesce(vsws.size, '')) = csvg.size
    group by csvg.variant_id, pv.sku, p.name, csvg.size, csvg.units
  ),
  stock_critico as (
    select
      pm.product_id,
      pm.product_name,
      pm.stock_total,
      pm.units,
      pm.cobertura,
      pm.rotacion,
      pm.growth_percent
    from product_metrics pm
    where pm.units > 0
      and pm.cobertura is not null
      and pm.cobertura < 3
    order by pm.cobertura asc, pm.revenue desc
    limit 10
  ),
  talles_criticos as (
    select
      vsm.variant_id,
      vsm.sku,
      vsm.product_name,
      vsm.size,
      vsm.stock_total,
      vsm.units,
      vsm.cobertura,
      vsm.rotacion,
      vsm.growth_percent
    from variant_size_metrics vsm
    where vsm.units > 0
      and vsm.cobertura is not null
      and vsm.cobertura < 3
    order by vsm.cobertura asc, vsm.units desc
    limit 10
  ),
  productos_dominantes as (
    select
      pm.product_id,
      pm.product_name,
      pm.stock_total,
      pm.units,
      pm.cobertura,
      pm.rotacion,
      pm.growth_percent
    from product_metrics pm
    where pm.revenue_share_percent > 30
    order by pm.revenue_share_percent desc, pm.revenue desc
    limit 10
  ),
  productos_lentos as (
    select
      pm.product_id,
      pm.product_name,
      pm.stock_total,
      pm.units,
      pm.cobertura,
      pm.rotacion,
      pm.growth_percent
    from product_metrics pm
    where pm.stock_total > 0
      and pm.rotacion < 0.1
    order by pm.rotacion asc, pm.stock_total desc
    limit 10
  ),
  productos_tendencia as (
    select
      pm.product_id,
      pm.product_name,
      pm.stock_total,
      pm.units,
      pm.cobertura,
      pm.rotacion,
      case
        when pm.revenue_prev = 0 and pm.revenue > v_new_traction_revenue_threshold then 999.99
        else pm.growth_percent
      end as growth_percent
    from product_metrics pm
    where
      (pm.revenue_prev > 50000 and pm.growth_percent > 30)
      or
      (pm.revenue_prev = 0 and pm.revenue > v_new_traction_revenue_threshold)
    order by growth_percent desc, pm.revenue desc
    limit 10
  )
  select json_build_object(
    'stock_critico', coalesce((select json_agg(x) from stock_critico x), '[]'::json),
    'talles_criticos', coalesce((select json_agg(x) from talles_criticos x), '[]'::json),
    'productos_dominantes', coalesce((select json_agg(x) from productos_dominantes x), '[]'::json),
    'productos_lentos', coalesce((select json_agg(x) from productos_lentos x), '[]'::json),
    'productos_tendencia', coalesce((select json_agg(x) from productos_tendencia x), '[]'::json)
  )
  into v_result;

  return v_result;
end;
$$;

grant execute on function public.metrics_product_alerts(date, date) to authenticated;

select pg_notify('pgrst','reload schema');

