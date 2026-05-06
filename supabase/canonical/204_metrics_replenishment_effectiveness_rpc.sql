-- 204_metrics_replenishment_effectiveness_rpc.sql
-- Evalúa si la reposición recomendada fue efectiva comparando período previo vs actual.

create or replace function public.metrics_replenishment_effectiveness(
  p_from date,
  p_to date
)
returns json
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_days int;
  v_prev_from date;
  v_prev_to date;
  v_prev_replenishment json;
  v_result json;
  v_item record;
  v_factor_actual numeric;
  v_factor_nuevo numeric;
  v_factor_final numeric;
  v_tipo_ajuste text;
  v_tipo_candidato text;
  v_last_tipo text;
  v_consecutive_ok boolean;
  v_significant_ok boolean;
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

  v_days := greatest((p_to - p_from), 0);
  v_prev_from := p_from - v_days;
  v_prev_to := p_from;

  -- Productos relevantes: los recomendados a reponer en el período anterior.
  v_prev_replenishment := public.metrics_replenishment(v_prev_from, v_prev_to);

  with
  cur_repl as (
    select public.metrics_replenishment(p_from, p_to)::jsonb as j
  ),
  relevant_products as (
    select distinct (x->>'product_id')::uuid as product_id
    from (
      select jsonb_array_elements(coalesce(v_prev_replenishment::jsonb -> 'reposicion_urgente', '[]'::jsonb)) as x
      union all
      select jsonb_array_elements(coalesce(v_prev_replenishment::jsonb -> 'reposicion_media', '[]'::jsonb)) as x
    ) t
    where (x->>'product_id') is not null
  ),
  current_rep as (
    select
      (x->>'product_id')::uuid as product_id,
      x->>'product_name' as product_name,
      coalesce((x->>'ventas_diarias')::numeric, 0) as ventas_after,
      coalesce((x->>'cobertura')::numeric, 0) as cobertura_after,
      coalesce((x->>'stock_total')::numeric, 0) as stock_after
    from cur_repl cr,
    lateral jsonb_array_elements(
      coalesce(cr.j -> 'reposicion_urgente', '[]'::jsonb) ||
      coalesce(cr.j -> 'reposicion_media', '[]'::jsonb) ||
      coalesce(cr.j -> 'sobrestock', '[]'::jsonb)
    ) as x
  ),
  prev_rep as (
    select
      (x->>'product_id')::uuid as product_id,
      x->>'product_name' as product_name,
      coalesce((x->>'ventas_diarias')::numeric, 0) as ventas_before,
      coalesce((x->>'cobertura')::numeric, 0) as cobertura_before,
      coalesce((x->>'stock_total')::numeric, 0) as stock_before
    from jsonb_array_elements(
      coalesce(v_prev_replenishment::jsonb -> 'reposicion_urgente', '[]'::jsonb) ||
      coalesce(v_prev_replenishment::jsonb -> 'reposicion_media', '[]'::jsonb) ||
      coalesce(v_prev_replenishment::jsonb -> 'sobrestock', '[]'::jsonb)
    ) as x
  ),
  base as (
    select
      rp.product_id,
      coalesce(cr.product_name, pr.product_name, 'Producto') as product_name,
      coalesce(pr.cobertura_before, 0) as cobertura_before,
      coalesce(cr.cobertura_after, 0) as cobertura_after,
      coalesce(pr.ventas_before, 0) as ventas_before,
      coalesce(cr.ventas_after, 0) as ventas_after,
      coalesce(pr.stock_before, 0) as stock_before,
      coalesce(cr.stock_after, 0) as stock_after,
      round(coalesce(cr.cobertura_after, 0) - coalesce(pr.cobertura_before, 0), 2) as cambio_cobertura,
      round(coalesce(cr.ventas_after, 0) - coalesce(pr.ventas_before, 0), 2) as cambio_ventas,
      case
        when coalesce(cr.stock_after, 0) <= 0 then v_days + 1
        else 0
      end as dias_sin_stock,
      round(
        (
          case when (coalesce(cr.ventas_after, 0) + coalesce(cr.stock_after, 0)) > 0
            then coalesce(cr.ventas_after, 0) / (coalesce(cr.ventas_after, 0) + coalesce(cr.stock_after, 0))
            else 0 end
        ) - (
          case when (coalesce(pr.ventas_before, 0) + coalesce(pr.stock_before, 0)) > 0
            then coalesce(pr.ventas_before, 0) / (coalesce(pr.ventas_before, 0) + coalesce(pr.stock_before, 0))
            else 0 end
        )
      , 4) as variacion_rotacion
    from relevant_products rp
    left join prev_rep pr on pr.product_id = rp.product_id
    left join current_rep cr on cr.product_id = rp.product_id
  ),
  classified as (
    select
      b.*,
      case
        when b.cobertura_after < 1 and b.ventas_after >= 1 then 'quiebre'
        when b.cambio_cobertura > 0 and b.ventas_after >= b.ventas_before then 'efectiva'
        when b.cambio_cobertura > 3 and b.ventas_after < b.ventas_before then 'ineficiente'
        else 'neutra'
      end as resultado
    from base b
  ),
  ajustes_modelo as (
    select
      c.product_id,
      c.product_name,
      case
        when c.resultado = 'quiebre' then 'aumentar buffer de seguridad'
        when c.resultado = 'ineficiente' then 'reducir sobrestock'
        when c.resultado = 'efectiva' then 'mantener parámetros'
        else 'sin ajuste'
      end as ajuste_sugerido,
      case
        when c.resultado = 'quiebre' then 1.20::numeric
        when c.resultado = 'ineficiente' then 0.85::numeric
        when c.resultado = 'efectiva' then 1.00::numeric
        else 1.00::numeric
      end as factor_ajuste,
      case
        when c.resultado = 'quiebre' then 'cobertura baja con demanda sostenida; aumentar safety stock y reorder point'
        when c.resultado = 'ineficiente' then 'cobertura subió pero la demanda no acompañó; reducir safety stock/reorder point'
        when c.resultado = 'efectiva' then 'cobertura y demanda alineadas; mantener parámetros actuales'
        else 'sin evidencia suficiente para modificar parámetros'
      end as motivo
    from classified c
    where c.resultado in ('quiebre', 'ineficiente', 'efectiva')
  )
  select json_build_object(
    'productos_repuestos',
      coalesce((
        select json_agg(x)
        from (
          select
            product_id, product_name,
            cobertura_before, cobertura_after,
            ventas_before, ventas_after,
            stock_before, stock_after,
            cambio_cobertura, cambio_ventas,
            dias_sin_stock, variacion_rotacion,
            resultado
          from classified
          order by ventas_after desc, cobertura_after asc
        ) x
      ), '[]'::json),
    'reposicion_efectiva',
      coalesce((
        select json_agg(x)
        from (
          select
            product_id, product_name,
            cobertura_before, cobertura_after,
            ventas_before, ventas_after,
            stock_before, stock_after,
            cambio_cobertura, cambio_ventas,
            dias_sin_stock, variacion_rotacion,
            resultado
          from classified
          where resultado = 'efectiva'
          order by cambio_cobertura desc, ventas_after desc
          limit 20
        ) x
      ), '[]'::json),
    'reposicion_ineficiente',
      coalesce((
        select json_agg(x)
        from (
          select
            product_id, product_name,
            cobertura_before, cobertura_after,
            ventas_before, ventas_after,
            stock_before, stock_after,
            cambio_cobertura, cambio_ventas,
            dias_sin_stock, variacion_rotacion,
            resultado
          from classified
          where resultado = 'ineficiente'
          order by cambio_cobertura desc, ventas_after asc
          limit 20
        ) x
      ), '[]'::json),
    'quiebres_no_evitatados',
      coalesce((
        select json_agg(x)
        from (
          select
            product_id, product_name,
            cobertura_before, cobertura_after,
            ventas_before, ventas_after,
            stock_before, stock_after,
            cambio_cobertura, cambio_ventas,
            dias_sin_stock, variacion_rotacion,
            resultado
          from classified
          where resultado = 'quiebre'
          order by ventas_after desc
          limit 20
        ) x
      ), '[]'::json),
    'ajustes_modelo',
      coalesce((
        select json_agg(x)
        from (
          select
            product_id,
            product_name,
            ajuste_sugerido,
            factor_ajuste,
            motivo
          from ajustes_modelo
          order by
            case ajuste_sugerido
              when 'aumentar buffer de seguridad' then 1
              when 'reducir sobrestock' then 2
              when 'mantener parámetros' then 3
              else 4
            end,
            product_name asc
          limit 30
        ) x
      ), '[]'::json)
  )
  into v_result;

  -- Persistir aprendizaje por producto (suavizado + límites de seguridad).
  for v_item in
    select
      (x->>'product_id')::uuid as product_id,
      coalesce(nullif(x->>'product_name', ''), 'Producto') as product_name,
      coalesce((x->>'factor_ajuste')::numeric, 1) as factor_ajuste,
      coalesce(x->>'motivo', '') as motivo
    from json_array_elements(coalesce(v_result->'ajustes_modelo', '[]'::json)) x
    where (x->>'product_id') is not null
  loop
    v_factor_nuevo := greatest(0.7, least(1.5, coalesce(v_item.factor_ajuste, 1)));

    select rl.factor_ajuste
    into v_factor_actual
    from public.replenishment_learning rl
    where rl.product_id = v_item.product_id
      and rl.activo = true
    order by rl.created_at desc
    limit 1;

    v_factor_final := greatest(
      0.7,
      least(
        1.5,
        (coalesce(v_factor_actual, 1) * 0.7) + (v_factor_nuevo * 0.3)
      )
    );

    v_tipo_candidato := case
      when v_factor_nuevo > 1 then 'aumento'
      when v_factor_nuevo < 1 then 'reduccion'
      else 'neutro'
    end;

    select rl.tipo_ajuste
    into v_last_tipo
    from public.replenishment_learning rl
    where rl.product_id = v_item.product_id
    order by rl.created_at desc
    limit 1;

    -- Aplicar ajuste SOLO si:
    -- 1) Hay al menos 2 eventos consecutivos del mismo tipo (último histórico + candidato actual), o
    -- 2) El cambio es significativo (>20%).
    v_consecutive_ok := (coalesce(v_last_tipo, '') = v_tipo_candidato);
    v_significant_ok := (
      abs(v_factor_nuevo - coalesce(v_factor_actual, 1))
      / greatest(abs(coalesce(v_factor_actual, 1)), 0.0001)
    ) > 0.20;

    if v_consecutive_ok or v_significant_ok then
      v_tipo_ajuste := case
        when v_factor_final > 1 then 'aumento'
        when v_factor_final < 1 then 'reduccion'
        else 'neutro'
      end;

      update public.replenishment_learning
      set activo = false
      where product_id = v_item.product_id
        and activo = true;

      insert into public.replenishment_learning (
        product_id,
        factor_ajuste,
        tipo_ajuste,
        motivo,
        created_at,
        activo
      ) values (
        v_item.product_id,
        v_factor_final,
        v_tipo_ajuste,
        v_item.motivo,
        now(),
        true
      );
    end if;
  end loop;

  return v_result;
end;
$$;

grant execute on function public.metrics_replenishment_effectiveness(date, date) to authenticated;

select pg_notify('pgrst','reload schema');

