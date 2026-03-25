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

  -- Eliminar el ítem original
  delete from public.order_items where id = p_item_id;

  -- Insertar filas por estado (solo si la cantidad es > 0)
  if coalesce(p_n_picked, 0) > 0 then
    insert into public.order_items (
      order_id, variant_id, product_name, color, size, quantity, price_snapshot, imagen,
      status, checked_by, checked_at
    ) values (
      v_order_id, v_row.variant_id, v_row.product_name, v_row.color, v_row.size,
      p_n_picked, v_row.price_snapshot, v_row.imagen,
      'picked', p_checked_by, now()
    );
  end if;

  if coalesce(p_n_waiting, 0) > 0 then
    insert into public.order_items (
      order_id, variant_id, product_name, color, size, quantity, price_snapshot, imagen,
      status, checked_by, checked_at
    ) values (
      v_order_id, v_row.variant_id, v_row.product_name, v_row.color, v_row.size,
      p_n_waiting, v_row.price_snapshot, v_row.imagen,
      'waiting', p_checked_by, now()
    );
  end if;

  if coalesce(p_n_missing, 0) > 0 then
    insert into public.order_items (
      order_id, variant_id, product_name, color, size, quantity, price_snapshot, imagen,
      status, checked_by, checked_at
    ) values (
      v_order_id, v_row.variant_id, v_row.product_name, v_row.color, v_row.size,
      p_n_missing, v_row.price_snapshot, v_row.imagen,
      'missing', p_checked_by, now()
    );
  end if;

  select public.has_all_items_picked(v_order_id) into v_all_picked;

  return json_build_object(
    'order_id', v_order_id,
    'all_items_picked', v_all_picked
  );
end;
$$;

comment on function public.rpc_split_order_item_status(uuid, int, int, int, uuid) is
  'Divide un ítem de pedido en hasta 3 líneas: apartado (picked), espera (waiting), sin stock (missing). Usado en admin para pedidos del cliente con varias unidades del mismo producto.';
