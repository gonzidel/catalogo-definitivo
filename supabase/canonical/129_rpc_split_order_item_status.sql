-- Migration 129: rpc_split_order_item_status
-- Permite al admin dividir un ítem de pedido (varias unidades) en: apartado, espera y sin stock.
-- Solo para pedidos creados por el cliente (dashboard). Uso: admin/orders.html flujo "¿Cuántas disponibles?".

DROP FUNCTION IF EXISTS public.rpc_split_order_item_status(uuid, int, int, int, uuid);

create or replace function public.rpc_split_order_item_status(
  p_item_id uuid,
  p_n_picked int,
  p_n_waiting int,
  p_n_missing int,
  p_checked_by uuid
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.order_items%rowtype;
  v_order_id uuid;
  v_all_picked boolean;
  v_new_picked_id uuid;
  v_new_waiting_id uuid;
  v_new_missing_id uuid;
  v_has_sources boolean := false;
  v_source_total int := 0;
  v_total_remaining int := 0;
  v_last_seq int := 0;
  v_missing_alloc int := 0;
  v_target record;
  v_alloc_total int := 0;
begin
  if not exists (select 1 from public.admins where user_id = auth.uid()) then
    raise exception 'Solo administradores pueden usar esta función';
  end if;

  select * into v_row from public.order_items where id = p_item_id;
  if not found then
    raise exception 'Ítem no encontrado';
  end if;

  if p_n_picked < 0 or p_n_waiting < 0 or p_n_missing < 0 then
    raise exception 'Las cantidades no pueden ser negativas';
  end if;

  if (coalesce(p_n_picked, 0) + coalesce(p_n_waiting, 0) + coalesce(p_n_missing, 0)) <> v_row.quantity then
    raise exception 'La suma de cantidades (apartado + espera + sin stock) debe ser igual a la cantidad del ítem (%); recibido: picked=%, waiting=%, missing=%',
      v_row.quantity, p_n_picked, p_n_waiting, p_n_missing;
  end if;

  v_order_id := v_row.order_id;

  -- Insertar filas por estado (solo si la cantidad es > 0)
  if coalesce(p_n_picked, 0) > 0 then
    insert into public.order_items (
      order_id, variant_id, product_name, color, size, quantity, price_snapshot, imagen,
      status, checked_by, checked_at
    ) values (
      v_order_id, v_row.variant_id, v_row.product_name, v_row.color, v_row.size,
      p_n_picked, v_row.price_snapshot, v_row.imagen,
      'picked', p_checked_by, now()
    )
    returning id into v_new_picked_id;
  end if;

  if coalesce(p_n_waiting, 0) > 0 then
    insert into public.order_items (
      order_id, variant_id, product_name, color, size, quantity, price_snapshot, imagen,
      status, checked_by, checked_at
    ) values (
      v_order_id, v_row.variant_id, v_row.product_name, v_row.color, v_row.size,
      p_n_waiting, v_row.price_snapshot, v_row.imagen,
      'waiting', p_checked_by, now()
    )
    returning id into v_new_waiting_id;
  end if;

  if coalesce(p_n_missing, 0) > 0 then
    insert into public.order_items (
      order_id, variant_id, product_name, color, size, quantity, price_snapshot, imagen,
      status, checked_by, checked_at
    ) values (
      v_order_id, v_row.variant_id, v_row.product_name, v_row.color, v_row.size,
      p_n_missing, v_row.price_snapshot, v_row.imagen,
      'missing', p_checked_by, now()
    )
    returning id into v_new_missing_id;
  end if;

  -- Redistribuir trazas de stock de forma proporcional y determinista.
  -- Nunca inferir depósito por status dentro del split.
  select exists (
    select 1
    from public.order_item_stock_sources s
    where s.order_item_id = p_item_id
      and greatest(coalesce(s.qty, 0), 0) > 0
  ) into v_has_sources;

  if v_has_sources then
    create temporary table if not exists tmp_split_sources (
      warehouse_id uuid primary key,
      remaining_qty int not null
    ) on commit drop;

    create temporary table if not exists tmp_split_targets (
      seq int primary key,
      item_id uuid not null,
      qty int not null
    ) on commit drop;

    create temporary table if not exists tmp_split_alloc (
      warehouse_id uuid primary key,
      alloc_qty int not null default 0,
      remainder numeric not null default 0
    ) on commit drop;

    truncate table tmp_split_sources;
    truncate table tmp_split_targets;
    truncate table tmp_split_alloc;

    insert into tmp_split_sources (warehouse_id, remaining_qty)
    select
      s.warehouse_id,
      sum(greatest(coalesce(s.qty, 0), 0))::int as remaining_qty
    from public.order_item_stock_sources s
    where s.order_item_id = p_item_id
    group by s.warehouse_id;

    select coalesce(sum(remaining_qty), 0)::int
    into v_source_total
    from tmp_split_sources;

    if v_source_total <> v_row.quantity then
      raise exception
        'Inconsistencia en fuentes de stock del ítem %: quantity=%, sum(sources)=%',
        p_item_id, v_row.quantity, v_source_total;
    end if;

    if v_new_picked_id is not null then
      insert into tmp_split_targets (seq, item_id, qty)
      values (1, v_new_picked_id, p_n_picked);
    end if;
    if v_new_waiting_id is not null then
      insert into tmp_split_targets (seq, item_id, qty)
      values (2, v_new_waiting_id, p_n_waiting);
    end if;
    if v_new_missing_id is not null then
      insert into tmp_split_targets (seq, item_id, qty)
      values (3, v_new_missing_id, p_n_missing);
    end if;

    select coalesce(max(seq), 0) into v_last_seq from tmp_split_targets;
    v_total_remaining := v_row.quantity;

    for v_target in
      select seq, item_id, qty
      from tmp_split_targets
      order by seq
    loop
      if coalesce(v_target.qty, 0) <= 0 then
        continue;
      end if;

      if v_target.seq = v_last_seq then
        insert into public.order_item_stock_sources (order_item_id, warehouse_id, qty)
        select v_target.item_id, s.warehouse_id, s.remaining_qty
        from tmp_split_sources s
        where s.remaining_qty > 0;

        update tmp_split_sources
        set remaining_qty = 0
        where remaining_qty > 0;

        v_total_remaining := 0;
        continue;
      end if;

      if v_total_remaining <= 0 then
        raise exception 'No hay cantidad remanente para redistribuir fuentes en split de %', p_item_id;
      end if;

      truncate table tmp_split_alloc;

      insert into tmp_split_alloc (warehouse_id, alloc_qty, remainder)
      select
        s.warehouse_id,
        floor((s.remaining_qty::numeric * v_target.qty::numeric) / v_total_remaining::numeric)::int as alloc_qty,
        ((s.remaining_qty::numeric * v_target.qty::numeric) / v_total_remaining::numeric)
          - floor((s.remaining_qty::numeric * v_target.qty::numeric) / v_total_remaining::numeric) as remainder
      from tmp_split_sources s
      where s.remaining_qty > 0;

      select v_target.qty - coalesce(sum(a.alloc_qty), 0)::int
      into v_missing_alloc
      from tmp_split_alloc a;

      if v_missing_alloc > 0 then
        update tmp_split_alloc a
        set alloc_qty = alloc_qty + 1
        from (
          select a2.warehouse_id
          from tmp_split_alloc a2
          join tmp_split_sources s2 on s2.warehouse_id = a2.warehouse_id
          where (s2.remaining_qty - a2.alloc_qty) > 0
          order by a2.remainder desc, a2.warehouse_id
          limit v_missing_alloc
        ) inc
        where a.warehouse_id = inc.warehouse_id;
      end if;

      select coalesce(sum(a.alloc_qty), 0)::int
      into v_alloc_total
      from tmp_split_alloc a;

      if v_alloc_total <> v_target.qty then
        raise exception
          'No se pudo asignar exactamente fuentes para split de % (target=%, alloc=%)',
          p_item_id, v_target.qty, v_alloc_total;
      end if;

      insert into public.order_item_stock_sources (order_item_id, warehouse_id, qty)
      select v_target.item_id, a.warehouse_id, a.alloc_qty
      from tmp_split_alloc a
      where a.alloc_qty > 0;

      update tmp_split_sources s
      set remaining_qty = s.remaining_qty - a.alloc_qty
      from tmp_split_alloc a
      where s.warehouse_id = a.warehouse_id;

      if exists (
        select 1
        from tmp_split_sources s
        where s.remaining_qty < 0
      ) then
        raise exception 'Redistribución inválida: fuentes negativas en split de %', p_item_id;
      end if;

      v_total_remaining := v_total_remaining - v_target.qty;
    end loop;
  end if;

  -- Eliminar el ítem original al final (cascada elimina sus sources previas).
  delete from public.order_items where id = p_item_id;

  select public.has_all_items_picked(v_order_id) into v_all_picked;

  return json_build_object(
    'order_id', v_order_id,
    'all_items_picked', v_all_picked,
    'split_item_ids', json_build_object(
      'picked', v_new_picked_id,
      'waiting', v_new_waiting_id,
      'missing', v_new_missing_id
    ),
    'had_sources', v_has_sources
  );
end;
$$;

comment on function public.rpc_split_order_item_status(uuid, int, int, int, uuid) is
  'Divide un ítem de pedido en hasta 3 líneas: apartado (picked), espera (waiting), sin stock (missing). Usado en admin para pedidos del cliente con varias unidades del mismo producto.';
