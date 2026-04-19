-- 162_stock_movements_add_size.sql
-- Agrega columna estructurada "size" a stock_movements y
-- actualiza rpc_move_size_stock para persistir el talle.

do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'stock_movements'
      and column_name = 'size'
  ) then
    alter table public.stock_movements
    add column size text;
  end if;
end $$;

create index if not exists ix_stock_movements_variant_size
  on public.stock_movements(variant_id, size);

create or replace function public.rpc_move_size_stock(
  p_variant_id uuid,
  p_size text,
  p_from_warehouse_code text,
  p_to_warehouse_code text,
  p_quantity int,
  p_notes text default null
)
returns json
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_from_warehouse_id uuid;
  v_to_warehouse_id uuid;
  v_available_stock int;
  v_user_id uuid;
  v_movement_id uuid;
  v_result json;
  v_normalized_size text;
begin
  if p_quantity <= 0 then
    raise exception 'La cantidad debe ser mayor a 0';
  end if;

  v_normalized_size := trim(both ' ' from p_size);
  if v_normalized_size ~ '^\d+(\.\d+)?$' then
    v_normalized_size := split_part(v_normalized_size, '.', 1);
  end if;

  if v_normalized_size is null or v_normalized_size = '' then
    raise exception 'El tamaño no puede estar vacío';
  end if;

  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  select id into v_from_warehouse_id
  from public.warehouses
  where code = p_from_warehouse_code;

  if v_from_warehouse_id is null then
    raise exception 'Almacén origen no encontrado: %', p_from_warehouse_code;
  end if;

  select id into v_to_warehouse_id
  from public.warehouses
  where code = p_to_warehouse_code;

  if v_to_warehouse_id is null then
    raise exception 'Almacén destino no encontrado: %', p_to_warehouse_code;
  end if;

  if v_from_warehouse_id = v_to_warehouse_id then
    raise exception 'El almacén origen y destino no pueden ser el mismo';
  end if;

  select coalesce(stock_qty, 0) into v_available_stock
  from public.variant_size_warehouse_stock
  where variant_id = p_variant_id
    and size = v_normalized_size
    and warehouse_id = v_from_warehouse_id;

  if v_available_stock < p_quantity then
    raise exception
      'Stock insuficiente en almacén origen para talle %. Disponible: %, Solicitado: %',
      v_normalized_size, v_available_stock, p_quantity;
  end if;

  perform 1
  from public.variant_size_warehouse_stock
  where variant_id = p_variant_id
    and size = v_normalized_size
    and warehouse_id in (v_from_warehouse_id, v_to_warehouse_id)
  for update;

  update public.variant_size_warehouse_stock
  set stock_qty = stock_qty - p_quantity,
      updated_at = now()
  where variant_id = p_variant_id
    and size = v_normalized_size
    and warehouse_id = v_from_warehouse_id;

  insert into public.variant_size_warehouse_stock (variant_id, size, warehouse_id, stock_qty)
  select p_variant_id, v_normalized_size, v_from_warehouse_id, 0
  where not exists (
    select 1
    from public.variant_size_warehouse_stock
    where variant_id = p_variant_id
      and size = v_normalized_size
      and warehouse_id = v_from_warehouse_id
  );

  insert into public.variant_size_warehouse_stock (variant_id, size, warehouse_id, stock_qty)
  values (p_variant_id, v_normalized_size, v_to_warehouse_id, p_quantity)
  on conflict (variant_id, size, warehouse_id)
  do update set
    stock_qty = variant_size_warehouse_stock.stock_qty + p_quantity,
    updated_at = now();

  insert into public.stock_movements (
    variant_id,
    size,
    from_warehouse_id,
    to_warehouse_id,
    qty,
    moved_by,
    notes
  )
  values (
    p_variant_id,
    v_normalized_size,
    v_from_warehouse_id,
    v_to_warehouse_id,
    p_quantity,
    v_user_id,
    p_notes
  )
  returning id into v_movement_id;

  select json_build_object(
    'success', true,
    'movement_id', v_movement_id,
    'from_warehouse', p_from_warehouse_code,
    'to_warehouse', p_to_warehouse_code,
    'size', v_normalized_size,
    'quantity', p_quantity,
    'from_stock_after', v_available_stock - p_quantity,
    'to_stock_after', (
      select coalesce(stock_qty, 0)
      from public.variant_size_warehouse_stock
      where variant_id = p_variant_id
        and size = v_normalized_size
        and warehouse_id = v_to_warehouse_id
    )
  ) into v_result;

  return v_result;
end $$;

comment on function public.rpc_move_size_stock(uuid, text, text, text, int, text) is
'Mueve stock por talle entre depósitos y registra el talle en stock_movements.size.';

select pg_notify('pgrst','reload schema');
