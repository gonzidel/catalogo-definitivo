-- 359_cancel_missing_skip_total.sql
--
-- BUG (auditoría 69, 2026-09-23): tras 356, marcar missing ya resta la línea
-- de orders.total_amount. rpc_cancel_order_item / _units seguían restando
-- otra vez al quitar el missing → undercharge (A57356, A57180, A57219).
--
-- Fix:
--   1) cancel item/units: no tocar total si v_item_status = missing
--   2) replace_missing: recalc excluye cancelled Y missing
--
-- Baseline cuerpos: prod = 312 (cancel item 2ª def + units 1ª def sin deferred)
-- + 271 replace. NO reintroduce deferred 312 units (prod no lo tiene).
--
-- NO APLICAR en producción sin aprobación explícita.

create or replace function public.rpc_cancel_order_item(p_item_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item record;
  v_item_status text;
  v_variant_id uuid;
  v_quantity int;
  v_was_picked boolean := false;
  v_warehouse_id uuid;
  v_warehouse_general_id uuid;
  v_warehouse_venta_id uuid;
  v_size_normalized text;
  v_has_sources boolean := false;
  v_src record;
begin
  select
    oi.id,
    oi.order_id,
    oi.variant_id,
    oi.quantity,
    oi.product_name,
    oi.color,
    oi.size,
    oi.price_snapshot,
    oi.status,
    o.id as order_id_full,
    o.order_number,
    o.customer_id,
    c.full_name as customer_name,
    c.customer_number
  into v_item
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  left join public.customers c on c.id = o.customer_id
  where oi.id = p_item_id
  for update of oi;

  if v_item.id is null then
    raise exception 'Item no encontrado';
  end if;

  if v_item.customer_id != auth.uid() then
    if not exists (select 1 from public.admins where user_id = auth.uid()) then
      raise exception 'No tienes permiso para cancelar este item';
    end if;
  end if;

  v_item_status := v_item.status;
  v_variant_id := v_item.variant_id;
  v_quantity := greatest(0, coalesce(v_item.quantity, 0)::int);
  v_was_picked := (v_item_status = 'picked');

  if v_item_status = 'cancelled' then
    raise exception 'Item ya cancelado';
  end if;

  if v_quantity <= 0 then
    raise exception 'Item sin unidades cancelables';
  end if;

  if v_variant_id is not null then
    perform 1
    from public.product_variants pv
    where pv.id = v_variant_id
    for update;
  end if;

  -- Notificación al admin si estaba apartado
  if v_was_picked then
    insert into public.admin_notifications (
      order_id, order_number, item_id, product_name, color, size, quantity,
      customer_name, customer_number, notification_type, message
    ) values (
      v_item.order_id_full,
      v_item.order_number,
      p_item_id,
      v_item.product_name,
      v_item.color,
      v_item.size,
      v_quantity,
      v_item.customer_name,
      v_item.customer_number,
      'item_cancelled',
      format(
        'El cliente %s (Nº %s) canceló el producto "%s" (Color: %s, Talle: %s, Cantidad: %s) del pedido #%s que ya estaba apartado.',
        coalesce(v_item.customer_name, 'Cliente'),
        coalesce(v_item.customer_number, '-'),
        coalesce(v_item.product_name, 'Producto'),
        coalesce(v_item.color, '-'),
        coalesce(v_item.size, '-'),
        v_quantity,
        coalesce(v_item.order_number, 'Sin número')
      )
    );
  end if;

  -- Devolver stock SOLO si el item estaba en reserved o waiting.
  -- Si estaba en picked, el stock NO vuelve automáticamente: queda pendiente
  -- para que el admin lo confirme via rpc_remove_order_item_restore_stock.
  if v_variant_id is not null and v_quantity > 0 and v_item_status in ('reserved', 'waiting') then
    select id into v_warehouse_general_id from public.warehouses where code = 'general' limit 1;
    select id into v_warehouse_venta_id from public.warehouses where code = 'venta-publico' limit 1;

    select exists (
      select 1
      from public.order_item_stock_sources s
      where s.order_item_id = p_item_id
    ) into v_has_sources;

    if v_has_sources then
      for v_src in
        select s.id, s.warehouse_id, greatest(coalesce(s.qty, 0), 0) as qty
        from public.order_item_stock_sources s
        where s.order_item_id = p_item_id
        order by s.warehouse_id, s.id
      loop
        if coalesce(v_src.qty, 0) <= 0 then
          continue;
        end if;

        v_size_normalized := trim(coalesce(v_item.size::text, ''));
        if v_size_normalized ~ '^\d+(\.\d+)?$' then
          v_size_normalized := split_part(v_size_normalized, '.', 1);
        end if;

        if v_size_normalized <> '' then
          insert into public.variant_size_warehouse_stock (variant_id, warehouse_id, size, stock_qty)
          values (v_variant_id, v_src.warehouse_id, v_size_normalized, 0)
          on conflict (variant_id, warehouse_id, size) do nothing;

          perform 1
          from public.variant_size_warehouse_stock
          where variant_id = v_variant_id
            and trim(coalesce(size, '')) = v_size_normalized
            and warehouse_id = v_src.warehouse_id
          for update;

          update public.variant_size_warehouse_stock
          set stock_qty = stock_qty + v_src.qty,
              updated_at = now()
          where variant_id = v_variant_id
            and trim(coalesce(size, '')) = v_size_normalized
            and warehouse_id = v_src.warehouse_id;
        else
          insert into public.variant_warehouse_stock (variant_id, warehouse_id, stock_qty)
          values (v_variant_id, v_src.warehouse_id, v_src.qty)
          on conflict (variant_id, warehouse_id)
          do update set stock_qty = variant_warehouse_stock.stock_qty + v_src.qty, updated_at = now();
        end if;
      end loop;

      -- Evita doble devolución en limpiezas futuras de ítems cancelados.
      delete from public.order_item_stock_sources
      where order_item_id = p_item_id;
    else
      -- Fallback sin trazas: waiting vuelve a venta-publico; reserved vuelve a general.
      v_warehouse_id := case
        when v_item_status = 'waiting' then v_warehouse_venta_id
        else v_warehouse_general_id
      end;

      if v_warehouse_id is not null then
        v_size_normalized := trim(coalesce(v_item.size::text, ''));
        if v_size_normalized ~ '^\d+(\.\d+)?$' then
          v_size_normalized := split_part(v_size_normalized, '.', 1);
        end if;

        if v_size_normalized <> '' then
          insert into public.variant_size_warehouse_stock (variant_id, warehouse_id, size, stock_qty)
          values (v_variant_id, v_warehouse_id, v_size_normalized, 0)
          on conflict (variant_id, warehouse_id, size) do nothing;

          perform 1
          from public.variant_size_warehouse_stock
          where variant_id = v_variant_id
            and trim(coalesce(size, '')) = v_size_normalized
            and warehouse_id = v_warehouse_id
          for update;

          update public.variant_size_warehouse_stock
          set stock_qty = stock_qty + v_quantity,
              updated_at = now()
          where variant_id = v_variant_id
            and trim(coalesce(size, '')) = v_size_normalized
            and warehouse_id = v_warehouse_id;
        else
          insert into public.variant_warehouse_stock (variant_id, warehouse_id, stock_qty)
          values (v_variant_id, v_warehouse_id, v_quantity)
          on conflict (variant_id, warehouse_id)
          do update set stock_qty = variant_warehouse_stock.stock_qty + v_quantity, updated_at = now();
        end if;
      end if;
    end if;

    update public.product_variants
    set reserved_qty = greatest(reserved_qty - v_quantity, 0)
    where id = v_variant_id;
  end if;

  -- 359: si venía de missing, 356 ya restó la línea del total — no restar otra vez.
  if v_item_status is distinct from 'missing' then
    update public.orders
    set total_amount = greatest(
      coalesce(total_amount, 0) - (coalesce(v_item.price_snapshot, 0) * v_quantity),
      0
    ),
    updated_at = now()
    where id = v_item.order_id_full;
  end if;

  -- Marcar ítem como cancelado. Si venía de "missing" (nunca hubo stock real
  -- disponible, aunque arrastrara trazas heredadas de un split previo), se
  -- deja admin_confirmed_missing=true como constancia explícita de que este
  -- ítem cancelado NO necesita que el admin confirme una devolución de stock
  -- -- ver nj/lib/orders/domain.ts cancelledItemNeedsStockConfirmation.
  update public.order_items
  set status = 'cancelled',
      admin_confirmed_missing = (admin_confirmed_missing or v_item_status = 'missing'),
      updated_at = now()
  where id = p_item_id;

  return json_build_object(
    'item_id', p_item_id,
    'order_id', v_item.order_id_full,
    'was_picked', v_was_picked,
    'notification_created', v_was_picked,
    'applied', true,
    'idempotent_noop', false
  );
end;
$$;


create or replace function public.rpc_cancel_order_item_units(
  p_item_id uuid,
  p_units int
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item record;
  v_item_status text;
  v_variant_id uuid;
  v_quantity int;
  v_cancel_qty int;
  v_was_picked boolean := false;
  v_warehouse_id uuid;
  v_warehouse_general_id uuid;
  v_warehouse_venta_id uuid;
  v_size_normalized text;
  v_has_sources boolean := false;
  v_src record;
  v_restore_qty int;
  v_remaining_qty int;
  v_has_size_model boolean := false;
begin
  select
    oi.id,
    oi.order_id,
    oi.variant_id,
    oi.quantity,
    oi.product_name,
    oi.color,
    oi.size,
    oi.price_snapshot,
    oi.status,
    oi.imagen,
    o.id as order_id_full,
    o.order_number,
    o.customer_id,
    c.full_name as customer_name,
    c.customer_number
  into v_item
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  left join public.customers c on c.id = o.customer_id
  where oi.id = p_item_id
  for update of oi;

  if v_item.id is null then
    raise exception 'Item no encontrado';
  end if;

  if v_item.customer_id != auth.uid() then
    if not exists (select 1 from public.admins where user_id = auth.uid()) then
      raise exception 'No tienes permiso para cancelar este item';
    end if;
  end if;

  v_item_status := v_item.status;
  v_variant_id := v_item.variant_id;
  v_quantity := greatest(0, coalesce(v_item.quantity, 0)::int);
  v_was_picked := (v_item_status = 'picked');

  if v_item_status = 'cancelled' then
    raise exception 'Item ya cancelado';
  end if;

  if v_quantity <= 0 then
    raise exception 'Item sin unidades cancelables';
  end if;

  if coalesce(p_units, 0) <= 0 then
    return json_build_object(
      'item_id', p_item_id,
      'order_id', v_item.order_id_full,
      'cancelled_units', 0,
      'was_picked', v_was_picked,
      'cancelled_entire_line', false,
      'applied', false,
      'reason', 'invalid_units',
      'idempotent_noop', true
    );
  end if;

  v_cancel_qty := least(p_units, v_quantity);
  if v_cancel_qty <= 0 then
    return json_build_object(
      'item_id', p_item_id,
      'order_id', v_item.order_id_full,
      'cancelled_units', 0,
      'was_picked', v_was_picked,
      'cancelled_entire_line', false,
      'applied', false,
      'reason', 'invalid_units',
      'idempotent_noop', true
    );
  end if;

  if v_variant_id is not null then
    perform 1
    from public.product_variants pv
    where pv.id = v_variant_id
    for update;
  end if;

  -- Notificación al admin si estaba apartado (con cantidad parcial si aplica)
  if v_was_picked and v_cancel_qty > 0 then
    insert into public.admin_notifications (
      order_id, order_number, item_id, product_name, color, size, quantity,
      customer_name, customer_number, notification_type, message
    ) values (
      v_item.order_id_full,
      v_item.order_number,
      p_item_id,
      v_item.product_name,
      v_item.color,
      v_item.size,
      v_cancel_qty,
      v_item.customer_name,
      v_item.customer_number,
      'item_cancelled',
      format(
        'El cliente %s (Nº %s) canceló %s unidad(es) del producto "%s" (Color: %s, Talle: %s) del pedido #%s que ya estaba apartado.',
        coalesce(v_item.customer_name, 'Cliente'),
        coalesce(v_item.customer_number, '-'),
        v_cancel_qty,
        coalesce(v_item.product_name, 'Producto'),
        coalesce(v_item.color, '-'),
        coalesce(v_item.size, '-'),
        coalesce(v_item.order_number, 'Sin número')
      )
    );
  end if;

  -- Devolver stock SOLO si el item estaba en reserved o waiting.
  -- Si estaba en picked, el stock NO vuelve automáticamente: queda pendiente
  -- para que el admin lo confirme via rpc_remove_order_item_restore_stock.
  if v_variant_id is not null and v_cancel_qty > 0 and v_item_status in ('reserved', 'waiting') then
    select id into v_warehouse_general_id from public.warehouses where code = 'general' limit 1;
    select id into v_warehouse_venta_id from public.warehouses where code = 'venta-publico' limit 1;

    select exists (
      select 1
      from public.order_item_stock_sources s
      where s.order_item_id = p_item_id
    ) into v_has_sources;

    if v_has_sources then
      v_remaining_qty := v_cancel_qty;
      for v_src in
        select s.id, s.warehouse_id, greatest(coalesce(s.qty, 0), 0) as qty
        from public.order_item_stock_sources s
        where s.order_item_id = p_item_id
        order by s.warehouse_id, s.id
      loop
        exit when v_remaining_qty <= 0;
        if coalesce(v_src.qty, 0) <= 0 then
          continue;
        end if;

        v_restore_qty := least(v_remaining_qty, v_src.qty);
        if v_restore_qty <= 0 then
          continue;
        end if;

        v_size_normalized := trim(coalesce(v_item.size::text, ''));
        if v_size_normalized ~ '^\d+(\.\d+)?$' then
          v_size_normalized := split_part(v_size_normalized, '.', 1);
        end if;

        if v_size_normalized <> '' then
          insert into public.variant_size_warehouse_stock (variant_id, warehouse_id, size, stock_qty)
          values (v_variant_id, v_src.warehouse_id, v_size_normalized, 0)
          on conflict (variant_id, warehouse_id, size) do nothing;

          perform 1
          from public.variant_size_warehouse_stock
          where variant_id = v_variant_id
            and trim(coalesce(size, '')) = v_size_normalized
            and warehouse_id = v_src.warehouse_id
          for update;

          update public.variant_size_warehouse_stock
          set stock_qty = stock_qty + v_restore_qty,
              updated_at = now()
          where variant_id = v_variant_id
            and trim(coalesce(size, '')) = v_size_normalized
            and warehouse_id = v_src.warehouse_id;
        else
          select (
            exists (
              select 1
              from public.variant_size_warehouse_stock
              where variant_id = v_variant_id
              limit 1
            )
            or exists (
              select 1
              from public.variant_sizes
              where variant_id = v_variant_id
                and trim(coalesce(size, '')) <> ''
              limit 1
            )
          )
          into v_has_size_model;

          if coalesce(v_has_size_model, false) then
            raise exception 'La variante % usa talles. No se puede restaurar stock sin size.', v_variant_id;
          end if;

          insert into public.variant_warehouse_stock (variant_id, warehouse_id, stock_qty)
          values (v_variant_id, v_src.warehouse_id, v_restore_qty)
          on conflict (variant_id, warehouse_id)
          do update set stock_qty = variant_warehouse_stock.stock_qty + v_restore_qty, updated_at = now();
        end if;

        if v_restore_qty >= v_src.qty then
          delete from public.order_item_stock_sources
          where id = v_src.id;
        else
          update public.order_item_stock_sources
          set qty = qty - v_restore_qty
          where id = v_src.id;
        end if;

        v_remaining_qty := v_remaining_qty - v_restore_qty;
      end loop;

      -- Si quedan unidades sin traza, aplicar fallback por estado.
      if v_remaining_qty > 0 then
        v_warehouse_id := case
          when v_item_status = 'waiting' then v_warehouse_venta_id
          else v_warehouse_general_id
        end;
        if v_warehouse_id is not null then
          v_size_normalized := trim(coalesce(v_item.size::text, ''));
          if v_size_normalized ~ '^\d+(\.\d+)?$' then
            v_size_normalized := split_part(v_size_normalized, '.', 1);
          end if;

          if v_size_normalized <> '' then
            insert into public.variant_size_warehouse_stock (variant_id, warehouse_id, size, stock_qty)
            values (v_variant_id, v_warehouse_id, v_size_normalized, 0)
            on conflict (variant_id, warehouse_id, size) do nothing;

            perform 1
            from public.variant_size_warehouse_stock
            where variant_id = v_variant_id
              and trim(coalesce(size, '')) = v_size_normalized
              and warehouse_id = v_warehouse_id
            for update;

            update public.variant_size_warehouse_stock
            set stock_qty = stock_qty + v_remaining_qty,
                updated_at = now()
            where variant_id = v_variant_id
              and trim(coalesce(size, '')) = v_size_normalized
              and warehouse_id = v_warehouse_id;
          else
            select (
              exists (
                select 1
                from public.variant_size_warehouse_stock
                where variant_id = v_variant_id
                limit 1
              )
              or exists (
                select 1
                from public.variant_sizes
                where variant_id = v_variant_id
                  and trim(coalesce(size, '')) <> ''
                limit 1
              )
            )
            into v_has_size_model;

            if coalesce(v_has_size_model, false) then
              raise exception 'La variante % usa talles. No se puede restaurar stock sin size.', v_variant_id;
            end if;

            insert into public.variant_warehouse_stock (variant_id, warehouse_id, stock_qty)
            values (v_variant_id, v_warehouse_id, v_remaining_qty)
            on conflict (variant_id, warehouse_id)
            do update set stock_qty = variant_warehouse_stock.stock_qty + v_remaining_qty, updated_at = now();
          end if;
        end if;
      end if;
    else
      -- Fallback sin trazas: waiting vuelve a venta-publico; reserved vuelve a general.
      v_warehouse_id := case
        when v_item_status = 'waiting' then v_warehouse_venta_id
        else v_warehouse_general_id
      end;

      if v_warehouse_id is not null then
        v_size_normalized := trim(coalesce(v_item.size::text, ''));
        if v_size_normalized ~ '^\d+(\.\d+)?$' then
          v_size_normalized := split_part(v_size_normalized, '.', 1);
        end if;

        if v_size_normalized <> '' then
          insert into public.variant_size_warehouse_stock (variant_id, warehouse_id, size, stock_qty)
          values (v_variant_id, v_warehouse_id, v_size_normalized, 0)
          on conflict (variant_id, warehouse_id, size) do nothing;

          perform 1
          from public.variant_size_warehouse_stock
          where variant_id = v_variant_id
            and trim(coalesce(size, '')) = v_size_normalized
            and warehouse_id = v_warehouse_id
          for update;

          update public.variant_size_warehouse_stock
          set stock_qty = stock_qty + v_cancel_qty,
              updated_at = now()
          where variant_id = v_variant_id
            and trim(coalesce(size, '')) = v_size_normalized
            and warehouse_id = v_warehouse_id;
        else
          select (
            exists (
              select 1
              from public.variant_size_warehouse_stock
              where variant_id = v_variant_id
              limit 1
            )
            or exists (
              select 1
              from public.variant_sizes
              where variant_id = v_variant_id
                and trim(coalesce(size, '')) <> ''
              limit 1
            )
          )
          into v_has_size_model;

          if coalesce(v_has_size_model, false) then
            raise exception 'La variante % usa talles. No se puede restaurar stock sin size.', v_variant_id;
          end if;

          insert into public.variant_warehouse_stock (variant_id, warehouse_id, stock_qty)
          values (v_variant_id, v_warehouse_id, v_cancel_qty)
          on conflict (variant_id, warehouse_id)
          do update set stock_qty = variant_warehouse_stock.stock_qty + v_cancel_qty, updated_at = now();
        end if;
      end if;
    end if;

    update public.product_variants
    set reserved_qty = greatest(reserved_qty - v_cancel_qty, 0)
    where id = v_variant_id;
  end if;

  -- 359: si venía de missing, 356 ya restó — no restar otra vez (también parcial).
  if v_item_status is distinct from 'missing' then
    update public.orders
    set total_amount = greatest(
      coalesce(total_amount, 0) - (coalesce(v_item.price_snapshot, 0) * v_cancel_qty),
      0
    ),
    updated_at = now()
    where id = v_item.order_id_full;
  end if;

  -- Reducir quantity o cancelar la línea
  if v_cancel_qty >= v_quantity then
    -- Igual que rpc_cancel_order_item (269): si venía de "missing", queda
    -- admin_confirmed_missing=true como constancia de que no necesita
    -- confirmación de devolución de stock.
    update public.order_items
    set status = 'cancelled',
        admin_confirmed_missing = (admin_confirmed_missing or v_item_status = 'missing'),
        updated_at = now()
    where id = p_item_id;
  else
    update public.order_items
    set quantity = greatest(coalesce(quantity, 0) - v_cancel_qty, 0),
        updated_at = now()
    where id = p_item_id;

    -- Si el ítem estaba apartado (picked), insertar fila cancelada para que
    -- el admin la vea en la columna Cancelados y pueda quitarla físicamente.
    if v_was_picked then
      insert into public.order_items (
        order_id, variant_id, product_name, color, size,
        quantity, price_snapshot, imagen, status
      ) values (
        v_item.order_id_full, v_variant_id, v_item.product_name,
        v_item.color, v_item.size, v_cancel_qty, v_item.price_snapshot,
        v_item.imagen, 'cancelled'
      );
    end if;

    -- Si estaba "missing", igual que arriba: la porción cancelada tampoco
    -- necesita confirmación de devolución, se deja registrada por separado.
    if v_item_status = 'missing' then
      insert into public.order_items (
        order_id, variant_id, product_name, color, size,
        quantity, price_snapshot, imagen, status, admin_confirmed_missing
      ) values (
        v_item.order_id_full, v_variant_id, v_item.product_name,
        v_item.color, v_item.size, v_cancel_qty, v_item.price_snapshot,
        v_item.imagen, 'cancelled', true
      );
    end if;
  end if;

  return json_build_object(
    'item_id', p_item_id,
    'order_id', v_item.order_id_full,
    'cancelled_units', v_cancel_qty,
    'was_picked', v_was_picked,
    'cancelled_entire_line', (v_cancel_qty >= v_quantity),
    'applied', true,
    'reason', null,
    'idempotent_noop', false
  );
end;
$$;


CREATE OR REPLACE FUNCTION public.rpc_customer_replace_missing_item(
  p_missing_item_id uuid,
  p_variant_id uuid,
  p_product_name text,
  p_color text,
  p_size text,
  p_imagen text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_missing record;
  v_order record;
  v_qty int;
  v_reserved int;
  v_total_stock int;
  v_available int;
  v_general_id uuid;
  v_venta_id uuid;
  v_general_stock int;
  v_remaining_qty int;
  v_qty_from_general int;
  v_qty_from_venta int;
  v_size_normalized text;
  v_use_size_table boolean;
  v_size_stock_general int;
  v_size_stock_venta int;
  v_size_row record;
  v_item_price numeric;
  v_new_item_id uuid;
  v_gross_subtotal numeric;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  SELECT id, order_id, status, quantity
  INTO v_missing
  FROM public.order_items
  WHERE id = p_missing_item_id
  FOR UPDATE;

  IF v_missing.id IS NULL THEN
    RAISE EXCEPTION 'Ítem no encontrado';
  END IF;

  IF v_missing.status <> 'missing' THEN
    RAISE EXCEPTION 'Este ítem ya no está marcado como sin stock';
  END IF;

  SELECT id, customer_id, status
  INTO v_order
  FROM public.orders
  WHERE id = v_missing.order_id
  FOR UPDATE;

  IF v_order.customer_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'No tenés permiso para modificar este pedido';
  END IF;

  IF v_order.status NOT IN ('active', 'closing_soon') THEN
    RAISE EXCEPTION 'Este pedido no admite cambios';
  END IF;

  IF p_variant_id IS NULL THEN
    RAISE EXCEPTION 'Falta la variante del producto alternativo';
  END IF;

  v_qty := greatest(coalesce(v_missing.quantity, 0), 1);

  SELECT public.get_total_stock(p_variant_id) INTO v_total_stock;
  SELECT reserved_qty INTO v_reserved
  FROM public.product_variants
  WHERE id = p_variant_id
  FOR UPDATE;

  v_available := coalesce(v_total_stock, 0) - coalesce(v_reserved, 0);
  IF v_qty > v_available THEN
    RAISE EXCEPTION
      USING MESSAGE = format(
        'Sin stock suficiente para %s (color %s talle %s). Disponible: %s.',
        coalesce(p_product_name, 'producto'), coalesce(p_color, '-'), coalesce(p_size, '-'), v_available
      );
  END IF;

  SELECT id INTO v_general_id FROM public.warehouses WHERE code = 'general' LIMIT 1;
  SELECT id INTO v_venta_id FROM public.warehouses WHERE code = 'venta-publico' LIMIT 1;

  v_qty_from_general := 0;
  v_qty_from_venta := 0;
  v_remaining_qty := 0;
  v_size_normalized := trim(coalesce(p_size, ''));
  IF v_size_normalized ~ '^\d+(\.\d+)?$' THEN
    v_size_normalized := split_part(v_size_normalized, '.', 1);
  END IF;

  v_use_size_table := false;
  IF v_size_normalized != '' AND v_general_id IS NOT NULL AND v_venta_id IS NOT NULL THEN
    INSERT INTO public.variant_size_warehouse_stock (variant_id, warehouse_id, size, stock_qty)
    VALUES (p_variant_id, v_general_id, v_size_normalized, 0)
    ON CONFLICT (variant_id, warehouse_id, size) DO NOTHING;
    INSERT INTO public.variant_size_warehouse_stock (variant_id, warehouse_id, size, stock_qty)
    VALUES (p_variant_id, v_venta_id, v_size_normalized, 0)
    ON CONFLICT (variant_id, warehouse_id, size) DO NOTHING;

    v_size_stock_general := 0;
    v_size_stock_venta := 0;
    FOR v_size_row IN
      SELECT warehouse_id, stock_qty
      FROM public.variant_size_warehouse_stock
      WHERE variant_id = p_variant_id
        AND trim(coalesce(size, '')) = v_size_normalized
        AND warehouse_id IN (v_general_id, v_venta_id)
      ORDER BY warehouse_id
      FOR UPDATE
    LOOP
      IF v_size_row.warehouse_id = v_general_id THEN
        v_size_stock_general := coalesce(v_size_row.stock_qty, 0);
      ELSIF v_size_row.warehouse_id = v_venta_id THEN
        v_size_stock_venta := coalesce(v_size_row.stock_qty, 0);
      END IF;
    END LOOP;

    IF (coalesce(v_size_stock_general, 0) + coalesce(v_size_stock_venta, 0)) < v_qty THEN
      RAISE EXCEPTION
        USING MESSAGE = format(
          'Sin stock por talle suficiente para %s (color %s talle %s). Disponible: %s.',
          coalesce(p_product_name, 'producto'), coalesce(p_color, '-'), v_size_normalized,
          coalesce(v_size_stock_general, 0) + coalesce(v_size_stock_venta, 0)
        );
    END IF;

    v_use_size_table := true;
    v_general_stock := coalesce(v_size_stock_general, 0);
    IF v_general_stock >= v_qty THEN
      v_qty_from_general := v_qty;
      v_remaining_qty := 0;
    ELSIF v_general_stock > 0 THEN
      v_qty_from_general := v_general_stock;
      v_remaining_qty := v_qty - v_general_stock;
    ELSE
      v_remaining_qty := v_qty;
    END IF;
    IF v_remaining_qty > 0 THEN
      v_qty_from_venta := v_remaining_qty;
    END IF;

    IF v_qty_from_general > 0 THEN
      UPDATE public.variant_size_warehouse_stock
      SET stock_qty = stock_qty - v_qty_from_general, updated_at = now()
      WHERE variant_id = p_variant_id AND trim(coalesce(size, '')) = v_size_normalized AND warehouse_id = v_general_id;
    END IF;
    IF v_qty_from_venta > 0 THEN
      UPDATE public.variant_size_warehouse_stock
      SET stock_qty = stock_qty - v_qty_from_venta, updated_at = now()
      WHERE variant_id = p_variant_id AND trim(coalesce(size, '')) = v_size_normalized AND warehouse_id = v_venta_id;
    END IF;
  END IF;

  IF NOT v_use_size_table AND v_size_normalized = '' THEN
    v_remaining_qty := v_qty;
    v_qty_from_general := 0;
    v_qty_from_venta := 0;

    SELECT coalesce(stock_qty, 0) INTO v_general_stock
    FROM public.variant_warehouse_stock
    WHERE variant_id = p_variant_id AND warehouse_id = v_general_id;

    IF v_general_stock > 0 THEN
      IF v_general_stock >= v_qty THEN
        UPDATE public.variant_warehouse_stock
        SET stock_qty = stock_qty - v_qty, updated_at = now()
        WHERE variant_id = p_variant_id AND warehouse_id = v_general_id;
        v_qty_from_general := v_qty;
        v_remaining_qty := 0;
      ELSE
        UPDATE public.variant_warehouse_stock
        SET stock_qty = 0, updated_at = now()
        WHERE variant_id = p_variant_id AND warehouse_id = v_general_id;
        v_remaining_qty := v_qty - v_general_stock;
        v_qty_from_general := v_general_stock;
        v_qty_from_venta := v_remaining_qty;
      END IF;
    ELSE
      v_remaining_qty := v_qty;
      v_qty_from_venta := v_qty;
    END IF;

    IF v_remaining_qty > 0 THEN
      UPDATE public.variant_warehouse_stock
      SET stock_qty = stock_qty - v_remaining_qty, updated_at = now()
      WHERE variant_id = p_variant_id AND warehouse_id = v_venta_id;
    END IF;
  END IF;

  UPDATE public.product_variants
  SET reserved_qty = coalesce(reserved_qty, 0) + v_qty
  WHERE id = p_variant_id;

  SELECT price INTO v_item_price FROM public.product_variants WHERE id = p_variant_id;
  v_item_price := coalesce(v_item_price, 0);

  IF v_qty_from_general > 0 AND v_general_id IS NOT NULL THEN
    INSERT INTO public.order_items (order_id, variant_id, product_name, color, size, quantity, price_snapshot, imagen, status)
    VALUES (v_order.id, p_variant_id, p_product_name, p_color, p_size, v_qty_from_general, v_item_price, p_imagen, 'reserved')
    RETURNING id INTO v_new_item_id;
    INSERT INTO public.order_item_stock_sources (order_item_id, warehouse_id, qty)
    VALUES (v_new_item_id, v_general_id, v_qty_from_general);
  END IF;

  IF v_qty_from_venta > 0 AND v_venta_id IS NOT NULL THEN
    INSERT INTO public.order_items (order_id, variant_id, product_name, color, size, quantity, price_snapshot, imagen, status)
    VALUES (v_order.id, p_variant_id, p_product_name, p_color, p_size, v_qty_from_venta, v_item_price, p_imagen, 'waiting')
    RETURNING id INTO v_new_item_id;
    INSERT INTO public.order_item_stock_sources (order_item_id, warehouse_id, qty)
    VALUES (v_new_item_id, v_venta_id, v_qty_from_venta);
  END IF;

  -- El ítem "missing" nunca tuvo stock real reservado -- cancelarlo acá
  -- directamente (ya tenemos el row lockeado) en vez de llamar a
  -- rpc_cancel_order_item, y marcar admin_confirmed_missing=true (mismo
  -- criterio que 269) para que el Kanban admin no lo trate como pendiente
  -- de confirmar devolución de stock.
  UPDATE public.order_items
  SET status = 'cancelled', admin_confirmed_missing = true, updated_at = now()
  WHERE id = p_missing_item_id;

  -- 359: excluir missing (354/356 ya los sacan del facturable; no reincorporar).
  SELECT coalesce(sum(oi.quantity * coalesce(oi.price_snapshot, 0)), 0)
  INTO v_gross_subtotal
  FROM public.order_items oi
  WHERE oi.order_id = v_order.id
    AND lower(trim(coalesce(oi.status, ''))) NOT IN ('cancelled', 'missing');

  UPDATE public.orders
  SET total_amount = v_gross_subtotal, updated_at = now()
  WHERE id = v_order.id;

  RETURN json_build_object('ok', true, 'order_id', v_order.id, 'new_item_id', v_new_item_id);
END;
$function$;


COMMENT ON FUNCTION public.rpc_cancel_order_item(uuid) IS
  'canonical:359 | Cancela ítem; si venía de missing no resta total (356 ya lo hizo); admin_confirmed_missing (269/312).';

COMMENT ON FUNCTION public.rpc_cancel_order_item_units(uuid, integer) IS
  'canonical:359 | Cancela N unidades; si venía de missing no resta total (356 ya lo hizo); admin_confirmed_missing (269/312).';

COMMENT ON FUNCTION public.rpc_customer_replace_missing_item(uuid, uuid, text, text, text, text) IS
  'canonical:359 | Reemplaza missing por alt; recalc total excluye cancelled y missing.';

GRANT EXECUTE ON FUNCTION public.rpc_cancel_order_item(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cancel_order_item_units(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_customer_replace_missing_item(uuid, uuid, text, text, text, text) TO authenticated;

SELECT pg_notify('pgrst', 'reload schema');
