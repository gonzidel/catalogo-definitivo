-- 207_metrics_purchase_by_supplier_rpc.sql
-- Órdenes de compra sugeridas agrupadas por proveedor (catálogo public.suppliers).
-- Base: public.metrics_weekly_purchase_plan (sin recalcular reposición).

do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'products'
      and column_name = 'pack_size'
  ) then
    alter table public.products add column pack_size integer;
    comment on column public.products.pack_size is
      'Unidades por pack / MOQ sugerido para redondear pedidos a proveedor.';
  end if;
end $$;

create or replace function public.metrics_purchase_by_supplier(
  p_from date,
  p_to date
)
returns json
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_plan jsonb;
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

  v_plan := to_jsonb(public.metrics_weekly_purchase_plan(p_from, p_to));

  with
  lines as (
    select
      t.product_id,
      t.product_name,
      t.cantidad_comprar,
      true as es_urgente,
      'urgente'::text as origen
    from jsonb_to_recordset(coalesce(v_plan -> 'compra_urgente', '[]'::jsonb))
      as t(
        product_id uuid,
        product_name text,
        cantidad_comprar numeric,
        cobertura numeric,
        ventas_diarias numeric,
        score_reposicion numeric,
        sell_through numeric,
        factor_aplicado numeric,
        prioridad text
      )
    where t.product_id is not null
      and coalesce(t.cantidad_comprar, 0) > 0

    union all

    select
      t.product_id,
      t.product_name,
      t.cantidad_comprar,
      false as es_urgente,
      'recomendada'::text as origen
    from jsonb_to_recordset(coalesce(v_plan -> 'compra_recomendada', '[]'::jsonb))
      as t(
        product_id uuid,
        product_name text,
        cantidad_comprar numeric,
        cobertura numeric,
        ventas_diarias numeric,
        score_reposicion numeric,
        sell_through numeric,
        factor_aplicado numeric,
        prioridad text
      )
    where t.product_id is not null
      and coalesce(t.cantidad_comprar, 0) > 0
  ),
  enr as (
    select
      l.product_id,
      l.product_name,
      l.cantidad_comprar,
      l.es_urgente,
      l.origen,
      p.supplier_id,
      case
        when p.supplier_id is null then 'Sin proveedor asignado'::text
        else coalesce(s.name, 'Proveedor'::text)
      end as supplier_name,
      greatest(coalesce(nullif(p.pack_size, 0), 6), 1)::int as pack_size,
      coalesce(p.cost, 0)::numeric as cost_unit
    from lines l
    join public.products p on p.id = l.product_id
    left join public.suppliers s on s.id = p.supplier_id
  ),
  calc as (
    select
      e.*,
      (
        ceil(coalesce(e.cantidad_comprar, 0)::numeric / e.pack_size)::bigint * e.pack_size
      )::int as cantidad_final
    from enr e
  ),
  by_supplier as (
    select
      c.supplier_id,
      max(c.supplier_name) as supplier_name,
      bool_or(c.es_urgente) as tiene_urgente,
      sum(c.cantidad_final)::bigint as total_unidades,
      sum(c.cantidad_final::numeric * c.cost_unit) as total_costo,
      jsonb_agg(
        jsonb_build_object(
          'product_id', c.product_id,
          'product_name', c.product_name,
          'cantidad_comprar', c.cantidad_comprar,
          'pack_size', c.pack_size,
          'cantidad_final', c.cantidad_final,
          'origen', c.origen,
          'costo_linea_estimado', round(c.cantidad_final::numeric * c.cost_unit, 2)
        )
        order by c.es_urgente desc, c.cantidad_final desc, c.product_name asc
      ) as productos
    from calc c
    group by c.supplier_id
  ),
  ranked as (
    select
      bs.supplier_id,
      bs.supplier_name,
      bs.productos,
      bs.total_unidades,
      round(bs.total_costo, 2) as total_costo_estimado,
      case
        when bs.tiene_urgente then 'alta'::text
        else 'normal'::text
      end as prioridad,
      case when bs.tiene_urgente then 0 else 1 end as sort_critico,
      row_number() over (
        order by
          case when bs.tiene_urgente then 0 else 1 end,
          bs.total_unidades desc,
          bs.supplier_name asc
      ) as rn
    from by_supplier bs
  )
  select json_build_object(
    'proveedores',
    coalesce(
      (
        select json_agg(
          json_build_object(
            'supplier_id', r.supplier_id,
            'supplier_name', r.supplier_name,
            'productos', r.productos,
            'total_unidades', r.total_unidades,
            'total_costo_estimado', r.total_costo_estimado,
            'prioridad', r.prioridad
          )
          order by r.sort_critico, r.total_unidades desc, r.supplier_name asc
        )
        from ranked r
        where r.rn <= 5
      ),
      '[]'::json
    )
  )
  into v_result;

  return v_result;
end;
$$;

grant execute on function public.metrics_purchase_by_supplier(date, date) to authenticated;

select pg_notify('pgrst', 'reload schema');
