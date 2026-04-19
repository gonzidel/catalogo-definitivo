-- 166_rpc_apply_order_stock_deduction.sql
--
-- Etapa 2 del endurecimiento del flujo de stock.
-- RPC de descuento transaccional de stock por pedido.
--
-- Reemplaza la lógica de admin/order-creator.js::updateStockBatch, que hoy:
--   1. Lee stock actual en el cliente (race condition).
--   2. Calcula el nuevo valor absoluto en JS (newQty = current - qty).
--   3. Hace upsert directo del valor absoluto sin lock (corrupción posible bajo concurrencia).
--
-- Esta RPC:
--   - Recibe un array de descuentos por fila (variant + size + warehouse + qty_to_deduct).
--   - Usa SELECT … FOR UPDATE para eliminar la race condition.
--   - Procesa items en orden determinístico para evitar deadlocks.
--   - Agrega duplicados (mismo variant+size+warehouse) antes de lockear.
--   - Valida stock suficiente antes de escribir; rechaza toda la transacción si falla alguno.
--   - Registra auditoría en stock_history con change_type = 'order_deduction'.
--   - NO usa rpc_set_variant_size_stock_batch (esa RPC recibe valor absoluto, esta recibe delta).
--
-- Llamada típica desde updateStockBatch (migración pendiente):
--   supabase.rpc('rpc_apply_order_stock_deduction', {
--     p_items: [
--       { variant_id, size, warehouse_id, qty_to_deduct, order_item_id? },
--       ...
--     ],
--     p_order_id: '<uuid>',
--     p_source: 'order_creation'
--   })

create or replace function public.rpc_apply_order_stock_deduction(
  p_items    jsonb,
  p_order_id uuid default null,
  p_source   text default 'order_creation'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  -- Auth
  v_user_id    uuid;
  v_is_admin   boolean;

  -- Source validation
  v_source            text;
  v_allowed_sources   constant text[] := array[
    'order_creation',
    'order_edit',
    'order_manual'
  ];

  -- Counters
  v_total_input   int := 0;
  v_applied_items int := 0;
  v_details       jsonb := '[]'::jsonb;

  -- Per-item variables
  v_rec             record;
  v_variant_id      uuid;
  v_warehouse_id    uuid;
  v_product_id      uuid;
  v_size_raw        text;
  v_size_norm       text;
  v_qty_to_deduct   int;
  v_order_item_id   uuid;
  v_stock_before    int;
  v_stock_after     int;
  v_notes_val       text;
begin
  -- ─────────────────────────────────────────────────────────────────
  -- 1. Autenticación y autorización (solo admins).
  -- ─────────────────────────────────────────────────────────────────
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'rpc_apply_order_stock_deduction: usuario no autenticado';
  end if;

  select exists (
    select 1 from public.admins where user_id = v_user_id
  ) into v_is_admin;

  if not v_is_admin then
    raise exception 'rpc_apply_order_stock_deduction: forbidden (solo admins)';
  end if;

  -- ─────────────────────────────────────────────────────────────────
  -- 2. Validar payload raíz.
  -- ─────────────────────────────────────────────────────────────────
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'rpc_apply_order_stock_deduction: p_items debe ser un array jsonb';
  end if;

  if jsonb_array_length(p_items) = 0 then
    return jsonb_build_object(
      'ok',           true,
      'total_input',  0,
      'applied_items',0,
      'order_id',     p_order_id,
      'source',       p_source,
      'details',      '[]'::jsonb
    );
  end if;

  v_total_input := jsonb_array_length(p_items);

  -- ─────────────────────────────────────────────────────────────────
  -- 3. Normalizar y validar source.
  -- ─────────────────────────────────────────────────────────────────
  v_source := coalesce(nullif(trim(p_source), ''), 'order_creation');
  if not (v_source = any (v_allowed_sources)) then
    raise exception
      'rpc_apply_order_stock_deduction: source inválido "%". Permitidos: %',
      v_source, array_to_string(v_allowed_sources, ', ');
  end if;

  -- ─────────────────────────────────────────────────────────────────
  -- 4. Pre-validar cada ítem (sin lockear aún).
  --    Falla rápido ante datos malformados antes de tocar filas.
  -- ─────────────────────────────────────────────────────────────────
  for v_rec in
    select
      (item->>'variant_id')::uuid    as variant_id,
      item->>'size'                  as size_raw,
      (item->>'warehouse_id')::uuid  as warehouse_id,
      (item->>'qty_to_deduct')::int  as qty_to_deduct,
      ord                            as idx
    from jsonb_array_elements(p_items) with ordinality as t(item, ord)
  loop
    if v_rec.variant_id is null then
      raise exception
        'rpc_apply_order_stock_deduction: variant_id null en ítem #%', v_rec.idx;
    end if;
    if v_rec.warehouse_id is null then
      raise exception
        'rpc_apply_order_stock_deduction: warehouse_id null en ítem #% (variant_id=%)',
        v_rec.idx, v_rec.variant_id;
    end if;
    if v_rec.size_raw is null or trim(v_rec.size_raw) = '' then
      raise exception
        'rpc_apply_order_stock_deduction: size null/vacío en ítem #% (variant_id=%)',
        v_rec.idx, v_rec.variant_id;
    end if;
    if v_rec.qty_to_deduct is null or v_rec.qty_to_deduct <= 0 then
      raise exception
        'rpc_apply_order_stock_deduction: qty_to_deduct debe ser > 0 en ítem #% (variant_id=%, valor=%)',
        v_rec.idx, v_rec.variant_id, v_rec.qty_to_deduct;
    end if;
  end loop;

  -- ─────────────────────────────────────────────────────────────────
  -- 5. Procesar en orden determinístico, con agregación de duplicados.
  --
  --    ORDEN: (variant_id, size_norm, warehouse_id) — igual en todas las
  --    transacciones concurrentes → previene deadlocks.
  --
  --    SUM(qty_to_deduct): si el mismo SKU aparece en dos líneas del pedido
  --    (ej. el admin lo agregó dos veces), se colapsa en una sola pasada con
  --    un único SELECT FOR UPDATE, un único UPDATE y un único log.
  -- ─────────────────────────────────────────────────────────────────
  for v_rec in
    select
      (item->>'variant_id')::uuid                               as variant_id,
      -- Normalización de size idéntica a rpc_set_variant_size_stock_batch:
      -- trim de espacios, y si es número con decimales tipo "42.0" → "42".
      case
        when trim(both ' ' from item->>'size') ~ '^\d+(\.\d+)?$'
          then split_part(trim(both ' ' from item->>'size'), '.', 1)
        else trim(both ' ' from item->>'size')
      end                                                        as size_norm,
      (item->>'warehouse_id')::uuid                             as warehouse_id,
      sum((item->>'qty_to_deduct')::int)                        as qty_to_deduct,
      -- Tomar el primer order_item_id del grupo (para el log de auditoría).
      (array_agg(nullif(item->>'order_item_id','')))[1]::uuid   as order_item_id
    from jsonb_array_elements(p_items) as t(item)
    group by
      (item->>'variant_id')::uuid,
      case
        when trim(both ' ' from item->>'size') ~ '^\d+(\.\d+)?$'
          then split_part(trim(both ' ' from item->>'size'), '.', 1)
        else trim(both ' ' from item->>'size')
      end,
      (item->>'warehouse_id')::uuid
    order by
      (item->>'variant_id')::uuid,
      case
        when trim(both ' ' from item->>'size') ~ '^\d+(\.\d+)?$'
          then split_part(trim(both ' ' from item->>'size'), '.', 1)
        else trim(both ' ' from item->>'size')
      end,
      (item->>'warehouse_id')::uuid
  loop
    v_variant_id    := v_rec.variant_id;
    v_size_norm     := v_rec.size_norm;
    v_warehouse_id  := v_rec.warehouse_id;
    v_qty_to_deduct := v_rec.qty_to_deduct;
    v_order_item_id := v_rec.order_item_id;

    -- 5a. Obtener product_id para el log (la variante existe: fue validada arriba).
    select product_id into v_product_id
    from public.product_variants
    where id = v_variant_id;

    if not found then
      raise exception
        'rpc_apply_order_stock_deduction: variant_id % no existe en product_variants',
        v_variant_id;
    end if;

    -- 5b. Lock pesimista de la fila de stock.
    --     SELECT FOR UPDATE bloquea la fila hasta fin de transacción.
    --     Dos transacciones concurrentes sobre el mismo SKU se serializan aquí:
    --     la segunda esperará a que la primera haga commit antes de continuar,
    --     garantizando que lea el stock ya actualizado.
    select stock_qty
    into v_stock_before
    from public.variant_size_warehouse_stock
    where variant_id  = v_variant_id
      and size        = v_size_norm
      and warehouse_id = v_warehouse_id
    for update;

    if not found then
      -- La fila no existe → stock efectivo = 0 → no se puede descontar.
      raise exception
        'rpc_apply_order_stock_deduction: sin fila de stock para variant=%, size=%, warehouse=% '
        '(stock efectivo 0, no se puede descontar %u.)',
        v_variant_id, v_size_norm, v_warehouse_id, v_qty_to_deduct;
    end if;

    -- 5c. Validar stock suficiente.
    if v_stock_before < v_qty_to_deduct then
      raise exception
        'rpc_apply_order_stock_deduction: stock insuficiente para variant=%, size=%, warehouse=%: '
        'disponible=%, solicitado=%.',
        v_variant_id, v_size_norm, v_warehouse_id,
        v_stock_before, v_qty_to_deduct;
    end if;

    v_stock_after := v_stock_before - v_qty_to_deduct;

    -- 5d. Aplicar descuento.
    update public.variant_size_warehouse_stock
    set
      stock_qty  = v_stock_after,
      updated_at = now()
    where variant_id   = v_variant_id
      and size         = v_size_norm
      and warehouse_id = v_warehouse_id;

    -- 5e. Registrar auditoría en stock_history.
    v_notes_val := concat_ws(' | ',
      case when p_order_id      is not null then 'order_id:'      || p_order_id::text      end,
      case when v_order_item_id is not null then 'order_item_id:' || v_order_item_id::text end
    );

    insert into public.stock_history (
      product_id,
      variant_id,
      size,
      warehouse_id,
      change_type,
      stock_before,
      stock_after,
      quantity_changed,
      user_id,
      notes,
      source
    ) values (
      v_product_id,
      v_variant_id,
      v_size_norm,
      v_warehouse_id,
      'order_deduction',
      v_stock_before,
      v_stock_after,
      -v_qty_to_deduct,            -- negativo: es una salida de stock
      v_user_id,
      nullif(v_notes_val, ''),
      v_source
    );

    v_applied_items := v_applied_items + 1;

    v_details := v_details || jsonb_build_object(
      'variant_id',    v_variant_id,
      'size',          v_size_norm,
      'warehouse_id',  v_warehouse_id,
      'stock_before',  v_stock_before,
      'stock_after',   v_stock_after,
      'qty_deducted',  v_qty_to_deduct
    );
  end loop;

  return jsonb_build_object(
    'ok',            true,
    'total_input',   v_total_input,
    'applied_items', v_applied_items,
    'order_id',      p_order_id,
    'source',        v_source,
    'details',       v_details
  );
end $$;

-- Revocar acceso directo desde el cliente; solo se invoca autenticado
-- a través de la propia lógica de admin (el check interno ya valida admins).
revoke execute on function public.rpc_apply_order_stock_deduction(jsonb, uuid, text)
  from anon, authenticated;
grant  execute on function public.rpc_apply_order_stock_deduction(jsonb, uuid, text)
  to   authenticated;
