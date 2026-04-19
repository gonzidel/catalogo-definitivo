-- 164_rpc_set_variant_size_stock_batch.sql
--
-- Etapa 2 del endurecimiento del flujo de stock.
-- Primera RPC: reemplaza la escritura directa absoluta sobre
-- public.variant_size_warehouse_stock (valor absoluto, por talle)
-- hecha hoy desde el cliente en:
--   - admin/stock.js (saveStockRow single y saveAllChanges batch, rama "con talle")
--   - admin/fyl-products.js (bulk con size + single con size)
--   - admin/incomplete-products.js (save batch con talles)
--   - admin/import-export.js (update con size), invocada con p_source='import'
--
-- Esta RPC NO se invoca todavía desde el frontend. Solo queda disponible.
-- No borra ni modifica las otras RPC de stock.
--
-- Características:
-- - Transaccional (una plpgsql = una transacción). Si un ítem falla, nada se aplica.
-- - Valida stock_qty >= 0, variant_id existente, warehouse_id existente, size no vacío.
-- - Verifica que la variante admita stock por talle (debe tener filas en variant_sizes
--   o, al menos, no estar marcada como variante sin talle). Esto previene que un caller
--   mande un size para una variante que opera sin talles.
-- - Procesa los ítems en orden determinístico (variant_id, size, warehouse_id) para
--   minimizar deadlocks cuando dos operaciones concurrentes tocan los mismos SKUs.
-- - SELECT ... FOR UPDATE sobre la fila existente antes de decidir INSERT vs UPDATE.
-- - Registra en public.stock_history SOLO si el valor cambió (stock_before != stock_after).
-- - Incluye source ('manual_edit', 'bulk_edit', 'import', 'complete_incomplete', etc.)
--   en una columna nueva stock_history.source (aditiva, IF NOT EXISTS).
--
-- Nota sobre stock_movements:
-- En este repositorio stock_movements está reservada a transferencias entre depósitos
-- (check qty > 0 + from_warehouse_id + to_warehouse_id). Los cambios absolutos
-- (cargas/ajustes) se auditan en stock_history vía log_stock_change. Esta RPC mantiene
-- esa convención canónica.

-- 1) Columna aditiva para identificar el origen del cambio en el historial.
do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'stock_history'
      and column_name = 'source'
  ) then
    alter table public.stock_history
      add column source text;
  end if;
end $$;

create index if not exists idx_stock_history_source
  on public.stock_history(source)
  where source is not null;

-- 2) RPC principal.
create or replace function public.rpc_set_variant_size_stock_batch(
  p_items  jsonb,
  p_source text default 'manual_edit'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_user_id uuid;
  v_is_admin boolean;

  v_source text;
  v_allowed_sources constant text[] := array[
    'manual_edit',
    'bulk_edit',
    'import',
    'complete_incomplete',
    'initial_load'
  ];

  v_total_items   int := 0;
  v_changed_items int := 0;
  v_skipped       int := 0;

  v_details jsonb := '[]'::jsonb;

  -- Cursor ordenado determinísticamente sobre el jsonb de entrada.
  -- ordinality preserva la posición original para reportes de error.
  v_rec record;

  v_variant_id   uuid;
  v_warehouse_id uuid;
  v_product_id   uuid;
  v_size_raw     text;
  v_size_norm    text;
  v_stock_new    int;
  v_stock_before int;

  v_variant_exists   boolean;
  v_warehouse_exists boolean;
  v_variant_has_sizes boolean;

  v_change_type text;
begin
  -- 2.1) Autenticación + autorización: solo admins.
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'rpc_set_variant_size_stock_batch: usuario no autenticado';
  end if;

  select exists (
    select 1 from public.admins where user_id = v_user_id
  ) into v_is_admin;

  if not v_is_admin then
    raise exception 'rpc_set_variant_size_stock_batch: forbidden (solo admins)';
  end if;

  -- 2.2) Validar payload raíz.
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'rpc_set_variant_size_stock_batch: p_items debe ser un array jsonb';
  end if;

  if jsonb_array_length(p_items) = 0 then
    return jsonb_build_object(
      'ok', true,
      'applied_items', 0,
      'changed_items', 0,
      'skipped_unchanged', 0,
      'details', '[]'::jsonb,
      'source', p_source
    );
  end if;

  -- 2.3) Normalizar/validar source.
  v_source := coalesce(nullif(trim(p_source), ''), 'manual_edit');
  if not (v_source = any (v_allowed_sources)) then
    raise exception
      'rpc_set_variant_size_stock_batch: source inválido "%". Permitidos: %',
      v_source, array_to_string(v_allowed_sources, ', ');
  end if;

  -- 2.4) Procesar ítems en orden determinístico.
  for v_rec in
    select
      (item->>'variant_id')::uuid   as variant_id,
      nullif(item->>'product_id','')::uuid as product_id,
      item->>'size'                 as size_raw,
      (item->>'warehouse_id')::uuid as warehouse_id,
      (item->>'stock_qty')::int     as stock_qty,
      ord                           as original_index
    from jsonb_array_elements(p_items) with ordinality as t(item, ord)
    order by
      (item->>'variant_id')::uuid,
      item->>'size',
      (item->>'warehouse_id')::uuid
  loop
    v_total_items := v_total_items + 1;

    v_variant_id   := v_rec.variant_id;
    v_warehouse_id := v_rec.warehouse_id;
    v_product_id   := v_rec.product_id;
    v_size_raw     := v_rec.size_raw;
    v_stock_new    := v_rec.stock_qty;

    -- 2.4.1) Validaciones por ítem.
    if v_variant_id is null then
      raise exception
        'rpc_set_variant_size_stock_batch: item #% sin variant_id',
        v_rec.original_index;
    end if;

    if v_warehouse_id is null then
      raise exception
        'rpc_set_variant_size_stock_batch: item #% (variant_id=%) sin warehouse_id',
        v_rec.original_index, v_variant_id;
    end if;

    if v_stock_new is null then
      raise exception
        'rpc_set_variant_size_stock_batch: item #% (variant_id=%, warehouse_id=%) sin stock_qty',
        v_rec.original_index, v_variant_id, v_warehouse_id;
    end if;

    if v_stock_new < 0 then
      raise exception
        'rpc_set_variant_size_stock_batch: stock_qty negativo (%) en item #% (variant_id=%, warehouse_id=%)',
        v_stock_new, v_rec.original_index, v_variant_id, v_warehouse_id;
    end if;

    -- Normalizar size como lo hace rpc_move_size_stock para consistencia.
    v_size_norm := trim(both ' ' from coalesce(v_size_raw, ''));
    if v_size_norm ~ '^\d+(\.\d+)?$' then
      v_size_norm := split_part(v_size_norm, '.', 1);
    end if;

    if v_size_norm is null or v_size_norm = '' then
      raise exception
        'rpc_set_variant_size_stock_batch: size vacío en item #% (variant_id=%, warehouse_id=%). Para variantes sin talle usar rpc_set_variant_warehouse_stock_batch.',
        v_rec.original_index, v_variant_id, v_warehouse_id;
    end if;

    -- Existencia de variante.
    select exists (
      select 1 from public.product_variants where id = v_variant_id
    ) into v_variant_exists;

    if not v_variant_exists then
      raise exception
        'rpc_set_variant_size_stock_batch: variant_id % inexistente (item #%)',
        v_variant_id, v_rec.original_index;
    end if;

    -- Existencia de warehouse.
    select exists (
      select 1 from public.warehouses where id = v_warehouse_id
    ) into v_warehouse_exists;

    if not v_warehouse_exists then
      raise exception
        'rpc_set_variant_size_stock_batch: warehouse_id % inexistente (item #%)',
        v_warehouse_id, v_rec.original_index;
    end if;

    -- Consistencia: la variante debe admitir talles (tener al menos una fila
    -- en variant_sizes). Si no, es una variante sin talle y debe usar la RPC
    -- específica sin talle. Esto previene corrupción por uso equivocado.
    select exists (
      select 1 from public.variant_sizes vs where vs.variant_id = v_variant_id
    ) into v_variant_has_sizes;

    if not v_variant_has_sizes then
      raise exception
        'rpc_set_variant_size_stock_batch: variant_id % no tiene filas en variant_sizes; usar rpc_set_variant_warehouse_stock_batch (item #%).',
        v_variant_id, v_rec.original_index;
    end if;

    -- 2.4.2) Capturar stock_before con lock pesimista.
    -- Si la fila no existe, no hay nada que lockear; la inserción posterior
    -- se serializa por el unique(variant_id, size, warehouse_id) + ON CONFLICT.
    select stock_qty
      into v_stock_before
      from public.variant_size_warehouse_stock
      where variant_id   = v_variant_id
        and size         = v_size_norm
        and warehouse_id = v_warehouse_id
      for update;

    if not found then
      v_stock_before := 0;

      insert into public.variant_size_warehouse_stock
        (variant_id, size, warehouse_id, stock_qty)
      values
        (v_variant_id, v_size_norm, v_warehouse_id, v_stock_new)
      on conflict (variant_id, size, warehouse_id) do update
        set stock_qty  = excluded.stock_qty,
            updated_at = now();
    else
      if v_stock_before <> v_stock_new then
        update public.variant_size_warehouse_stock
          set stock_qty  = v_stock_new,
              updated_at = now()
          where variant_id   = v_variant_id
            and size         = v_size_norm
            and warehouse_id = v_warehouse_id;
      end if;
    end if;

    -- 2.4.3) Log en stock_history solo si hubo cambio real.
    if v_stock_before <> v_stock_new then
      v_change_type := case
        when v_stock_new > v_stock_before then 'load'
        else 'adjustment'
      end;

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
        v_change_type,
        v_stock_before,
        v_stock_new,
        v_stock_new - v_stock_before,
        v_user_id,
        null,
        v_source
      );

      v_changed_items := v_changed_items + 1;

      v_details := v_details || jsonb_build_object(
        'variant_id',   v_variant_id,
        'size',         v_size_norm,
        'warehouse_id', v_warehouse_id,
        'before',       v_stock_before,
        'after',        v_stock_new,
        'change_type',  v_change_type
      );
    else
      v_skipped := v_skipped + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'applied_items',     v_total_items,
    'changed_items',     v_changed_items,
    'skipped_unchanged', v_skipped,
    'details',           v_details,
    'source',            v_source
  );
end
$$;

comment on function public.rpc_set_variant_size_stock_batch(jsonb, text) is
'Setea stock absoluto por (variant_id, size, warehouse_id) en variant_size_warehouse_stock '
'con lock FOR UPDATE, validación de stock >= 0, existencia de variante/warehouse y '
'consistencia con variant_sizes. Logea en stock_history con el source provisto solo si '
'el valor cambia. Etapa 2 del endurecimiento de stock. No se usa todavía desde frontend.';

revoke all on function public.rpc_set_variant_size_stock_batch(jsonb, text) from public;
grant execute on function public.rpc_set_variant_size_stock_batch(jsonb, text) to authenticated;

select pg_notify('pgrst','reload schema');
