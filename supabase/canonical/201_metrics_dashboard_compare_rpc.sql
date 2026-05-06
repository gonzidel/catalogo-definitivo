-- 201_metrics_dashboard_compare_rpc.sql
-- Wrapper comparativo para métricas dashboard:
-- devuelve período actual + período previo usando la misma lógica canónica de
-- public.metrics_dashboard(date, date).

create or replace function public.metrics_dashboard_compare(
  p_from date,
  p_to date
)
returns json
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_duration_days int;
  v_previous_from date;
  v_previous_to date;
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

  -- Regla solicitada:
  -- duración = p_to - p_from
  -- previous_from = p_from - duración
  -- previous_to = p_from
  v_duration_days := greatest((p_to - p_from), 0);
  v_previous_from := p_from - v_duration_days;
  v_previous_to := p_from;

  return json_build_object(
    'current', public.metrics_dashboard(p_from, p_to),
    'previous', public.metrics_dashboard(v_previous_from, v_previous_to)
  );
end;
$$;

grant execute on function public.metrics_dashboard_compare(date, date) to authenticated;

select pg_notify('pgrst','reload schema');

