-- 356_order_item_missing_total_trigger.sql
--
-- Defensa única: cualquier transición a status='missing' (split, refresh retiro,
-- rpc_update_order_item_status, mark_item_missing, etc.) resta la línea del total.
--
-- Evita doble resta:
--   - rpc_admin_mark_item_missing ya no resta a mano (lo hace el trigger).
--   - rpc_remove_missing_order_item / restore_stock sobre missing no restan
--     (el monto ya salió al pasar a missing).
--
-- NO APLICAR en producción sin aprobación explícita.

-- =============================================================================
-- Trigger: order_items → missing resta del total; salir de missing (no cancel)
-- puede reincorporar.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.trg_order_item_missing_adjust_total()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_old text;
  v_new text;
  v_line numeric := 0;
  v_order_id uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_new := lower(trim(coalesce(NEW.status, '')));
    IF v_new = 'missing' THEN
      v_line := coalesce(NEW.quantity, 0)::numeric * coalesce(NEW.price_snapshot, 0);
      v_order_id := NEW.order_id;
      IF v_line > 0 AND v_order_id IS NOT NULL THEN
        UPDATE public.orders
        SET total_amount = greatest(coalesce(total_amount, 0) - v_line, 0),
            updated_at = now()
        WHERE id = v_order_id;
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    v_old := lower(trim(coalesce(OLD.status, '')));
    v_new := lower(trim(coalesce(NEW.status, '')));
    v_order_id := NEW.order_id;

    -- → missing (desde cualquier otro estado)
    IF v_new = 'missing' AND v_old IS DISTINCT FROM 'missing' THEN
      v_line := coalesce(NEW.quantity, 0)::numeric * coalesce(NEW.price_snapshot, 0);
      IF v_line > 0 AND v_order_id IS NOT NULL THEN
        UPDATE public.orders
        SET total_amount = greatest(coalesce(total_amount, 0) - v_line, 0),
            updated_at = now()
        WHERE id = v_order_id;
      END IF;
      RETURN NEW;
    END IF;

    -- missing → operativo (picked/reserved/waiting/…): reincorporar
    -- missing → cancelled: no tocar (sigue fuera del total)
    IF v_old = 'missing'
       AND v_new IS DISTINCT FROM 'missing'
       AND v_new <> 'cancelled'
    THEN
      v_line := coalesce(NEW.quantity, 0)::numeric * coalesce(NEW.price_snapshot, 0);
      IF v_line > 0 AND v_order_id IS NOT NULL THEN
        UPDATE public.orders
        SET total_amount = coalesce(total_amount, 0) + v_line,
            updated_at = now()
        WHERE id = v_order_id;
      END IF;
    END IF;

    RETURN NEW;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$function$;

DROP TRIGGER IF EXISTS trg_order_item_missing_adjust_total ON public.order_items;
CREATE TRIGGER trg_order_item_missing_adjust_total
  AFTER INSERT OR UPDATE OF status ON public.order_items
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_order_item_missing_adjust_total();

COMMENT ON FUNCTION public.trg_order_item_missing_adjust_total() IS
  'canonical:356 | Al pasar a missing resta línea del total; al salir de missing (no cancelled) la reincorpora.';

-- =============================================================================
-- rpc_admin_mark_item_missing: quitar resta manual (el trigger 356 la hace)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_admin_mark_item_missing(p_item_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_uid uuid;
  v_item public.order_items%rowtype;
  v_product_id uuid;
  v_size_norm text;
  v_src record;
  v_row record;
  v_before int;
  v_qty_released int := 0;
  v_prev_status text;
  v_line_total numeric := 0;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = v_uid) THEN
    RAISE EXCEPTION 'Solo administradores pueden marcar un producto sin stock';
  END IF;

  SELECT * INTO v_item FROM public.order_items WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ítem no encontrado';
  END IF;

  v_prev_status := lower(trim(coalesce(v_item.status, '')));

  IF v_prev_status = 'cancelled' THEN
    RAISE EXCEPTION 'Este ítem ya está cancelado';
  END IF;

  IF v_item.variant_id IS NOT NULL THEN
    SELECT pv.product_id INTO v_product_id FROM public.product_variants pv WHERE pv.id = v_item.variant_id;
  END IF;

  v_size_norm := trim(coalesce(v_item.size::text, ''));
  IF v_size_norm = '' THEN
    v_size_norm := NULL;
  ELSIF v_size_norm ~ '^\d+(\.\d+)?$' THEN
    v_size_norm := split_part(v_size_norm, '.', 1);
  END IF;

  FOR v_src IN
    SELECT warehouse_id, greatest(coalesce(qty, 0), 0) AS qty
    FROM public.order_item_stock_sources
    WHERE order_item_id = p_item_id
  LOOP
    IF coalesce(v_src.qty, 0) <= 0 THEN
      CONTINUE;
    END IF;

    v_before := 0;
    IF v_item.variant_id IS NOT NULL THEN
      FOR v_row IN
        SELECT vsws.size, vsws.stock_qty
        FROM public.variant_size_warehouse_stock vsws
        WHERE vsws.variant_id = v_item.variant_id
          AND vsws.warehouse_id = v_src.warehouse_id
      LOOP
        IF trim(coalesce(v_row.size::text, '')) IS NOT DISTINCT FROM v_size_norm THEN
          v_before := coalesce(v_row.stock_qty, 0);
          EXIT;
        END IF;
      END LOOP;
    END IF;

    IF v_product_id IS NOT NULL THEN
      PERFORM public.log_stock_change(
        v_product_id, v_item.variant_id, v_size_norm, v_src.warehouse_id,
        'sin_stock_baja', v_before, v_before, NULL, NULL,
        format(
          'Marcado sin stock (Kanban): baja de reserva sin reingresar. order_item=%s',
          p_item_id
        )
      );
    END IF;

    v_qty_released := v_qty_released + v_src.qty;
  END LOOP;

  DELETE FROM public.order_item_stock_sources WHERE order_item_id = p_item_id;

  IF v_item.variant_id IS NOT NULL AND v_qty_released > 0 THEN
    UPDATE public.product_variants
    SET reserved_qty = greatest(coalesce(reserved_qty, 0) - v_qty_released, 0)
    WHERE id = v_item.variant_id;
  END IF;

  IF v_prev_status IS DISTINCT FROM 'missing' THEN
    v_line_total := coalesce(v_item.quantity, 0)::numeric * coalesce(v_item.price_snapshot, 0);
  END IF;

  -- El trigger 356 resta total_amount al cambiar status → missing.
  UPDATE public.order_items
  SET status = 'missing', checked_by = v_uid, checked_at = now(), updated_at = now()
  WHERE id = p_item_id;

  RETURN json_build_object(
    'ok', true,
    'item_id', p_item_id,
    'qty_written_off', v_qty_released,
    'total_reduced_by', coalesce(v_line_total, 0)
  );
END;
$function$;

COMMENT ON FUNCTION public.rpc_admin_mark_item_missing(uuid) IS
  'canonical:356 | Marca sin stock (writeoff). Total lo ajusta trg_order_item_missing_adjust_total.';

-- =============================================================================
-- rpc_remove_missing_order_item: no restar (ya excluido al pasar a missing)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_remove_missing_order_item(p_item_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_order_id uuid;
  v_customer_id uuid;
  v_status text;
BEGIN
  SELECT
    oi.order_id,
    o.customer_id,
    oi.status
  INTO v_order_id, v_customer_id, v_status
  FROM public.order_items oi
  JOIN public.orders o ON o.id = oi.order_id
  WHERE oi.id = p_item_id;

  IF v_order_id IS NULL THEN
    RAISE EXCEPTION 'Item no encontrado';
  END IF;

  IF lower(trim(coalesce(v_status, ''))) <> 'missing' THEN
    RAISE EXCEPTION 'Solo se puede quitar así un producto sin stock (faltante)';
  END IF;

  IF v_customer_id IS DISTINCT FROM auth.uid() THEN
    IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()) THEN
      RAISE EXCEPTION 'No tienes permiso para quitar este producto';
    END IF;
  END IF;

  DELETE FROM public.order_items WHERE id = p_item_id;

  -- 356: no restar total_amount — la línea ya salió del total al pasar a missing.
  UPDATE public.orders
  SET updated_at = now()
  WHERE id = v_order_id;

  RETURN json_build_object('removed', true, 'order_id', v_order_id);
END;
$function$;

COMMENT ON FUNCTION public.rpc_remove_missing_order_item(uuid) IS
  'canonical:356 | Elimina order_item missing. No toca total_amount (ya excluido al marcar missing).';

GRANT EXECUTE ON FUNCTION public.rpc_remove_missing_order_item(uuid) TO authenticated;

-- =============================================================================
-- rpc_remove_order_item_restore_stock: si status=missing, no restar total
-- (cuerpo 355 + guard missing)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_remove_order_item_restore_stock(p_order_item_id uuid)
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
              'cancelacion_confirmada_reingreso',
              v_before,
              v_after,
              null,
              null,
              format(
                'Cancelación confirmada (Kanban ✓): stock vuelto al depósito. order_item=%s',
                p_order_item_id
              )
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
            'cancelacion_confirmada_reingreso',
            0,
            v_after,
            null,
            null,
            format(
              'Cancelación confirmada (Kanban ✓): alta de fila de talle + reingreso. order_item=%s',
              p_order_item_id
            )
          );
        end if;
      end if;
    end loop;
  end if;

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
    'order_deleted', v_order_deleted
  );
end;
$function$;

COMMENT ON FUNCTION public.rpc_remove_order_item_restore_stock(uuid) IS
  'canonical:356 | Quita ítem; reingresa si hay fuentes. Si status=missing no resta total (ya excluido).';

SELECT pg_notify('pgrst', 'reload schema');
