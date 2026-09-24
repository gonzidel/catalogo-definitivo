-- 361_rpc_remove_order_item_optional_restore.sql
--
-- Al quitar un ítem con fuentes de stock, el admin puede elegir si reingresa
-- o no (evitar stock fantasma cuando se agregó por confusión / sin existencia).
--
-- Cambio:
--   rpc_remove_order_item_restore_stock(p_order_item_id, p_restore_stock boolean DEFAULT true)
--   - true  → comportamiento 356 (reingresa por order_item_stock_sources)
--   - false → quita el ítem sin mutar variant_size_warehouse_stock; audita
--             change_type='quitado_sin_reingreso'
--
-- Callers SQL de 1 argumento (cancel_order_full, etc.) siguen reingresando.
-- Rollback: 361_ROLLBACK_rpc_remove_order_item_optional_restore.sql

DROP FUNCTION IF EXISTS public.rpc_remove_order_item_restore_stock(uuid);

CREATE OR REPLACE FUNCTION public.rpc_remove_order_item_restore_stock(
  p_order_item_id uuid,
  p_restore_stock boolean DEFAULT true
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
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
  v_do_restore boolean;
  v_restored boolean := false;
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
  v_do_restore := coalesce(p_restore_stock, true);

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

  -- ---------- Reingreso por fuentes (solo si p_restore_stock) ----------
  if v_do_restore
     and v_item.variant_id is not null
     and v_size_norm is not null
     and v_has_sources
  then
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
              'cancelacion_confirmada_reingreso',
              v_before,
              v_after,
              null,
              null,
              format(
                'Ítem quitado: stock vuelto al depósito. order_item=%s',
                p_order_item_id
              )
            );
          end if;
          v_restored := true;
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
            'cancelacion_confirmada_reingreso',
            0,
            v_after,
            null,
            null,
            format(
              'Ítem quitado: alta de fila de talle + reingreso. order_item=%s',
              p_order_item_id
            )
          );
        end if;
        v_restored := true;
      end if;
    end loop;

  -- ---------- Admin eligió NO reingresar pese a tener fuentes ----------
  elsif (not v_do_restore)
     and v_item.variant_id is not null
     and v_size_norm is not null
     and v_has_sources
  then
    for v_src in
      select s.warehouse_id, s.qty
      from public.order_item_stock_sources s
      where s.order_item_id = p_order_item_id
    loop
      if coalesce(v_src.qty, 0) <= 0 then
        continue;
      end if;

      v_before := 0;
      select coalesce(vsws.stock_qty, 0)
      into v_before
      from public.variant_size_warehouse_stock vsws
      where vsws.variant_id = v_item.variant_id
        and vsws.warehouse_id = v_src.warehouse_id
        and trim(coalesce(vsws.size::text, '')) is not distinct from v_size_norm
      limit 1;

      if v_product_id is not null then
        perform public.log_stock_change(
          v_product_id,
          v_item.variant_id,
          v_size_norm,
          v_src.warehouse_id,
          'quitado_sin_reingreso',
          v_before,
          v_before,
          null,
          null,
          format(
            'Admin quitó ítem y eligió NO reingresar stock (había fuentes qty=%s). order_item=%s status=%s',
            v_src.qty,
            p_order_item_id,
            v_status
          )
        );
      end if;
    end loop;

  -- ---------- Sin fuentes: no reingresar a ciegas (342/356) ----------
  elsif v_item.variant_id is not null
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

    if v_product_id is not null then
      perform public.log_stock_change(
        v_product_id,
        v_item.variant_id,
        v_size_norm,
        v_general_id,
        'quitado_sin_reingreso',
        v_before,
        v_before,
        null,
        null,
        format(
          'Ítem quitado del pedido sin fuentes de stock: NO se reingresó automático. Verificar físico antes de cargar. status=%s order_item=%s',
          v_status,
          p_order_item_id
        )
      );
    end if;
  end if;

  if v_item.variant_id is not null
     and (v_has_sources or v_status in ('picked', 'reserved', 'waiting'))
  then
    update public.product_variants pv
    set reserved_qty = greatest(coalesce(pv.reserved_qty, 0) - v_qty, 0)
    where pv.id = v_item.variant_id;
  end if;

  delete from public.order_items where id = p_order_item_id;

  -- 356: missing ya estaba fuera del total; no restar de nuevo.
  if v_status <> 'missing' then
    update public.orders o
    set
      total_amount = greatest(coalesce(o.total_amount, 0) - v_line_total, 0),
      updated_at = now()
    where o.id = v_order_id;
  else
    update public.orders o
    set updated_at = now()
    where o.id = v_order_id;
  end if;

  if public.order_eligible_for_empty_deletion(v_order_id) then
    perform public.maint_try_delete_order_if_eligible(v_order_id, 'rpc_remove_order_item_restore_stock');
    v_order_deleted := true;
  end if;

  return json_build_object(
    'ok', true,
    'order_id', v_order_id,
    'order_deleted', v_order_deleted,
    'restored_stock', v_restored,
    'restore_requested', v_do_restore
  );
end;
$function$;

COMMENT ON FUNCTION public.rpc_remove_order_item_restore_stock(uuid, boolean) IS
  'canonical:361 | Quita ítem. p_restore_stock=true (default) reingresa por fuentes; false no muta stock físico.';

REVOKE ALL ON FUNCTION public.rpc_remove_order_item_restore_stock(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_remove_order_item_restore_stock(uuid, boolean) TO authenticated, service_role;

SELECT pg_notify('pgrst', 'reload schema');
