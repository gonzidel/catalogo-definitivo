-- 312 patch: cancel/restore deferred_stock_pending

-- 269_rpc_cancel_order_item_flag_missing_origin.sql
--
-- BUG REAL (2026-08-03, orden A55552, ítem "135 Marron T.38"): cuando la
-- clienta cancela un producto marcado "missing" (sin stock, ver botón
-- "Quitar" en /nj/dashboard), el pedido entero se movía a la columna
-- Cancelados del Kanban admin (nj/lib/orders/classification.ts), aunque el
-- resto de los ítems ya estuviera apartado y el pedido estuviera listo. Esto
-- pasaba porque el ítem cancelado tenía filas en order_item_stock_sources
-- (heredadas de un paso previo por rpc_split_order_item_status, 129, cuando
-- el ítem pasó por "waiting" antes de terminar "missing"), y la clasificación
-- usaba esa traza para decidir "hay stock físico que confirmar y devolver".
--
-- Evidencia en producción de por qué esa traza no siempre representa stock
-- real pendiente: para el ítem 6580ec23-19e8-45fc-be51-fc016ef75f1c la traza
-- decía qty=1 en warehouse "general", pero reserved_qty de la variante ya
-- estaba en 0 (ya reconciliado). Confirmar esa traza con el botón ✓
-- (rpc_remove_order_item_restore_stock, 249) hubiera acreditado +1 unidad
-- fantasma a variant_size_warehouse_stock sin que exista un producto físico
-- real -- exactamente lo que la dueña del negocio señaló: "sin stock" quiere
-- decir que el producto no existe físicamente, cancelarlo no debe generar
-- ninguna devolución.
--
-- Fix: en vez de inferir "¿hace falta confirmar devolución?" a partir de
-- order_item_stock_sources (señal poco confiable: existe tanto para ítems
-- realmente apartados-y-cancelados como para "missing" que heredaron trazas
-- de un split anterior), se deja constancia EXPLÍCITA en el momento de
-- cancelar: si el ítem estaba "missing", se marca admin_confirmed_missing =
-- true en la fila ya cancelada. Reutiliza la columna existente
-- (order_items.admin_confirmed_missing, migración 178) sin colisionar con su
-- otro uso (ese flag solo se lee para status 'picked'/'missing' en el resto
-- del sistema -- ver nj/lib/orders/domain.ts isPickedManualConfirmed /
-- isManualMissingOrderItem -- nunca para 'cancelled').
--
-- El frontend (nj/lib/orders/domain.ts, cancelledItemNeedsStockConfirmation)
-- pasa a usar este flag en vez de order_item_stock_sources para decidir si
-- un ítem cancelado fuerza al pedido a la columna Cancelados.
--
-- Alcance: rpc_cancel_order_item (126, botón "Quitar" del dashboard cliente)
-- y rpc_cancel_order_item_units (137, edición de cantidad). Ningún cambio de
-- comportamiento de stock/reserved_qty -- solo se agrega el flag informativo.

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
  v_deferred_pending boolean := false;
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
    oi.deferred_stock_pending,
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
  v_deferred_pending := coalesce(v_item.deferred_stock_pending, false);

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

  -- 312: phantom deferred waiting → borrar fuentes sin devolver stock.
  if v_deferred_pending then
    delete from public.order_item_stock_sources
    where order_item_id = p_item_id;
  elsif v_variant_id is not null and v_quantity > 0 and v_item_status in ('reserved', 'waiting') then
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

  -- Actualizar total del pedido
  update public.orders
  set total_amount = greatest(
    coalesce(total_amount, 0) - (coalesce(v_item.price_snapshot, 0) * v_quantity),
    0
  ),
  updated_at = now()
  where id = v_item.order_id_full;

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

comment on function public.rpc_cancel_order_item(uuid) is
  'Cancela un ítem de pedido y devuelve su cantidad al stock (variant_size_warehouse_stock por talle o variant_warehouse_stock). Si venía de "missing", marca admin_confirmed_missing=true para que el Kanban admin no lo trate como pendiente de confirmar devolución (269).';

-- ────────────────────────────────────────────────────────────────────────────

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

  -- Actualizar total del pedido
  update public.orders
  set total_amount = greatest(
    coalesce(total_amount, 0) - (coalesce(v_item.price_snapshot, 0) * v_cancel_qty),
    0
  ),
  updated_at = now()
  where id = v_item.order_id_full;

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

comment on function public.rpc_cancel_order_item_units(uuid, int) is
  'Cancela N unidades de un ítem de pedido y devuelve stock; reduce quantity o marca cancelled. Si venía de "missing", marca admin_confirmed_missing=true para que el Kanban admin no lo trate como pendiente de confirmar devolución (269).';

select pg_notify('pgrst', 'reload schema');


-- 269_rpc_cancel_order_item_flag_missing_origin.sql
--
-- BUG REAL (2026-08-03, orden A55552, ítem "135 Marron T.38"): cuando la
-- clienta cancela un producto marcado "missing" (sin stock, ver botón
-- "Quitar" en /nj/dashboard), el pedido entero se movía a la columna
-- Cancelados del Kanban admin (nj/lib/orders/classification.ts), aunque el
-- resto de los ítems ya estuviera apartado y el pedido estuviera listo. Esto
-- pasaba porque el ítem cancelado tenía filas en order_item_stock_sources
-- (heredadas de un paso previo por rpc_split_order_item_status, 129, cuando
-- el ítem pasó por "waiting" antes de terminar "missing"), y la clasificación
-- usaba esa traza para decidir "hay stock físico que confirmar y devolver".
--
-- Evidencia en producción de por qué esa traza no siempre representa stock
-- real pendiente: para el ítem 6580ec23-19e8-45fc-be51-fc016ef75f1c la traza
-- decía qty=1 en warehouse "general", pero reserved_qty de la variante ya
-- estaba en 0 (ya reconciliado). Confirmar esa traza con el botón ✓
-- (rpc_remove_order_item_restore_stock, 249) hubiera acreditado +1 unidad
-- fantasma a variant_size_warehouse_stock sin que exista un producto físico
-- real -- exactamente lo que la dueña del negocio señaló: "sin stock" quiere
-- decir que el producto no existe físicamente, cancelarlo no debe generar
-- ninguna devolución.
--
-- Fix: en vez de inferir "¿hace falta confirmar devolución?" a partir de
-- order_item_stock_sources (señal poco confiable: existe tanto para ítems
-- realmente apartados-y-cancelados como para "missing" que heredaron trazas
-- de un split anterior), se deja constancia EXPLÍCITA en el momento de
-- cancelar: si el ítem estaba "missing", se marca admin_confirmed_missing =
-- true en la fila ya cancelada. Reutiliza la columna existente
-- (order_items.admin_confirmed_missing, migración 178) sin colisionar con su
-- otro uso (ese flag solo se lee para status 'picked'/'missing' en el resto
-- del sistema -- ver nj/lib/orders/domain.ts isPickedManualConfirmed /
-- isManualMissingOrderItem -- nunca para 'cancelled').
--
-- El frontend (nj/lib/orders/domain.ts, cancelledItemNeedsStockConfirmation)
-- pasa a usar este flag en vez de order_item_stock_sources para decidir si
-- un ítem cancelado fuerza al pedido a la columna Cancelados.
--
-- Alcance: rpc_cancel_order_item (126, botón "Quitar" del dashboard cliente)
-- y rpc_cancel_order_item_units (137, edición de cantidad). Ningún cambio de
-- comportamiento de stock/reserved_qty -- solo se agrega el flag informativo.

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

  -- Actualizar total del pedido
  update public.orders
  set total_amount = greatest(
    coalesce(total_amount, 0) - (coalesce(v_item.price_snapshot, 0) * v_quantity),
    0
  ),
  updated_at = now()
  where id = v_item.order_id_full;

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

comment on function public.rpc_cancel_order_item(uuid) is
  'Cancela un ítem de pedido y devuelve su cantidad al stock (variant_size_warehouse_stock por talle o variant_warehouse_stock). Si venía de "missing", marca admin_confirmed_missing=true para que el Kanban admin no lo trate como pendiente de confirmar devolución (269).';

-- ────────────────────────────────────────────────────────────────────────────

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
  v_deferred_pending boolean := false;
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
    oi.deferred_stock_pending,
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
  v_deferred_pending := coalesce(v_item.deferred_stock_pending, false);

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

  -- 312: phantom deferred waiting → borrar/ajustar fuentes sin devolver stock.
  if v_deferred_pending then
    if v_cancel_qty >= v_quantity then
      delete from public.order_item_stock_sources where order_item_id = p_item_id;
    else
      update public.order_item_stock_sources s
      set qty = greatest(v_quantity - v_cancel_qty, 0)
      where s.order_item_id = p_item_id;
    end if;
  elsif v_variant_id is not null and v_cancel_qty > 0 and v_item_status in ('reserved', 'waiting') then
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

  -- Actualizar total del pedido
  update public.orders
  set total_amount = greatest(
    coalesce(total_amount, 0) - (coalesce(v_item.price_snapshot, 0) * v_cancel_qty),
    0
  ),
  updated_at = now()
  where id = v_item.order_id_full;

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

comment on function public.rpc_cancel_order_item_units(uuid, int) is
  'Cancela N unidades de un ítem de pedido y devuelve stock; reduce quantity o marca cancelled. Si venía de "missing", marca admin_confirmed_missing=true para que el Kanban admin no lo trate como pendiente de confirmar devolución (269).';

select pg_notify('pgrst', 'reload schema');


-- Quitar un order_item desde admin (orders2): una transacción con devolución de stock,
-- total_amount (resta de línea), trazabilidad y borrado de pedido vacío (misma regla que rpc_delete_empty_order).

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

  -- 312: phantom deferred → borrar fuentes sin devolver stock.
  if coalesce(v_item.deferred_stock_pending, false) then
    delete from public.order_item_stock_sources where order_item_id = p_order_item_id;
  elsif v_item.variant_id is not null and v_size_norm is not null and v_has_sources then
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
  if not coalesce(v_item.deferred_stock_pending, false)
     and v_item.variant_id is not null
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

  -- reserved_qty (paridad JS: reserved / waiting, con o sin talle)
  if not coalesce(v_item.deferred_stock_pending, false)
     and v_item.variant_id is not null and v_status in ('reserved', 'waiting') then
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
  'Admin: elimina un order_item, devuelve stock (order_item_stock_sources o fallback solo almacén general para picked/reserved/waiting sin fuentes), ajusta reserved_qty reserved/waiting, resta total_amount, log_stock_change, borra pedido vacío. variant_sizes vía trigger 84.';

grant execute on function public.rpc_remove_order_item_restore_stock(uuid) to authenticated;

select pg_notify('pgrst', 'reload schema');


select pg_notify('pgrst', 'reload schema');
