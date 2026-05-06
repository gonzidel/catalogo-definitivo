-- 203_metrics_replenishment_rpc.sql
-- Predicción de reposición automática para dashboard de métricas FYL.

create or replace function public.metrics_replenishment(
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
  v_days numeric;
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
  v_days := greatest((p_to - p_from)::numeric, 1);

  with
  current_sales_product as (
    select
      p.id as product_id,
      p.name as product_name,
      sum(oi.quantity)::numeric as units
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
  learning_factor as (
    select
      t.product_id,
      greatest(0.7, least(1.5, t.factor_ajuste)) as factor_aplicado
    from (
      select distinct on (rl.product_id)
        rl.product_id,
        rl.factor_ajuste,
        rl.created_at
      from public.replenishment_learning rl
      where rl.activo = true
      order by rl.product_id, rl.created_at desc
    ) t
  ),
  product_stock as (
    select
      p.id as product_id,
      coalesce(vss.stock_total, 0) + coalesce(vws.stock_total, 0) as stock_total
    from public.products p
    left join (
      select
        pv.product_id,
        sum(coalesce(vsws.stock_qty, 0))::numeric as stock_total
      from public.product_variants pv
      left join public.variant_size_warehouse_stock vsws on vsws.variant_id = pv.id
      group by pv.product_id
    ) vss on vss.product_id = p.id
    left join (
      select
        pv.product_id,
        sum(coalesce(vws.stock_qty, 0))::numeric as stock_total
      from public.product_variants pv
      left join public.variant_warehouse_stock vws on vws.variant_id = pv.id
      group by pv.product_id
    ) vws on vws.product_id = p.id
  ),
  base as (
    select
      csp.product_id,
      csp.product_name,
      csp.units,
      coalesce(ps.stock_total, 0)::numeric as stock_total,
      coalesce(lf.factor_aplicado, 1)::numeric as factor_aplicado,
      (csp.units / v_days) as ventas_diarias,
      case
        when (csp.units / v_days) > 0 then round(coalesce(ps.stock_total, 0)::numeric / (csp.units / v_days), 2)
        else null
      end as cobertura,
      case
        when (csp.units / v_days) >= 5 then 3::numeric
        when (csp.units / v_days) >= 2 then 5::numeric
        else 7::numeric
      end as lead_time_dias,
      round((csp.units / v_days) * sqrt(
        case
          when (csp.units / v_days) >= 5 then 3::numeric
          when (csp.units / v_days) >= 2 then 5::numeric
          else 7::numeric
        end
      ), 2) as safety_stock,
      round(
        (
          (
            ((csp.units / v_days) * (
              case
                when (csp.units / v_days) >= 5 then 3::numeric
                when (csp.units / v_days) >= 2 then 5::numeric
                else 7::numeric
              end
            )) +
            ((csp.units / v_days) * sqrt(
              case
                when (csp.units / v_days) >= 5 then 3::numeric
                when (csp.units / v_days) >= 2 then 5::numeric
                else 7::numeric
              end
            ))
          ) * coalesce(lf.factor_aplicado, 1)
        ),
        2
      ) as reorder_point,
      round(((csp.units / v_days) * csp.units) / greatest(
        case
          when (csp.units / v_days) > 0 then (coalesce(ps.stock_total, 0)::numeric / (csp.units / v_days))
          else 1
        end, 1
      ), 4) as score_reposicion,
      case
        when (csp.units / v_days) >= 3 and
             (
               case
                 when (csp.units / v_days) > 0 then (coalesce(ps.stock_total, 0)::numeric / (csp.units / v_days))
                 else null
               end
             ) < 2
          then true
        else false
      end as impacto_alto,
      round(csp.units / nullif(csp.units + coalesce(ps.stock_total, 0)::numeric, 0), 4) as sell_through
    from current_sales_product csp
    join product_stock ps on ps.product_id = csp.product_id
    left join learning_factor lf on lf.product_id = csp.product_id
    where csp.units >= 3 -- quitar ruido
      and csp.units > 0  -- ignorar sin ventas
  ),
  valid as (
    select *
    from base
    where ventas_diarias is not null
      and ventas_diarias > 0
      and ventas_diarias >= 0.5
      and cobertura is not null
      and cobertura = cobertura
      and cobertura <= 60
      and reorder_point is not null
      and reorder_point = reorder_point
      and sell_through is not null
      and sell_through = sell_through
  ),
  reposicion_urgente as (
    select
      v.product_id,
      v.product_name,
      v.units,
      v.stock_total,
      round(v.ventas_diarias, 2) as ventas_diarias,
      v.cobertura,
      least(
        greatest(ceil(v.reorder_point - v.stock_total), 0),
        ceil(v.ventas_diarias * 15)
      )::numeric as cantidad_reponer,
      v.reorder_point,
      v.safety_stock,
      v.factor_aplicado,
      v.score_reposicion,
      v.sell_through,
      v.impacto_alto,
      'urgente'::text as nivel
    from valid v
    where v.cobertura < 2.5
      and v.ventas_diarias >= 1
      and v.stock_total < v.reorder_point
      and least(
        greatest(ceil(v.reorder_point - v.stock_total), 0),
        ceil(v.ventas_diarias * 15)
      ) > (v.ventas_diarias * 2)
    order by v.impacto_alto desc, v.score_reposicion desc
    limit 20
  ),
  reposicion_media as (
    select
      v.product_id,
      v.product_name,
      v.units,
      v.stock_total,
      round(v.ventas_diarias, 2) as ventas_diarias,
      v.cobertura,
      least(
        greatest(ceil(v.reorder_point - v.stock_total), 0),
        ceil(v.ventas_diarias * 15)
      )::numeric as cantidad_reponer,
      v.reorder_point,
      v.safety_stock,
      v.factor_aplicado,
      v.score_reposicion,
      v.sell_through,
      v.impacto_alto,
      'medio'::text as nivel
    from valid v
    where v.stock_total < (v.reorder_point * 1.5)
      and v.cobertura >= 2.5
      and v.cobertura <= 6
      and least(
        greatest(ceil(v.reorder_point - v.stock_total), 0),
        ceil(v.ventas_diarias * 15)
      ) > (v.ventas_diarias * 2)
    order by v.cobertura asc
    limit 20
  ),
  sobrestock as (
    select
      v.product_id,
      v.product_name,
      v.units,
      v.stock_total,
      round(v.ventas_diarias, 2) as ventas_diarias,
      v.cobertura,
      greatest(v.stock_total - ceil(v.ventas_diarias * 20), 0)::numeric as cantidad_reponer,
      v.reorder_point,
      v.safety_stock,
      v.factor_aplicado,
      v.score_reposicion,
      v.sell_through,
      v.impacto_alto,
      'sobrestock'::text as nivel
    from valid v
    where v.cobertura > 25
      and v.sell_through < 0.08
      and v.stock_total > (v.reorder_point * 1.8)
      and greatest(v.stock_total - ceil(v.ventas_diarias * 20), 0) > 0
    order by v.stock_total desc
    limit 20
  )
  select json_build_object(
    'reposicion_urgente', coalesce((select json_agg(x) from reposicion_urgente x), '[]'::json),
    'reposicion_media', coalesce((select json_agg(x) from reposicion_media x), '[]'::json),
    'sobrestock', coalesce((select json_agg(x) from sobrestock x), '[]'::json)
  )
  into v_result;

  return v_result;
end;
$$;

grant execute on function public.metrics_replenishment(date, date) to authenticated;

select pg_notify('pgrst','reload schema');

