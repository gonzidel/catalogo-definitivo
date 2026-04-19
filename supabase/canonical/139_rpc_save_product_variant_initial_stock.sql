-- Guardado atómico del stock inicial por talle en depósito **general** desde admin/productos.
-- Semántica de p_items (explícita):
--   Reemplazo completo del stock en almacén general para la variante: cualquier fila en
--   variant_size_warehouse_stock (variant_id + general) cuyo talle no aparezca en p_items
--   se elimina. Cada elemento de p_items fija la cantidad exacta en general para ese talle.
--   Justificación: alinea con el flujo previo en productos (quitar un talle del formulario
--   eliminaba su fila de catálogo y cohería con el total en general).
-- variant_sizes.stock_qty sigue siendo la suma por talle en todos los depósitos (trigger 84).

create or replace function public.rpc_save_product_variant_initial_stock(
  p_variant_id uuid,
  p_items jsonb
)
returns json
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_general_id uuid;
  v_product_id uuid;
  v_uid uuid;
  v_old_total int;
  v_new_total int;
  v_deleted int;
  v_any_detail_change boolean := false;
  elem jsonb;
  v_size text;
  v_qty int;
  v_sku text;
  v_prev int;
  v_sizes_json json;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'No autenticado';
  end if;
  if not exists (select 1 from public.admins where user_id = v_uid) then
    raise exception 'Solo administradores pueden guardar stock inicial desde productos';
  end if;

  select product_id into v_product_id
  from public.product_variants
  where id = p_variant_id;
  if v_product_id is null then
    raise exception 'Variante no encontrada';
  end if;

  select id into v_general_id
  from public.warehouses
  where code = 'general'
  limit 1;
  if v_general_id is null then
    raise exception 'Almacén general no encontrado';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'p_items debe ser un arreglo no vacío';
  end if;
  if jsonb_array_length(p_items) > 200 then
    raise exception 'Demasiados talles en una sola operación (máx 200)';
  end if;

  if exists (
    select 1
    from (
      select trim(both from coalesce(e->>'size', '')) as sz
      from jsonb_array_elements(p_items) as t(e)
      where nullif(trim(both from coalesce(e->>'size', '')), '') is not null
      group by 1
      having count(*) > 1
    ) d
  ) then
    raise exception 'Talles duplicados en p_items';
  end if;

  select coalesce(stock_qty, 0) into v_old_total
  from public.variant_warehouse_stock
  where variant_id = p_variant_id and warehouse_id = v_general_id;
  if not found then
    v_old_total := 0;
  end if;

  delete from public.variant_size_warehouse_stock
  where variant_id = p_variant_id
    and warehouse_id = v_general_id
    and size not in (
      select trim(both from coalesce(e->>'size', ''))
      from jsonb_array_elements(p_items) as t(e)
      where nullif(trim(both from coalesce(e->>'size', '')), '') is not null
    );
  get diagnostics v_deleted = row_count;
  if v_deleted > 0 then
    v_any_detail_change := true;
  end if;

  for elem in select * from jsonb_array_elements(p_items)
  loop
    v_size := trim(both from coalesce(elem->>'size', ''));
    if v_size = '' then
      raise exception 'Talle vacío no permitido';
    end if;
    if elem->'stock_qty' is null or jsonb_typeof(elem->'stock_qty') = 'null' then
      raise exception 'stock_qty faltante para talle %', v_size;
    end if;
    begin
      v_qty := (elem->>'stock_qty')::int;
    exception when others then
      raise exception 'stock_qty inválido para talle %', v_size;
    end;
    if v_qty < 0 then
      raise exception 'stock_qty inválido para talle %', v_size;
    end if;
    v_sku := nullif(trim(both from coalesce(elem->>'sku', '')), '');

    select coalesce(stock_qty, 0) into v_prev
    from public.variant_size_warehouse_stock
    where variant_id = p_variant_id
      and warehouse_id = v_general_id
      and size = v_size;
    if not found then
      v_prev := 0;
    end if;
    if v_prev is distinct from v_qty then
      v_any_detail_change := true;
    end if;

    insert into public.variant_size_warehouse_stock (variant_id, size, warehouse_id, stock_qty)
    values (p_variant_id, v_size, v_general_id, v_qty)
    on conflict (variant_id, size, warehouse_id)
    do update set stock_qty = excluded.stock_qty, updated_at = now();
  end loop;

  delete from public.variant_sizes
  where variant_id = p_variant_id
    and size not in (
      select trim(both from coalesce(e->>'size', ''))
      from jsonb_array_elements(p_items) as t(e)
      where nullif(trim(both from coalesce(e->>'size', '')), '') is not null
    );

  for elem in select * from jsonb_array_elements(p_items)
  loop
    v_size := trim(both from coalesce(elem->>'size', ''));
    v_sku := nullif(trim(both from coalesce(elem->>'sku', '')), '');
    update public.variant_sizes
    set
      sku = coalesce(v_sku, sku),
      updated_at = now()
    where variant_id = p_variant_id and size = v_size;
  end loop;

  -- variant_warehouse_stock se actualiza automáticamente via trigger 145
  select coalesce(sum(stock_qty), 0)::int into v_new_total
  from public.variant_size_warehouse_stock
  where variant_id = p_variant_id and warehouse_id = v_general_id;

  if v_old_total is distinct from v_new_total or v_any_detail_change then
    perform public.log_stock_change(
      v_product_id,
      p_variant_id,
      null,
      v_general_id,
      'adjustment',
      v_old_total,
      v_new_total,
      null,
      null,
      'admin/products: rpc_save_product_variant_initial_stock (depósito general)'
    );
  end if;

  select coalesce(
    json_agg(
      json_build_object(
        'id', vs.id,
        'variant_id', vs.variant_id,
        'size', vs.size,
        'stock_qty', vs.stock_qty,
        'sku', vs.sku,
        'qr_code', vs.qr_code
      )
      order by vs.created_at, vs.size
    ),
    '[]'::json
  )
  into v_sizes_json
  from public.variant_sizes vs
  where vs.variant_id = p_variant_id;

  return json_build_object(
    'ok', true,
    'warehouse_id', v_general_id,
    'total_qty', v_new_total,
    'variant_sizes', coalesce(v_sizes_json, '[]'::json)
  );
end;
$$;

comment on function public.rpc_save_product_variant_initial_stock(uuid, jsonb) is
  'Admin: reemplazo atómico del stock por talle en depósito general + agregado variant_warehouse_stock + log_stock_change + variant_sizes (trigger + sku).';

grant execute on function public.rpc_save_product_variant_initial_stock(uuid, jsonb) to authenticated;

select pg_notify('pgrst', 'reload schema');
