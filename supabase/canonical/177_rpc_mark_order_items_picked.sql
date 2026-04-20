-- 177_rpc_mark_order_items_picked.sql
--
-- Sprint 6: reemplaza el write directo a order_items.status = 'picked' desde admin/orders.js.
-- Idempotencia fuerte via rpc_operations_begin / complete / fail.
-- No toca stock, reserved_qty ni otras tablas.
--
-- Firma:
--   rpc_mark_order_items_picked(
--     p_order_item_ids  uuid[],
--     p_operation_id    uuid,
--     p_request         jsonb default '{}'::jsonb
--   ) returns jsonb
--
-- Retorna:
--   { "ok": true, "updated_count": N, "skipped_count": M, "idempotent_replay": bool }

create or replace function public.rpc_mark_order_items_picked(
  p_order_item_ids  uuid[],
  p_operation_id    uuid,
  p_request         jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_operation_request jsonb;
  v_prev_result       jsonb;
  v_result            jsonb;

  v_existing_ids      uuid[];
  v_unknown_ids       uuid[];
  v_cancelled_ids     uuid[];
  v_updatable_ids     uuid[];
  v_updated_count     int;

  v_err_msg    text;
  v_err_state  text;
  v_err_detail text;
  v_err_hint   text;
begin
  -- ── Validaciones de entrada ───────────────────────────────────────────────

  if p_operation_id is null then
    raise exception 'rpc_mark_order_items_picked: p_operation_id es obligatorio'
      using errcode = '22023';
  end if;

  if p_order_item_ids is null or array_length(p_order_item_ids, 1) is null then
    raise exception 'rpc_mark_order_items_picked: p_order_item_ids no puede estar vacío'
      using errcode = '22023';
  end if;

  -- ── Idempotencia ─────────────────────────────────────────────────────────

  -- Fingerprint incluye el sorted array de ids para detectar requests distintos.
  v_operation_request := coalesce(p_request, '{}'::jsonb)
    || jsonb_build_object(
         'item_ids', (
           select jsonb_agg(x order by x)
           from unnest(p_order_item_ids) as x
         )
       );

  v_prev_result := public.rpc_operations_begin(
    p_operation_id   => p_operation_id,
    p_operation_kind => 'mark_order_items_picked',
    p_request        => v_operation_request,
    p_target_type    => 'order_items',
    p_target_id      => null
  );

  -- Replay de completed: devolver resultado previo exacto.
  if v_prev_result is not null then
    return coalesce(v_prev_result, '{}'::jsonb)
      || jsonb_build_object('idempotent_replay', true);
  end if;

  -- ── Lógica de dominio (dentro de bloque para capturar excepciones) ────────
  begin

    -- Verificar que todos los ids existen.
    select array_agg(id)
      into v_existing_ids
    from public.order_items
    where id = any(p_order_item_ids);

    v_unknown_ids := array(
      select unnest(p_order_item_ids)
      except
      select unnest(coalesce(v_existing_ids, '{}'))
    );

    if array_length(v_unknown_ids, 1) > 0 then
      raise exception
        'rpc_mark_order_items_picked: los siguientes order_item_ids no existen: %',
        v_unknown_ids
        using errcode = '02000';
    end if;

    -- No permitir marcar como picked si el item está cancelado.
    select array_agg(id)
      into v_cancelled_ids
    from public.order_items
    where id = any(p_order_item_ids)
      and status = 'cancelled';

    if array_length(v_cancelled_ids, 1) > 0 then
      raise exception
        'rpc_mark_order_items_picked: no se pueden marcar como picked items cancelados: %',
        v_cancelled_ids
        using errcode = '23000';
    end if;

    -- Items ya en 'picked' se saltean silenciosamente (idempotente a nivel item).
    select array_agg(id)
      into v_updatable_ids
    from public.order_items
    where id = any(p_order_item_ids)
      and status <> 'picked';

    if v_updatable_ids is not null and array_length(v_updatable_ids, 1) > 0 then
      update public.order_items
      set
        status     = 'picked',
        updated_at = now()
      where id = any(v_updatable_ids);

      get diagnostics v_updated_count = row_count;
    else
      v_updated_count := 0;
    end if;

    v_result := jsonb_build_object(
      'ok',            true,
      'updated_count', v_updated_count,
      'skipped_count', array_length(p_order_item_ids, 1) - v_updated_count,
      'idempotent_replay', false
    );

    return public.rpc_operations_complete(p_operation_id, v_result);

  exception
    when others then
      get stacked diagnostics
        v_err_msg    = message_text,
        v_err_state  = returned_sqlstate,
        v_err_detail = pg_exception_detail,
        v_err_hint   = pg_exception_hint;

      begin
        perform public.rpc_operations_fail(
          p_operation_id,
          jsonb_build_object(
            'message',  v_err_msg,
            'sqlstate', v_err_state,
            'detail',   v_err_detail,
            'hint',     v_err_hint
          )
        );
      exception
        when others then null;
      end;

      raise;
  end;
end;
$$;

comment on function public.rpc_mark_order_items_picked(uuid[], uuid, jsonb) is
  'Sprint6: reemplaza el write directo a order_items.status=picked. Idempotencia fuerte via rpc_operations. No toca stock ni reserved_qty.';

revoke all on function public.rpc_mark_order_items_picked(uuid[], uuid, jsonb)
  from public, anon;
grant execute on function public.rpc_mark_order_items_picked(uuid[], uuid, jsonb)
  to authenticated, service_role;

select pg_notify('pgrst', 'reload schema');
