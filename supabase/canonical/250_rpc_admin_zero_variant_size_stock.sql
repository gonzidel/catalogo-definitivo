-- 250_rpc_admin_zero_variant_size_stock.sql
--
-- Feature: cuando un admin (Kanban nj) o el local (admin/public-sales.html, modal
-- "Espera") presiona "✕ Sin stock" sobre un ítem de pedido, y el sistema todavía
-- muestra existencias > 0 para esa variante+talle (lo que figura en la web / catálogo
-- público, fuente: variant_sizes.stock_qty), se le pregunta al admin si esas
-- existencias fantasma deben llevarse a 0 — porque ya confirmó en el terreno que no
-- hay stock real de ese producto/talle.
--
-- Esta RPC hace exactamente eso: pone en 0 todas las filas de
-- variant_size_warehouse_stock para esa variante+talle (todos los depósitos), deja
-- auditoría en stock_history, y deja que el trigger existente
-- (trigger_sync_variant_sizes_on_warehouse_stock, migración 84) sincronice
-- variant_sizes.stock_qty a 0 automáticamente.
--
-- No toca product_variants.reserved_qty: las unidades que se llevan a 0 eran stock
-- "libre" (no reservado por ningún pedido) según el propio sistema; si estuvieran
-- reservadas, ya se habrían restado de variant_size_warehouse_stock en el momento de
-- la reserva. No corresponde tocar reservas de otros pedidos.
--
-- Firma:
--   rpc_admin_zero_variant_size_stock(
--     p_variant_id    uuid,
--     p_size          text,
--     p_order_item_id uuid default null  -- solo para trazabilidad en stock_history
--   ) returns json

create or replace function public.rpc_admin_zero_variant_size_stock(
  p_variant_id    uuid,
  p_size          text,
  p_order_item_id uuid default null
)
returns json
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_uid          uuid;
  v_size_norm    text;
  v_product_id   uuid;
  v_row          record;
  v_total_before int := 0;
  v_zeroed_rows  int := 0;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'rpc_admin_zero_variant_size_stock: no autenticado';
  end if;
  if not exists (select 1 from public.admins where user_id = v_uid) then
    raise exception 'rpc_admin_zero_variant_size_stock: solo administradores';
  end if;

  if p_variant_id is null then
    raise exception 'rpc_admin_zero_variant_size_stock: variant_id requerido';
  end if;

  v_size_norm := trim(coalesce(p_size, ''));
  if v_size_norm = '' then
    raise exception 'rpc_admin_zero_variant_size_stock: size requerido';
  end if;
  if v_size_norm ~ '^\d+(\.\d+)?$' then
    v_size_norm := split_part(v_size_norm, '.', 1);
  end if;

  select product_id into v_product_id
  from public.product_variants
  where id = p_variant_id;

  if not found then
    raise exception 'rpc_admin_zero_variant_size_stock: variante % no encontrada', p_variant_id;
  end if;

  for v_row in
    select vsws.id, vsws.warehouse_id, vsws.stock_qty
    from public.variant_size_warehouse_stock vsws
    where vsws.variant_id = p_variant_id
      and trim(coalesce(vsws.size::text, '')) = v_size_norm
    order by vsws.warehouse_id
    for update
  loop
    if coalesce(v_row.stock_qty, 0) <= 0 then
      continue;
    end if;

    v_total_before := v_total_before + v_row.stock_qty;

    update public.variant_size_warehouse_stock
    set stock_qty = 0, updated_at = now()
    where id = v_row.id;

    perform public.log_stock_change(
      v_product_id,
      p_variant_id,
      v_size_norm,
      v_row.warehouse_id,
      'adjustment',
      v_row.stock_qty,
      0,
      null,
      null,
      concat_ws(' | ',
        'Ajuste manual admin: sin stock real confirmado (botón ✕)',
        case when p_order_item_id is not null then 'order_item_id:' || p_order_item_id::text end
      )
    );

    v_zeroed_rows := v_zeroed_rows + 1;
  end loop;

  return json_build_object(
    'ok', true,
    'variant_id', p_variant_id,
    'size', v_size_norm,
    'zeroed_rows', v_zeroed_rows,
    'total_before', v_total_before
  );
end;
$$;

comment on function public.rpc_admin_zero_variant_size_stock(uuid, text, uuid) is
  'Admin: lleva a 0 el stock (todas las filas de variant_size_warehouse_stock) de una variante+talle cuando el admin confirma en terreno que no hay existencia real, pese a que el sistema mostraba > 0. No toca reserved_qty (el stock puesto en 0 era libre, no reservado). variant_sizes se sincroniza vía trigger 84.';

grant execute on function public.rpc_admin_zero_variant_size_stock(uuid, text, uuid) to authenticated;

select pg_notify('pgrst', 'reload schema');
