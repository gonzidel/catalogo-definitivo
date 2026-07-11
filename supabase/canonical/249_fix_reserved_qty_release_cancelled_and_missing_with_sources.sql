-- 249_fix_reserved_qty_release_cancelled_and_missing_with_sources.sql
--
-- Fix: rpc_remove_order_item_restore_stock (246) liberaba product_variants.reserved_qty
-- solo cuando v_status IN ('picked','reserved','waiting'), pero la restauración de stock
-- físico (bloque order_item_stock_sources, líneas ~104-178 de 246) se ejecuta para
-- CUALQUIER status con fuentes, incluyendo 'cancelled' y 'missing'. Esto deja reserved_qty
-- sin liberar en dos escenarios reales:
--
--   1. Flujo "cancelado por cliente + confirmado por admin" (Kanban nj, botón ✓):
--      rpc_cancel_order_item (126) pasa un ítem 'picked' a status='cancelled' SIN tocar
--      reserved_qty ni borrar sus order_item_stock_sources (eso solo pasa para
--      reserved/waiting). Cuando el admin confirma con "✓" (confirmCancelledItem →
--      rpc_remove_order_item_restore_stock), el stock físico SÍ se restaura por fuentes,
--      pero reserved_qty no se libera porque el status ya es 'cancelled', no 'picked'.
--
--   2. Ítems 'missing' con order_item_stock_sources reales:
--      - Derivados de rpc_split_order_item_status (129): heredan una porción real de
--        las fuentes del ítem original (que sí incrementó reserved_qty al reservarse).
--      - Derivados de rpc_admin_manual_inject_and_deduct (179, admin_confirmed_missing):
--        incrementan reserved_qty explícitamente (paso 4e) e insertan una fuente real.
--      En ambos casos, al quitar el ítem se restaura el stock físico por fuentes, pero
--      'missing' está excluido de la liberación de reserved_qty.
--
-- Evidencia (producción, previo a este fix):
--   SELECT anomaly_type, count(*), sum(abs(delta))
--   FROM vw_stock_audit_reserved_qty_diff GROUP BY anomaly_type;
--   → reserved_qty_inflated: 534 variantes, 2039 unidades de diferencia acumulada.
--   → reserved_qty_deflated: 2 variantes, 5 unidades.
--
-- Cambio: la liberación de reserved_qty pasa a depender de si la función efectivamente
-- restauró stock (v_has_sources, o fallback sin fuentes para picked/reserved/waiting),
-- en vez de depender únicamente del status final del ítem. Esto es exactamente la misma
-- condición que ya gobierna la restauración de stock físico en esta misma función.
--
-- Reversión: recrear la función con la condición anterior
-- (v_status in ('picked', 'reserved', 'waiting')) — ver 246.
--
-- Nota: el drift histórico ya acumulado (534/2039) NO se corrige con este script;
-- requiere una corrida aparte de rpc_reconcile_stock(true), a ejecutar con aprobación
-- explícita separada.

create or replace function public.rpc_remove_order_item_restore_stock(p_order_item_id uuid)
returns json
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_uid uuid;
  v_item public.order_items%rowtype;
  v_order_id uuid;
  v_st text;
  v_size_norm text;
  v_qty int;
  v_price numeric;
  v_line_total numeric;
  v_general_id uuid;
  v_product_id uuid;
  v_status text;
  v_src record;
  v_row record;
  v_before int;
  v_after int;
  v_found boolean;
  v_has_sources boolean;
  v_order_deleted boolean := false;
  v_match_id uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'No autenticado';
  end if;
  if not exists (select 1 from public.admins where user_id = v_uid) then
    raise exception 'Solo administradores pueden quitar ítems con esta función';
  end if;

  select * into v_item from public.order_items where id = p_order_item_id for update;
  if not found then
    raise exception 'Ítem no encontrado';
  end if;

  v_order_id := v_item.order_id;
  if not exists (select 1 from public.orders where id = v_order_id) then
    raise exception 'Pedido no encontrado';
  end if;

  v_qty := greatest(coalesce(v_item.quantity, 0), 0);
  v_price := coalesce(v_item.price_snapshot, 0);
  v_line_total := coalesce(v_qty * v_price, 0);

  v_status := lower(trim(coalesce(v_item.status, '')));

  v_size_norm := trim(coalesce(v_item.size::text, ''));
  if v_size_norm = '' then
    v_size_norm := null;
  elsif v_size_norm ~ '^\d+(\.\d+)?$' then
    v_size_norm := split_part(v_size_norm, '.', 1);
  end if;

  select id into v_general_id from public.warehouses where code = 'general' limit 1;

  if v_item.variant_id is not null then
    select pv.product_id into v_product_id from public.product_variants pv where pv.id = v_item.variant_id;
    perform 1
    from public.product_variants pv
    where pv.id = v_item.variant_id
    for update;
  end if;

  select exists (
    select 1 from public.order_item_stock_sources s where s.order_item_id = p_order_item_id
  ) into v_has_sources;

  -- ---------- Stock: por order_item_stock_sources ----------
  if v_item.variant_id is not null and v_size_norm is not null and v_has_sources then
    for v_src in
      select s.warehouse_id, s.qty
      from public.order_item_stock_sources s
      where s.order_item_id = p_order_item_id
    loop
      if coalesce(v_src.qty, 0) <= 0 then
        continue;
      end if;

      v_before := 0;
      v_found := false;
      for v_row in
        select vsws.id, vsws.size, vsws.stock_qty
        from public.variant_size_warehouse_stock vsws
        where vsws.variant_id = v_item.variant_id
          and vsws.warehouse_id = v_src.warehouse_id
      loop
        v_st := trim(coalesce(v_row.size::text, ''));
        if v_st = '' then
          v_st := null;
        elsif v_st ~ '^\d+(\.\d+)?$' then
          v_st := split_part(v_st, '.', 1);
        end if;
        if v_st is not distinct from v_size_norm then
          v_before := coalesce(v_row.stock_qty, 0);
          v_found := true;
          v_after := v_before + v_src.qty;
          update public.variant_size_warehouse_stock
          set stock_qty = v_after, updated_at = now()
          where id = v_row.id;
          if v_product_id is not null then
            perform public.log_stock_change(
              v_product_id,
              v_item.variant_id,
              v_size_norm,
              v_src.warehouse_id,
              'adjustment',
              v_before,
              v_after,
              null,
              null,
              format('rpc_remove_order_item_restore_stock: devolución por fuentes order_item=%s', p_order_item_id)
            );
          end if;
          exit;
        end if;
      end loop;

      if not v_found then
        v_after := v_src.qty;
        insert into public.variant_size_warehouse_stock (variant_id, size, warehouse_id, stock_qty, updated_at)
        values (v_item.variant_id, v_size_norm, v_src.warehouse_id, v_after, now())
        on conflict (variant_id, size, warehouse_id)
        do update set
          stock_qty = public.variant_size_warehouse_stock.stock_qty + excluded.stock_qty,
          updated_at = now();
        if v_product_id is not null then
          perform public.log_stock_change(
            v_product_id,
            v_item.variant_id,
            v_size_norm,
            v_src.warehouse_id,
            'adjustment',
            0,
            v_after,
            null,
            null,
            format('rpc_remove_order_item_restore_stock: insert devolución por fuentes order_item=%s', p_order_item_id)
          );
        end if;
      end if;
    end loop;
  end if;

  -- ---------- Fallback: sin fuentes y no missing ----------
  -- picked / reserved / waiting: una sola devolución en almacén general (evita duplicar v_qty en general + venta).
  -- variant_sizes lo actualiza trigger_sync_variant_sizes_on_warehouse_stock (84) tras INSERT/UPDATE en vsws.
  if v_item.variant_id is not null
     and v_size_norm is not null
     and not v_has_sources
     and v_status <> 'missing'
     and v_status in ('picked', 'reserved', 'waiting')
     and v_general_id is not null
  then
    v_before := 0;
    v_found := false;
    v_match_id := null;
    for v_row in
      select vsws.id, vsws.size, vsws.stock_qty
      from public.variant_size_warehouse_stock vsws
      where vsws.variant_id = v_item.variant_id
        and vsws.warehouse_id = v_general_id
    loop
      v_st := trim(coalesce(v_row.size::text, ''));
      if v_st = '' then
        v_st := null;
      elsif v_st ~ '^\d+(\.\d+)?$' then
        v_st := split_part(v_st, '.', 1);
      end if;
      if v_st is not distinct from v_size_norm then
        v_before := coalesce(v_row.stock_qty, 0);
        v_match_id := v_row.id;
        v_found := true;
        exit;
      end if;
    end loop;

    if v_found and v_match_id is not null then
      v_after := v_before + v_qty;
      update public.variant_size_warehouse_stock
      set stock_qty = v_after, updated_at = now()
      where id = v_match_id;
      if v_product_id is not null then
        perform public.log_stock_change(
          v_product_id,
          v_item.variant_id,
          v_size_norm,
          v_general_id,
          'adjustment',
          v_before,
          v_after,
          null,
          null,
          format('rpc_remove_order_item_restore_stock: fallback %s order_item=%s', v_status, p_order_item_id)
        );
      end if;
    else
      v_before := 0;
      v_after := v_qty;
      insert into public.variant_size_warehouse_stock (variant_id, size, warehouse_id, stock_qty, updated_at)
      values (v_item.variant_id, v_size_norm, v_general_id, v_qty, now())
      on conflict (variant_id, size, warehouse_id)
      do update set
        stock_qty = public.variant_size_warehouse_stock.stock_qty + excluded.stock_qty,
        updated_at = now();
      if v_product_id is not null then
        perform public.log_stock_change(
          v_product_id,
          v_item.variant_id,
          v_size_norm,
          v_general_id,
          'adjustment',
          v_before,
          v_after,
          null,
          null,
          format('rpc_remove_order_item_restore_stock: fallback %s order_item=%s', v_status, p_order_item_id)
        );
      end if;
    end if;
  end if;

  -- reserved_qty (fix 249): liberar cuando efectivamente se restauró stock, sea por
  -- fuentes (cualquier status: picked/reserved/waiting/cancelled/missing-con-fuentes)
  -- o por el fallback sin fuentes (picked/reserved/waiting). Antes (fix 246) dependía
  -- solo del status final, dejando sin liberar los casos 'cancelled' y 'missing con
  -- fuentes reales' aunque el stock físico sí se restauraba.
  if v_item.variant_id is not null
     and (v_has_sources or v_status in ('picked', 'reserved', 'waiting'))
  then
    update public.product_variants pv
    set reserved_qty = greatest(coalesce(pv.reserved_qty, 0) - v_qty, 0)
    where pv.id = v_item.variant_id;
  end if;

  delete from public.order_items where id = p_order_item_id;

  update public.orders o
  set
    total_amount = greatest(coalesce(o.total_amount, 0) - v_line_total, 0),
    updated_at = now()
  where o.id = v_order_id;

  if public.order_eligible_for_empty_deletion(v_order_id) then
    perform public.maint_try_delete_order_if_eligible(v_order_id, 'rpc_remove_order_item_restore_stock');
    v_order_deleted := true;
  end if;

  return json_build_object(
    'ok', true,
    'order_id', v_order_id,
    'order_deleted', v_order_deleted
  );
end;
$$;

comment on function public.rpc_remove_order_item_restore_stock(uuid) is
  'Admin: elimina un order_item, devuelve stock (order_item_stock_sources o fallback solo almacén general para picked/reserved/waiting sin fuentes), ajusta reserved_qty cuando se restauró stock (por fuentes o fallback picked/reserved/waiting, fix 249), resta total_amount, log_stock_change, borra pedido vacío. variant_sizes vía trigger 84.';

grant execute on function public.rpc_remove_order_item_restore_stock(uuid) to authenticated;

select pg_notify('pgrst', 'reload schema');
