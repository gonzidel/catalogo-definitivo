-- 170_rpc_void_public_sale_strong_idempotency.sql
--
-- Sprint 3 (piloto): idempotencia fuerte + replay-safe en rpc_void_public_sale.
-- Cambios de contrato:
--   - agrega p_operation_id uuid
--   - agrega p_request jsonb
--
-- Mantiene la lógica de dominio existente:
--   - lock FOR UPDATE sobre public_sales
--   - chequeo de voided_at
--   - no doble restauración de stock
--
-- Usa infraestructura común:
--   - rpc_operations_begin
--   - rpc_operations_complete
--   - rpc_operations_fail
--
-- Compatibilidad:
--   - En esta etapa NO se elimina la firma vieja rpc_void_public_sale(uuid).
--   - Se publica la firma nueva en paralelo para migración progresiva de frontend.

create or replace function public.rpc_void_public_sale(
  p_sale_id uuid,
  p_operation_id uuid,
  p_request jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_sale record;
  v_psi record;
  v_wh_vp uuid;
  v_wh_g uuid;
  v_pv_size text;
  v_norm text;
  v_has_size_model boolean;

  v_operation_request jsonb;
  v_prev_result jsonb;
  v_result jsonb;

  v_err_msg text;
  v_err_state text;
  v_err_detail text;
  v_err_hint text;
begin
  if p_sale_id is null then
    raise exception 'rpc_void_public_sale: p_sale_id es obligatorio'
      using errcode = '22023';
  end if;

  if p_operation_id is null then
    raise exception 'rpc_void_public_sale: p_operation_id es obligatorio'
      using errcode = '22023';
  end if;

  -- Incluye target en el fingerprint para diferenciar reuso accidental de operation_id
  -- sobre otra venta, incluso si el cliente envía p_request vacío.
  v_operation_request := coalesce(p_request, '{}'::jsonb)
    || jsonb_build_object('sale_id', p_sale_id);

  v_prev_result := public.rpc_operations_begin(
    p_operation_id => p_operation_id,
    p_operation_kind => 'void_public_sale',
    p_request => v_operation_request,
    p_target_type => 'public_sale',
    p_target_id => p_sale_id::text
  );

  -- Replay de operación ya completada: devolver resultado previo exacto.
  if v_prev_result is not null then
    return coalesce(v_prev_result, '{}'::jsonb) || jsonb_build_object('idempotent_replay', true);
  end if;

  begin
    select id into v_wh_vp from public.warehouses where code = 'venta-publico' limit 1;
    select id into v_wh_g from public.warehouses where code = 'general' limit 1;

    if v_wh_vp is null then
      raise exception 'Warehouse venta-publico no encontrado';
    end if;
    if v_wh_g is null then
      raise exception 'Warehouse general no encontrado';
    end if;

    -- Lock fuerte para evitar doble restauración concurrente.
    select id, sale_number, customer_id, credit_used, voided_at
    into v_sale
    from public.public_sales
    where id = p_sale_id
    for update;

    if v_sale.id is null then
      raise exception 'Venta no encontrada';
    end if;

    -- Idempotencia de dominio: si ya está anulada (por otra operación previa),
    -- devolvemos noop y registramos completed para esta operation_id.
    if v_sale.voided_at is not null then
      v_result := jsonb_build_object(
        'success', true,
        'sale_number', v_sale.sale_number,
        'idempotent_noop', true
      );
      v_result := coalesce(v_result, '{}'::jsonb) || jsonb_build_object('idempotent_replay', false);
      return public.rpc_operations_complete(p_operation_id, v_result);
    end if;

    for v_psi in
      select psi.*, pv.size as pv_size
      from public.public_sale_items psi
      left join public.product_variants pv on pv.id = psi.variant_id
      where psi.sale_id = p_sale_id and psi.variant_id is not null
    loop
      if (v_psi.qty_venta_publico is null) <> (v_psi.qty_general is null) then
        raise exception 'public_sale_items id %: qty_venta_publico y qty_general deben ser ambas NULL o ambas NOT NULL',
          v_psi.id;
      end if;

      if v_psi.qty_venta_publico is null and v_psi.qty_general is null then
        select (
          exists (
            select 1
            from public.variant_size_warehouse_stock
            where variant_id = v_psi.variant_id
            limit 1
          )
          or exists (
            select 1
            from public.variant_sizes
            where variant_id = v_psi.variant_id
              and trim(coalesce(size, '')) <> ''
            limit 1
          )
        )
        into v_has_size_model;

        if coalesce(v_has_size_model, false) then
          raise exception 'La variante % usa talles. No se puede anular línea legacy sin size.', v_psi.variant_id;
        end if;

        if v_psi.is_return then
          update public.variant_warehouse_stock
          set stock_qty = greatest(0, stock_qty - v_psi.qty), updated_at = now()
          where variant_id = v_psi.variant_id and warehouse_id = v_wh_vp;
        else
          insert into public.variant_warehouse_stock (variant_id, warehouse_id, stock_qty)
          values (v_psi.variant_id, v_wh_vp, v_psi.qty)
          on conflict (variant_id, warehouse_id)
          do update set
            stock_qty = public.variant_warehouse_stock.stock_qty + v_psi.qty,
            updated_at = now();
        end if;
        continue;
      end if;

      v_norm := null;
      if v_psi.sold_size_normalized is not null and trim(v_psi.sold_size_normalized::text) != '' then
        v_norm := trim(v_psi.sold_size_normalized::text);
        if v_norm ~ '^\d+(\.\d+)?$' then
          v_norm := split_part(v_norm, '.', 1);
        end if;
      end if;
      if v_norm is null or v_norm = '' then
        v_pv_size := v_psi.pv_size;
        if v_pv_size is not null and trim(v_pv_size::text) != '' then
          v_norm := trim(v_pv_size::text);
          if v_norm ~ '^\d+(\.\d+)?$' then
            v_norm := split_part(v_norm, '.', 1);
          end if;
        end if;
      end if;

      if v_norm is null or v_norm = '' then
        select (
          exists (
            select 1
            from public.variant_size_warehouse_stock
            where variant_id = v_psi.variant_id
            limit 1
          )
          or exists (
            select 1
            from public.variant_sizes
            where variant_id = v_psi.variant_id
              and trim(coalesce(size, '')) <> ''
            limit 1
          )
        )
        into v_has_size_model;

        if coalesce(v_has_size_model, false) then
          raise exception 'La variante % usa talles. No se puede anular línea sin size.', v_psi.variant_id;
        end if;

        if v_psi.is_return then
          update public.variant_warehouse_stock
          set stock_qty = greatest(0, stock_qty - v_psi.qty), updated_at = now()
          where variant_id = v_psi.variant_id and warehouse_id = v_wh_vp;
        else
          insert into public.variant_warehouse_stock (variant_id, warehouse_id, stock_qty)
          values (v_psi.variant_id, v_wh_vp, v_psi.qty)
          on conflict (variant_id, warehouse_id)
          do update set
            stock_qty = public.variant_warehouse_stock.stock_qty + v_psi.qty,
            updated_at = now();
        end if;
        continue;
      end if;

      if v_psi.is_return then
        if v_psi.qty_venta_publico > 0 then
          update public.variant_size_warehouse_stock
          set stock_qty = greatest(0, stock_qty - v_psi.qty_venta_publico), updated_at = now()
          where variant_id = v_psi.variant_id and size = v_norm and warehouse_id = v_wh_vp;
        end if;
      else
        if v_psi.qty_venta_publico > 0 then
          insert into public.variant_size_warehouse_stock (variant_id, size, warehouse_id, stock_qty)
          values (v_psi.variant_id, v_norm, v_wh_vp, 0)
          on conflict (variant_id, size, warehouse_id) do nothing;
          update public.variant_size_warehouse_stock
          set stock_qty = stock_qty + v_psi.qty_venta_publico, updated_at = now()
          where variant_id = v_psi.variant_id and size = v_norm and warehouse_id = v_wh_vp;
        end if;
        if v_psi.qty_general > 0 then
          insert into public.variant_size_warehouse_stock (variant_id, size, warehouse_id, stock_qty)
          values (v_psi.variant_id, v_norm, v_wh_g, 0)
          on conflict (variant_id, size, warehouse_id) do nothing;
          update public.variant_size_warehouse_stock
          set stock_qty = stock_qty + v_psi.qty_general, updated_at = now()
          where variant_id = v_psi.variant_id and size = v_norm and warehouse_id = v_wh_g;
        end if;
      end if;
    end loop;

    if v_sale.customer_id is not null and coalesce(v_sale.credit_used, 0) > 0 then
      perform public.rpc_add_customer_credit(
        v_sale.customer_id,
        v_sale.credit_used,
        'Crédito restaurado por anulación de venta ' || v_sale.sale_number
      );
    end if;

    update public.public_sales
    set voided_at = now()
    where id = p_sale_id
      and voided_at is null;

    v_result := jsonb_build_object(
      'success', true,
      'sale_number', v_sale.sale_number,
      'idempotent_noop', false
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
          -- No ocultar nunca el error de dominio original.
          null;
      end;
      raise;
  end;
end;
$$;

comment on function public.rpc_void_public_sale(uuid, uuid, jsonb) is
  'Sprint3 piloto: idempotencia fuerte via rpc_operations_* + lógica de void canónica (lock FOR UPDATE, guard voided_at, no doble restauración).';

revoke all on function public.rpc_void_public_sale(uuid, uuid, jsonb)
  from public, anon;
grant execute on function public.rpc_void_public_sale(uuid, uuid, jsonb)
  to authenticated, service_role;

select pg_notify('pgrst', 'reload schema');
