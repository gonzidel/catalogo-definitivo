-- 172_rpc_mark_order_as_devolucion_strong_idempotency.sql
--
-- Sprint 3: idempotencia fuerte + replay-safe para rpc_mark_order_as_devolucion.
-- Se publica firma nueva en paralelo, SIN eliminar la firma vieja.
--
-- Firma nueva:
--   rpc_mark_order_as_devolucion(
--     p_order_id uuid,
--     p_operation_id uuid,
--     p_request jsonb default '{}'
--   ) returns jsonb
--
-- Estrategia:
--   - Capa de idempotencia con rpc_operations_begin/complete/fail.
--   - Lógica de dominio intacta: delega en firma legacy rpc_mark_order_as_devolucion(uuid).
--   - Replay completed devuelve el result_json previo exacto.

create or replace function public.rpc_mark_order_as_devolucion(
  p_order_id uuid,
  p_operation_id uuid,
  p_request jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_operation_request jsonb;
  v_prev_result jsonb;
  v_result jsonb;

  v_err_msg text;
  v_err_state text;
  v_err_detail text;
  v_err_hint text;
begin
  if p_order_id is null then
    raise exception 'rpc_mark_order_as_devolucion: p_order_id es obligatorio'
      using errcode = '22023';
  end if;

  if p_operation_id is null then
    raise exception 'rpc_mark_order_as_devolucion: p_operation_id es obligatorio'
      using errcode = '22023';
  end if;

  -- Fingerprint canónico: incluir siempre order_id, además de metadata opcional.
  v_operation_request := coalesce(p_request, '{}'::jsonb)
    || jsonb_build_object('order_id', p_order_id);

  v_prev_result := public.rpc_operations_begin(
    p_operation_id => p_operation_id,
    p_operation_kind => 'mark_order_as_devolucion',
    p_request => v_operation_request,
    p_target_type => 'order',
    p_target_id => p_order_id::text
  );

  -- Replay de completed: devolver resultado previo exacto.
  if v_prev_result is not null then
    return coalesce(v_prev_result, '{}'::jsonb) || jsonb_build_object('idempotent_replay', true);
  end if;

  begin
    -- Dominio intacto: ejecutar lógica existente (locks, validaciones, stock, estado).
    perform public.rpc_mark_order_as_devolucion(p_order_id);

    v_result := jsonb_build_object(
      'ok', true,
      'order_id', p_order_id,
      'status', 'devolución'
    );

    v_result := coalesce(v_result, '{}'::jsonb) || jsonb_build_object('idempotent_replay', false);
    return public.rpc_operations_complete(p_operation_id, v_result);
  exception
    when others then
      get stacked diagnostics
        v_err_msg = message_text,
        v_err_state = returned_sqlstate,
        v_err_detail = pg_exception_detail,
        v_err_hint = pg_exception_hint;

      begin
        perform public.rpc_operations_fail(
          p_operation_id,
          jsonb_build_object(
            'message', v_err_msg,
            'sqlstate', v_err_state,
            'detail', v_err_detail,
            'hint', v_err_hint
          )
        );
      exception
        when others then
          -- No ocultar nunca el error original de dominio.
          null;
      end;

      raise;
  end;
end;
$$;

comment on function public.rpc_mark_order_as_devolucion(uuid, uuid, jsonb) is
  'Sprint3: wrapper idempotente fuerte para devolución; delega la lógica de dominio a rpc_mark_order_as_devolucion(uuid).';

revoke all on function public.rpc_mark_order_as_devolucion(uuid, uuid, jsonb)
  from public, anon;
grant execute on function public.rpc_mark_order_as_devolucion(uuid, uuid, jsonb)
  to authenticated, service_role;

select pg_notify('pgrst', 'reload schema');
