-- 206_metrics_weekly_purchase_plan_rpc.sql
-- Plan de compra semanal derivado de public.metrics_replenishment (sin duplicar su lógica).

create or replace function public.metrics_weekly_purchase_plan(
  p_from date,
  p_to date
)
returns json
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_raw jsonb;
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

  v_raw := to_jsonb(public.metrics_replenishment(p_from, p_to));

  with
  base as (select v_raw as j),
  ru as (
    select *
    from jsonb_to_recordset(coalesce((select base.j -> 'reposicion_urgente' from base), '[]'::jsonb))
      as t(
        product_id uuid,
        product_name text,
        units numeric,
        stock_total numeric,
        ventas_diarias numeric,
        cobertura numeric,
        cantidad_reponer numeric,
        reorder_point numeric,
        safety_stock numeric,
        factor_aplicado numeric,
        score_reposicion numeric,
        sell_through numeric,
        impacto_alto boolean,
        nivel text
      )
  ),
  rm as (
    select *
    from jsonb_to_recordset(coalesce((select base.j -> 'reposicion_media' from base), '[]'::jsonb))
      as t(
        product_id uuid,
        product_name text,
        units numeric,
        stock_total numeric,
        ventas_diarias numeric,
        cobertura numeric,
        cantidad_reponer numeric,
        reorder_point numeric,
        safety_stock numeric,
        factor_aplicado numeric,
        score_reposicion numeric,
        sell_through numeric,
        impacto_alto boolean,
        nivel text
      )
  ),
  sob as (
    select *
    from jsonb_to_recordset(coalesce((select base.j -> 'sobrestock' from base), '[]'::jsonb))
      as t(
        product_id uuid,
        product_name text,
        units numeric,
        stock_total numeric,
        ventas_diarias numeric,
        cobertura numeric,
        cantidad_reponer numeric,
        reorder_point numeric,
        safety_stock numeric,
        factor_aplicado numeric,
        score_reposicion numeric,
        sell_through numeric,
        impacto_alto boolean,
        nivel text
      )
  ),
  compra_urgente_agg as (
    select
      ru.product_id,
      max(ru.product_name) as product_name,
      sum(greatest(0, ceil(ru.cantidad_reponer)))::int as cantidad_comprar,
      min(ru.cobertura) as cobertura,
      max(ru.ventas_diarias) as ventas_diarias,
      max(ru.score_reposicion) as score_reposicion,
      max(ru.sell_through) as sell_through,
      max(ru.factor_aplicado) as factor_aplicado
    from ru
    where ru.cobertura is not null
      and ru.cobertura < 2
      and ru.ventas_diarias is not null
      and ru.ventas_diarias >= 1
      and coalesce(ru.impacto_alto, false) = true
      and ru.cantidad_reponer is not null
    group by ru.product_id
    having sum(greatest(0, ceil(ru.cantidad_reponer))) > 0
  ),
  compra_urgente as (
    select *
    from compra_urgente_agg
    order by score_reposicion desc nulls last
    limit 10
  ),
  rec_ru as (
    select
      ru.product_id,
      ru.product_name,
      greatest(0, round(ru.cantidad_reponer * 0.8))::int as cantidad_comprar,
      ru.cobertura,
      ru.ventas_diarias,
      ru.score_reposicion,
      ru.sell_through,
      ru.factor_aplicado
    from ru
    where ru.cobertura is not null
      and ru.cobertura >= 2
      and ru.cobertura <= 6
      and ru.ventas_diarias is not null
      and ru.ventas_diarias >= 1
      and ru.cantidad_reponer is not null
      and greatest(0, round(ru.cantidad_reponer * 0.8)) > 0
  ),
  rec_rm as (
    select
      rm.product_id,
      rm.product_name,
      greatest(0, round(rm.cantidad_reponer * 0.8))::int as cantidad_comprar,
      rm.cobertura,
      rm.ventas_diarias,
      rm.score_reposicion,
      rm.sell_through,
      rm.factor_aplicado
    from rm
    where rm.cobertura is not null
      and rm.cobertura >= 2
      and rm.cobertura <= 6
      and rm.ventas_diarias is not null
      and rm.ventas_diarias >= 1
      and rm.cantidad_reponer is not null
      and greatest(0, round(rm.cantidad_reponer * 0.8)) > 0
  ),
  rec_union as (
    select * from rec_ru
    union all
    select * from rec_rm
  ),
  compra_recomendada_src as (
    select
      u.product_id,
      max(u.product_name) as product_name,
      sum(u.cantidad_comprar)::int as cantidad_comprar,
      min(u.cobertura) as cobertura,
      max(u.ventas_diarias) as ventas_diarias,
      max(u.score_reposicion) as score_reposicion,
      max(u.sell_through) as sell_through,
      max(u.factor_aplicado) as factor_aplicado
    from rec_union u
    where not exists (
      select 1 from compra_urgente_agg cu where cu.product_id = u.product_id
    )
    group by u.product_id
  ),
  compra_recomendada as (
    select *
    from compra_recomendada_src
    order by cobertura asc nulls last
    limit 10
  ),
  no_comprar as (
    select
      s.product_id,
      s.product_name,
      s.cobertura,
      s.sell_through,
      'sobrestock'::text as motivo
    from sob s
    where s.cobertura is not null
      and s.cobertura > 20
      and s.sell_through is not null
      and s.sell_through < 0.08
    order by s.stock_total desc nulls last
    limit 10
  ),
  compra_lines as (
    select product_id, cantidad_comprar from compra_urgente
    union all
    select product_id, cantidad_comprar from compra_recomendada
  ),
  inv as (
    select
      coalesce(sum(cl.cantidad_comprar * coalesce(p.cost, 0)::numeric), 0) as total_inv,
      bool_or(p.cost is not null) as tiene_costo
    from compra_lines cl
    join public.products p on p.id = cl.product_id
  ),
  top5 as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'product_id', x.product_id,
          'product_name', x.product_name,
          'cantidad_comprar', x.cantidad_comprar,
          'score_reposicion', x.score_reposicion,
          'cobertura', x.cobertura
        )
        order by x.ord
      ),
      '[]'::jsonb
    ) as j
    from (
      select
        cu.product_id,
        cu.product_name,
        cu.cantidad_comprar,
        cu.score_reposicion,
        cu.cobertura,
        row_number() over (order by cu.score_reposicion desc nulls last) as ord
      from compra_urgente cu
    ) x
    where x.ord <= 5
  ),
  urg_json as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'product_id', cu.product_id,
          'product_name', cu.product_name,
          'cantidad_comprar', cu.cantidad_comprar,
          'cobertura', cu.cobertura,
          'ventas_diarias', cu.ventas_diarias,
          'score_reposicion', cu.score_reposicion,
          'sell_through', cu.sell_through,
          'factor_aplicado', cu.factor_aplicado,
          'prioridad', 'urgente'
        )
        order by cu.score_reposicion desc nulls last
      ),
      '[]'::jsonb
    ) as j
    from compra_urgente cu
  ),
  rec_json as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'product_id', cr.product_id,
          'product_name', cr.product_name,
          'cantidad_comprar', cr.cantidad_comprar,
          'cobertura', cr.cobertura,
          'ventas_diarias', cr.ventas_diarias,
          'score_reposicion', cr.score_reposicion,
          'sell_through', cr.sell_through,
          'factor_aplicado', cr.factor_aplicado,
          'prioridad', 'recomendada'
        )
        order by cr.cobertura asc nulls last
      ),
      '[]'::jsonb
    ) as j
    from compra_recomendada cr
  ),
  nc_json as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'product_id', nc.product_id,
          'product_name', nc.product_name,
          'cobertura', nc.cobertura,
          'sell_through', nc.sell_through,
          'motivo', nc.motivo
        )
      ),
      '[]'::jsonb
    ) as j
    from no_comprar nc
  ),
  resumen as (
    select jsonb_build_object(
      'total_unidades_a_comprar',
        coalesce((select sum(cantidad_comprar) from compra_urgente), 0) +
        coalesce((select sum(cantidad_comprar) from compra_recomendada), 0),
      'cantidad_productos',
        (
          select count(*)::int from (
            select product_id from compra_urgente
            union
            select product_id from compra_recomendada
          ) d
        ),
      'top_5_productos_criticos', coalesce((select j from top5), '[]'::jsonb),
      'estimacion_inversion',
        case
          when (select tiene_costo from inv) then (select round(total_inv, 2) from inv)
          else null
        end,
      'estimacion_inversion_disponible', coalesce((select tiene_costo from inv), false)
    ) as j
  )
  select json_build_object(
    'compra_urgente', coalesce((select j from urg_json), '[]'::jsonb),
    'compra_recomendada', coalesce((select j from rec_json), '[]'::jsonb),
    'no_comprar', coalesce((select j from nc_json), '[]'::jsonb),
    'resumen', coalesce((select j from resumen), '{}'::jsonb)
  )
  into v_result;

  return v_result;
end;
$$;

grant execute on function public.metrics_weekly_purchase_plan(date, date) to authenticated;

select pg_notify('pgrst', 'reload schema');
