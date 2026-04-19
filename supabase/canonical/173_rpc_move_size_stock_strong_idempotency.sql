-- 173_rpc_move_size_stock_strong_idempotency.sql
--
-- Sprint 3: idempotencia fuerte + replay-safe para rpc_move_size_stock.
-- Se publica firma nueva en paralelo, SIN eliminar la firma vieja.
--
-- Firma nueva:
--   rpc_move_size_stock(
--     p_variant_id uuid,
--     p_size text,
--     p_from_warehouse_code text,
--     p_to_warehouse_code text,
--     p_quantity int,
--     p_notes text,
--     p_operation_id uuid,
--     p_request jsonb default '{}'
--   ) returns jsonb
--
-- Estrategia:
--   - Capa de idempotencia con rpc_operations_begin/complete/fail.
--   - Lógica de dominio intacta: delega en firma legacy de 6 parámetros.
--   - Replay completed devuelve el result_json previo exacto.

create or replace function public.rpc_move_size_stock(
  p_variant_id uuid,
  p_size text,
  p_from_warehouse_code text,
  p_to_warehouse_code text,
  p_quantity int,
  p_notes text,
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
  if p_operation_id is null then
    raise exception 'rpc_move_size_stock: p_operation_id es obligatorio'
      using errcode = '22023';
  end if;

  -- Fingerprint canónico: incluir SIEMPRE los argumentos de dominio.
  v_operation_request := coalesce(p_request, '{}'::jsonb)
    || jsonb_build_object(
      'variant_id', p_variant_id,
      'size', p_size,
      'from_warehouse_code', p_from_warehouse_code,
      'to_warehouse_code', p_to_warehouse_code,
      'quantity', p_quantity,
      'notes', p_notes
    );

  v_prev_result := public.rpc_operations_begin(
    p_operation_id => p_operation_id,
    p_operation_kind => 'move_size_stock',
    p_request => v_operation_request,
    p_target_type => 'variant_size_stock',
    p_target_id => coalesce(p_variant_id::text, null)
  );

  -- Replay de completed: devolver resultado previo exacto.
  if v_prev_result is not null then
    return coalesce(v_prev_result, '{}'::jsonb) || jsonb_build_object('idempotent_replay', true);
  end if;

  begin
    -- Dominio intacto: ejecutar lógica existente (validaciones, locks, movimiento, trazabilidad).
    v_result := public.rpc_move_size_stock(
      p_variant_id,
      p_size,
      p_from_warehouse_code,
      p_to_warehouse_code,
      p_quantity,
      p_notes
    )::jsonb;

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

comment on function public.rpc_move_size_stock(uuid, text, text, text, int, text, uuid, jsonb) is
  'Sprint3: wrapper idempotente fuerte para movimiento de stock por talle; delega lógica a rpc_move_size_stock(uuid,text,text,text,int,text).';

revoke all on function public.rpc_move_size_stock(uuid, text, text, text, int, text, uuid, jsonb)
  from public, anon;
grant execute on function public.rpc_move_size_stock(uuid, text, text, text, int, text, uuid, jsonb)
  to authenticated, service_role;

select pg_notify('pgrst','reload schema');
