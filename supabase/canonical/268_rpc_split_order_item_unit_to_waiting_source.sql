-- Migration 268: rpc_split_order_item_unit_to_waiting_source
--
-- Mueve p_qty unidades de un order_item (reserved o waiting) a una fila
-- nueva con status='waiting' y un depósito EXPLÍCITO (general = fábrica,
-- venta-publico = local), sin tocar el resto del ítem original (mismo
-- status, misma cantidad restante, mismas fuentes de stock menos las
-- unidades movidas).
--
-- Uso: admin/public-sales.html -> panel "Espera - pendientes en local"
-- (campana). Botón de reloj: cuando el local confirma que NO tiene la
-- unidad físicamente a mano (aunque el sistema la reservó de
-- venta-publico), la pasa a "espera de fábrica" en lugar de marcarla
-- "sin stock" -- el pedido sigue vivo esperando que fábrica la resuelva.
--
-- Restricción deliberada: si el ítem tiene stock trazado en MÁS de un
-- depósito a la vez, la función falla explícito en vez de adivinar de
-- cuál restar. Hoy esto no ocurre en el uso real (el panel solo lista
-- ítems 100% venta-público, ver fetchLocalReservations en public-sales.js)
-- y preferimos fallar ruidoso a mal-atribuir stock en silencio.

drop function if exists public.rpc_split_order_item_unit_to_waiting_source(uuid, int, text, uuid);

create or replace function public.rpc_split_order_item_unit_to_waiting_source(
  p_item_id uuid,
  p_qty int,
  p_source_code text,
  p_checked_by uuid
)
returns json
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_row public.order_items%rowtype;
  v_warehouse_id uuid;
  v_new_item_id uuid;
  v_source_count int;
  v_only_source_id uuid;
  v_only_source_qty int;
  v_source_total int;
  v_all_picked boolean;
begin
  if not exists (select 1 from public.admins where user_id = auth.uid()) then
    raise exception 'Solo administradores pueden usar esta función';
  end if;

  if p_source_code not in ('general', 'venta-publico') then
    raise exception 'Código de depósito inválido: %', p_source_code;
  end if;

  select id into v_warehouse_id from public.warehouses where code = p_source_code limit 1;
  if v_warehouse_id is null then
    raise exception 'Depósito no encontrado: %', p_source_code;
  end if;

  select * into v_row from public.order_items where id = p_item_id for update;
  if not found then
    raise exception 'Ítem no encontrado';
  end if;

  if p_qty is null or p_qty <= 0 then
    raise exception 'La cantidad a mover debe ser mayor a 0';
  end if;
  if p_qty > v_row.quantity then
    raise exception 'La cantidad (%) supera las unidades del ítem (%)', p_qty, v_row.quantity;
  end if;

  -- Caso simple: se mueve el ítem completo, no hace falta split.
  if p_qty = v_row.quantity then
    update public.order_items
       set status = 'waiting', checked_by = p_checked_by, checked_at = now()
     where id = p_item_id;

    delete from public.order_item_stock_sources where order_item_id = p_item_id;
    insert into public.order_item_stock_sources (order_item_id, warehouse_id, qty)
    values (p_item_id, v_warehouse_id, v_row.quantity);

    select public.has_all_items_picked(v_row.order_id) into v_all_picked;
    return json_build_object(
      'order_id', v_row.order_id,
      'all_items_picked', v_all_picked,
      'new_item_id', p_item_id,
      'split', false
    );
  end if;

  -- Split parcial: exigimos que TODO el stock trazado del ítem venga de un
  -- único depósito, para no tener que adivinar proporciones al restar.
  select count(distinct warehouse_id), coalesce(sum(greatest(qty, 0)), 0)
    into v_source_count, v_source_total
  from public.order_item_stock_sources
  where order_item_id = p_item_id;

  if v_source_count > 1 then
    raise exception 'El ítem tiene stock trazado en más de un depósito; no se puede mover automáticamente';
  end if;

  if v_source_total <> v_row.quantity then
    raise exception 'Inconsistencia en fuentes de stock del ítem %: quantity=%, sum(sources)=%',
      p_item_id, v_row.quantity, v_source_total;
  end if;

  select warehouse_id, qty into v_only_source_id, v_only_source_qty
  from public.order_item_stock_sources
  where order_item_id = p_item_id
  limit 1;

  insert into public.order_items (
    order_id, variant_id, product_name, color, size, quantity, price_snapshot, imagen,
    status, checked_by, checked_at
  ) values (
    v_row.order_id, v_row.variant_id, v_row.product_name, v_row.color, v_row.size,
    p_qty, v_row.price_snapshot, v_row.imagen,
    'waiting', p_checked_by, now()
  )
  returning id into v_new_item_id;

  insert into public.order_item_stock_sources (order_item_id, warehouse_id, qty)
  values (v_new_item_id, v_warehouse_id, p_qty);

  update public.order_items
     set quantity = v_row.quantity - p_qty
   where id = p_item_id;

  if v_only_source_id is not null then
    update public.order_item_stock_sources
       set qty = qty - p_qty
     where order_item_id = p_item_id and warehouse_id = v_only_source_id;

    delete from public.order_item_stock_sources
    where order_item_id = p_item_id and qty <= 0;
  end if;

  select public.has_all_items_picked(v_row.order_id) into v_all_picked;

  return json_build_object(
    'order_id', v_row.order_id,
    'all_items_picked', v_all_picked,
    'new_item_id', v_new_item_id,
    'split', true
  );
end;
$$;

comment on function public.rpc_split_order_item_unit_to_waiting_source(uuid, int, text, uuid) is
  'Admin: mueve p_qty unidades de un ítem (reserved/waiting) a una fila nueva "waiting" con depósito explícito (general=fábrica, venta-publico=local), sin tocar el resto del ítem original.';

revoke all on function public.rpc_split_order_item_unit_to_waiting_source(uuid, int, text, uuid) from public;
grant execute on function public.rpc_split_order_item_unit_to_waiting_source(uuid, int, text, uuid) to authenticated;
