-- 171_rpc_create_public_sale_strong_idempotency.sql
--
-- Sprint 3: idempotencia fuerte + replay-safe para rpc_create_public_sale.
-- En esta etapa se publica firma nueva en paralelo, SIN eliminar la firma vieja.
--
-- Firma nueva:
--   rpc_create_public_sale(
--     p_items jsonb,
--     p_customer_id uuid,
--     p_notes text,
--     p_apply_credit boolean,
--     p_total_amount numeric,
--     p_operation_id uuid,
--     p_request jsonb default '{}'
--   )
--
-- Estrategia:
--   - Capa de idempotencia en wrapper (rpc_operations_begin/complete/fail)
--   - Lógica de dominio intacta: delega a la firma vieja de 5 parámetros.
--   - Replay de completed => devuelve result_json previo exacto.
--   - mismatch fingerprint / in_progress => delegado a rpc_operations_begin.

create or replace function public.rpc_create_public_sale(
  p_items jsonb,
  p_customer_id uuid,
  p_notes text,
  p_apply_credit boolean,
  p_total_amount numeric(15,2),
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
  v_target_id text;

  v_err_msg text;
  v_err_state text;
  v_err_detail text;
  v_err_hint text;
begin
  if p_operation_id is null then
    raise exception 'rpc_create_public_sale: p_operation_id es obligatorio'
      using errcode = '22023';
  end if;

  -- Canonical request fingerprint: incluye SIEMPRE los argumentos de dominio
  -- para evitar colisiones semánticas aunque p_request venga vacío o incompleto.
  v_operation_request := coalesce(p_request, '{}'::jsonb)
    || jsonb_build_object(
      'items', coalesce(p_items, '[]'::jsonb),
      'customer_id', p_customer_id,
      'notes', p_notes,
      'apply_credit', p_apply_credit,
      'total_amount', p_total_amount
    );

  v_prev_result := public.rpc_operations_begin(
    p_operation_id => p_operation_id,
    p_operation_kind => 'create_public_sale',
    p_request => v_operation_request,
    p_target_type => 'public_sale',
    p_target_id => null
  );

  -- Replay completed: devolver resultado previo exacto (replay-safe).
  if v_prev_result is not null then
    return coalesce(v_prev_result, '{}'::jsonb) || jsonb_build_object('idempotent_replay', true);
  end if;

  begin
    -- Dominio intacto: delegar a la firma canónica existente (5 args).
    v_result := public.rpc_create_public_sale(
      p_items,
      p_customer_id,
      p_notes,
      p_apply_credit,
      p_total_amount
    )::jsonb;

    -- Trazabilidad por entidad: completar target_id cuando ya existe sale_id.
    v_target_id := coalesce(v_result->>'sale_id', v_result->>'id');
    if v_target_id is not null and trim(v_target_id) <> '' then
      update public.rpc_operations
      set target_id = v_target_id
      where operation_id = p_operation_id
        and (target_id is null or trim(target_id) = '');
    end if;

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

comment on function public.rpc_create_public_sale(jsonb, uuid, text, boolean, numeric, uuid, jsonb) is
  'Sprint3: wrapper idempotente fuerte para create_public_sale; delega lógica de dominio a firma legacy de 5 parámetros.';

revoke all on function public.rpc_create_public_sale(jsonb, uuid, text, boolean, numeric, uuid, jsonb)
  from public, anon;
grant execute on function public.rpc_create_public_sale(jsonb, uuid, text, boolean, numeric, uuid, jsonb)
  to authenticated, service_role;

select pg_notify('pgrst', 'reload schema');
