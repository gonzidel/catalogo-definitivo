-- 174_rpc_checkout_cart_strong_idempotency.sql
--
-- Sprint 3: idempotencia fuerte + replay-safe para rpc_checkout_cart.
--
-- Cambios de contrato (firma nueva, en paralelo con la vieja):
--   - p_operation_id uuid (obligatorio)
--   - p_request jsonb default '{}'::jsonb
--   - returns jsonb (la firma vieja devolvía json)
--
-- Mantiene la lógica de dominio existente delegando en la firma vieja
-- public.rpc_checkout_cart() (canonical:124 vía 149):
--   - validación de carrito y de items
--   - resolución de orden activa o creación nueva
--   - descuento de stock por size + general/venta-publico
--   - inserts en order_items + sources implícitas
--   - vaciado del cart
--   - cálculo de totales y devolución de order_id/order_number
--
-- Usa infraestructura común:
--   - rpc_operations_begin
--   - rpc_operations_complete
--   - rpc_operations_fail
--
-- Defensa adicional sobre la firma vieja:
--   - SELECT FOR UPDATE sobre carts del usuario (lock pesimista) para serializar
--     intentos concurrentes con operation_id distinto sobre el mismo carrito.
--     El advisory lock de rpc_operations_begin solo protege la misma operation_id.
--
-- Compatibilidad:
--   - NO se elimina la firma vieja public.rpc_checkout_cart() en esta etapa.
--   - Se publica la firma nueva en paralelo para migración progresiva del cliente.

create or replace function public.rpc_checkout_cart(
  p_operation_id uuid,
  p_request jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_user_id uuid;
  v_request_eff jsonb;
  v_prev_result jsonb;
  v_result jsonb;
  v_cart_id uuid;
  v_order_id_text text;

  v_err_msg text;
  v_err_state text;
  v_err_detail text;
  v_err_hint text;
begin
  if p_operation_id is null then
    raise exception 'rpc_checkout_cart: p_operation_id es obligatorio'
      using errcode = '22023';
  end if;

  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  -- Fingerprint canónico: incluir SIEMPRE customer_id en backend para evitar
  -- reuso accidental cross-user del mismo operation_id. El cliente debería
  -- adjuntar adicionalmente cart_fingerprint dentro de p_request.
  v_request_eff := coalesce(p_request, '{}'::jsonb)
    || jsonb_build_object('customer_id', v_user_id);

  v_prev_result := public.rpc_operations_begin(
    p_operation_id => p_operation_id,
    p_operation_kind => 'checkout_cart',
    p_request => v_request_eff,
    p_target_type => 'cart_checkout',
    p_target_id => v_user_id::text
  );

  -- Replay de operación ya completada: devolver resultado previo + flag explícito.
  if v_prev_result is not null then
    return coalesce(v_prev_result, '{}'::jsonb)
      || jsonb_build_object('idempotent_replay', true);
  end if;

  begin
    -- Lock pesimista del carrito activo del usuario.
    -- Sirve como defensa contra retries con operation_id distinto sobre el
    -- mismo cart: una segunda transacción esperará y luego verá el cart
    -- vacío (cart_items eliminados por la firma vieja en el primer intento).
    select id
      into v_cart_id
    from public.carts
    where customer_id = v_user_id
      and status = 'open'
    order by created_at desc
    limit 1
    for update;

    -- Validación explícita de carrito inexistente: mensaje claro y consistente
    -- con la firma vieja, antes de delegar.
    if v_cart_id is null then
      raise exception 'No se encontró un carrito activo.';
    end if;

    -- Dominio intacto: ejecutar la lógica canónica existente. Toda la lógica
    -- de stock, order, order_items, vaciado de cart y totales sigue ahí.
    v_result := public.rpc_checkout_cart()::jsonb;

    -- Trazabilidad por entidad: setear target_id con order_id solo si vino
    -- válido en el resultado. No pisar con null/blanco.
    v_order_id_text := nullif(trim(coalesce(v_result->>'order_id', '')), '');
    if v_order_id_text is not null then
      update public.rpc_operations
      set target_id = v_order_id_text
      where operation_id = p_operation_id
        and (
          target_id is null
          or trim(target_id) = ''
          or target_id = v_user_id::text
        );
    end if;

    v_result := coalesce(v_result, '{}'::jsonb)
      || jsonb_build_object('idempotent_replay', false);

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
          -- No ocultar nunca el error de dominio original.
          null;
      end;

      raise;
  end;
end;
$$;

comment on function public.rpc_checkout_cart(uuid, jsonb) is
  'Sprint3: wrapper idempotente fuerte para checkout. Lock pesimista de carts del usuario y delegación a la firma legacy rpc_checkout_cart() (canonical:124 vía 149). Devuelve idempotent_replay explícito.';

revoke all on function public.rpc_checkout_cart(uuid, jsonb)
  from public, anon;
grant execute on function public.rpc_checkout_cart(uuid, jsonb)
  to authenticated, service_role;

select pg_notify('pgrst', 'reload schema');
