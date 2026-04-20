-- 179_rpc_admin_manual_inject_and_deduct.sql
--
-- Cuando el admin agrega un ítem a un pedido y el sistema muestra stock = 0
-- pero él confirma tener la unidad físicamente, esta RPC:
--
--   1. Inyecta +qty en variant_size_warehouse_stock   → registra admin_manual_confirmation
--   2. Deduce -qty en la misma fila (misma TX)         → registra order_deduction
--   3. Inserta en order_item_stock_sources              → permite restaurar en cancelación
--   4. Incrementa product_variants.reserved_qty
--
-- Efecto neto en stock: 0. La unidad no "aparece" en el sistema de forma permanente.
-- En cancelación/devolución, order_item_stock_sources guía la restauración al warehouse
-- correcto, por lo que la unidad sí reaparece (comportamiento correcto: vuelve a
-- estar disponible en el sistema cuando el pedido se cancela o devuelve).
--
-- Firma:
--   rpc_admin_manual_inject_and_deduct(
--     p_items    jsonb,   -- [{variant_id, size, warehouse_id?, qty, order_item_id?}]
--     p_order_id uuid default null
--   ) returns jsonb

create or replace function public.rpc_admin_manual_inject_and_deduct(
  p_items    jsonb,
  p_order_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_uid           uuid;
  v_general_id    uuid;
  v_rec           record;
  v_variant_id    uuid;
  v_size_norm     text;
  v_warehouse_id  uuid;
  v_qty           int;
  v_order_item_id uuid;
  v_product_id    uuid;
  v_stock_before  int;
  v_after_inject  int;
  v_after_deduct  int;
  v_processed     int := 0;
  v_details       jsonb := '[]'::jsonb;
begin
  -- ────────────────────────────────────────────────────────────────────
  -- 1. Auth: solo admins.
  -- ────────────────────────────────────────────────────────────────────
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'rpc_admin_manual_inject_and_deduct: no autenticado';
  end if;
  if not exists (select 1 from public.admins where user_id = v_uid) then
    raise exception 'rpc_admin_manual_inject_and_deduct: solo administradores';
  end if;

  -- ────────────────────────────────────────────────────────────────────
  -- 2. Validar payload raíz.
  -- ────────────────────────────────────────────────────────────────────
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    return jsonb_build_object('ok', true, 'processed', 0);
  end if;

  -- ────────────────────────────────────────────────────────────────────
  -- 3. Warehouse general para fallback cuando no se especifica warehouse.
  -- ────────────────────────────────────────────────────────────────────
  select id into v_general_id from public.warehouses where code = 'general' limit 1;

  if v_general_id is null then
    raise exception 'rpc_admin_manual_inject_and_deduct: no se encontró el warehouse "general"';
  end if;

  -- ────────────────────────────────────────────────────────────────────
  -- 4. Procesar en orden determinístico para evitar deadlocks.
  -- ────────────────────────────────────────────────────────────────────
  for v_rec in
    select
      (elem->>'variant_id')::uuid                                  as variant_id,
      elem->>'size'                                                as size_raw,
      nullif(elem->>'warehouse_id', '')::uuid                      as warehouse_id,
      (elem->>'qty')::int                                          as qty,
      nullif(elem->>'order_item_id', '')::uuid                     as order_item_id
    from jsonb_array_elements(p_items) as elem
    order by
      (elem->>'variant_id')::uuid,
      elem->>'size'
  loop
    v_variant_id    := v_rec.variant_id;
    v_qty           := v_rec.qty;
    v_order_item_id := v_rec.order_item_id;
    v_warehouse_id  := coalesce(v_rec.warehouse_id, v_general_id);

    -- Validaciones básicas
    if v_variant_id is null then
      raise exception 'rpc_admin_manual_inject_and_deduct: variant_id null en un ítem';
    end if;
    if v_qty is null or v_qty <= 0 then
      raise exception 'rpc_admin_manual_inject_and_deduct: qty debe ser > 0 (variant=%)', v_variant_id;
    end if;

    -- Normalizar size (idéntico a rpc_apply_order_stock_deduction)
    v_size_norm := trim(coalesce(v_rec.size_raw, ''));
    if v_size_norm = '' then
      raise exception 'rpc_admin_manual_inject_and_deduct: size vacío (variant=%)', v_variant_id;
    end if;
    if v_size_norm ~ '^\d+(\.\d+)?$' then
      v_size_norm := split_part(v_size_norm, '.', 1);
    end if;

    -- Obtener product_id para auditoría
    select product_id into v_product_id
    from public.product_variants
    where id = v_variant_id;

    if not found then
      raise exception 'rpc_admin_manual_inject_and_deduct: variant % no encontrada', v_variant_id;
    end if;

    -- ──────────────────────────────────────────────────────────────────
    -- 4a. Crear fila de stock si no existe (con 0), luego lockear.
    --     Necesario para poder hacer SELECT FOR UPDATE a continuación.
    -- ──────────────────────────────────────────────────────────────────
    insert into public.variant_size_warehouse_stock (variant_id, size, warehouse_id, stock_qty)
    values (v_variant_id, v_size_norm, v_warehouse_id, 0)
    on conflict (variant_id, size, warehouse_id) do nothing;

    select stock_qty
    into   v_stock_before
    from   public.variant_size_warehouse_stock
    where  variant_id   = v_variant_id
      and  size         = v_size_norm
      and  warehouse_id = v_warehouse_id
    for update;

    v_after_inject := v_stock_before + v_qty;
    v_after_deduct := v_stock_before;   -- neto = 0; vuelve al valor original

    -- ──────────────────────────────────────────────────────────────────
    -- 4b. Inyectar +qty.
    -- ──────────────────────────────────────────────────────────────────
    update public.variant_size_warehouse_stock
    set    stock_qty  = v_after_inject,
           updated_at = now()
    where  variant_id   = v_variant_id
      and  size         = v_size_norm
      and  warehouse_id = v_warehouse_id;

    perform public.log_stock_change(
      v_product_id,
      v_variant_id,
      v_size_norm,
      v_warehouse_id,
      'admin_manual_confirmation',
      v_stock_before,
      v_after_inject,
      null, null,
      concat_ws(' | ',
        'Confirmación manual admin',
        case when p_order_id      is not null then 'order_id:'      || p_order_id::text      end,
        case when v_order_item_id is not null then 'order_item_id:' || v_order_item_id::text end
      )
    );

    -- ──────────────────────────────────────────────────────────────────
    -- 4c. Deducir -qty (misma fila ya lockeada, misma transacción).
    -- ──────────────────────────────────────────────────────────────────
    update public.variant_size_warehouse_stock
    set    stock_qty  = v_after_deduct,
           updated_at = now()
    where  variant_id   = v_variant_id
      and  size         = v_size_norm
      and  warehouse_id = v_warehouse_id;

    perform public.log_stock_change(
      v_product_id,
      v_variant_id,
      v_size_norm,
      v_warehouse_id,
      'order_deduction',
      v_after_inject,
      v_after_deduct,
      null, null,
      concat_ws(' | ',
        'Descuento por confirmación manual admin',
        case when p_order_id      is not null then 'order_id:'      || p_order_id::text      end,
        case when v_order_item_id is not null then 'order_item_id:' || v_order_item_id::text end
      )
    );

    -- ──────────────────────────────────────────────────────────────────
    -- 4d. Registrar fuente de stock para restauración en cancelación.
    --     rpc_remove_order_item_restore_stock usa order_item_stock_sources
    --     para saber a qué warehouse devolver el stock.
    -- ──────────────────────────────────────────────────────────────────
    if v_order_item_id is not null then
      insert into public.order_item_stock_sources (order_item_id, warehouse_id, qty)
      values (v_order_item_id, v_warehouse_id, v_qty);
    end if;

    -- ──────────────────────────────────────────────────────────────────
    -- 4e. Incrementar reserved_qty (equivalente a rpc_apply_order_stock_deduction).
    -- ──────────────────────────────────────────────────────────────────
    update public.product_variants
    set    reserved_qty = greatest(coalesce(reserved_qty, 0) + v_qty, 0)
    where  id = v_variant_id;

    v_processed := v_processed + 1;
    v_details   := v_details || jsonb_build_object(
      'variant_id',      v_variant_id,
      'size',            v_size_norm,
      'warehouse_id',    v_warehouse_id,
      'qty',             v_qty,
      'order_item_id',   v_order_item_id,
      'stock_before',    v_stock_before,
      'stock_after_net', v_after_deduct
    );
  end loop;

  return jsonb_build_object(
    'ok',        true,
    'processed', v_processed,
    'order_id',  p_order_id,
    'details',   v_details
  );
end;
$$;

comment on function public.rpc_admin_manual_inject_and_deduct(jsonb, uuid) is
  'Sprint6+: inyecta +qty y deduce -qty en una sola TX para ítems confirmados manualmente por admin '
  'sin stock en sistema. Efecto neto en stock = 0. Puebla order_item_stock_sources para que la '
  'cancelación/devolución restaure la unidad al warehouse correcto.';

revoke all    on function public.rpc_admin_manual_inject_and_deduct(jsonb, uuid) from public, anon;
grant  execute on function public.rpc_admin_manual_inject_and_deduct(jsonb, uuid) to authenticated, service_role;

select pg_notify('pgrst', 'reload schema');
