-- 78_rpc_update_local_order.sql — Actualizar pedido local (ítems y stock)

create or replace function public.rpc_update_local_order(
  p_local_order_id uuid,
  p_items jsonb
)
returns json
language plpgsql
security definer
as $$
declare
  v_order_id uuid;
  v_warehouse_venta_publico_id uuid;
  v_warehouse_general_id uuid;
  v_item jsonb;
  v_current record;
  v_cur_item record;
  v_variant_id uuid;
  v_size text;
  v_normalized_size text;
  v_old_qty int;
  v_new_qty int;
  v_diff int;
  v_stock_vp int;
  v_stock_gen int;
  v_size_stock_vp int;
  v_size_stock_gen int;
  v_fallback_stock_qty int;
  v_total_amount numeric(12,2) := 0;
  v_qty_to_deduct int;
  v_deduct_vp int;
  v_deduct_gen int;
  v_add_without_stock boolean;
  v_remaining int;
  v_notes_text text;
  v_notes jsonb;
  v_lines_sum numeric(12,2);
  v_shipping numeric := 0;
  v_discount numeric := 0;
  v_extras_amount numeric := 0;
  v_extras_percentage numeric := 0;
begin
  -- Validar que el pedido existe y conservar notas (extras % / monto fijo viven aquí, no en líneas)
  select lo.id, lo.notes into v_order_id, v_notes_text
  from public.local_orders lo
  where lo.id = p_local_order_id;
  if v_order_id is null then
    raise exception 'Pedido local no encontrado';
  end if;

  -- Obtener warehouse ids
  select id into v_warehouse_venta_publico_id from public.warehouses where code = 'venta-publico' limit 1;
  select id into v_warehouse_general_id from public.warehouses where code = 'general' limit 1;
  if v_warehouse_venta_publico_id is null or v_warehouse_general_id is null then
    raise exception 'Warehouses venta-publico o general no encontrados';
  end if;

  -- 1) Devolver stock por ítems quitados o con cantidad reducida (solo ventas: price_snapshot >= 0).
  --     Líneas de devolución (precio negativo) no reservaron stock al guardar; no reingresar aquí al quitarlas.
  for v_current in
    select loi.id, loi.variant_id, loi.size, loi.quantity
    from public.local_order_items loi
    where loi.local_order_id = p_local_order_id
      and loi.variant_id is not null
      and coalesce(loi.price_snapshot, 0) >= 0
  loop
    v_new_qty := 0;
    for v_item in select * from jsonb_array_elements(p_items) loop
      if (v_item->>'variant_id')::text is not null and (v_item->>'variant_id')::text != 'null' and (v_item->>'variant_id')::text != ''
         and (v_item->>'variant_id')::uuid = v_current.variant_id
         and coalesce(v_item->>'size', '') = coalesce(v_current.size, '') then
        v_new_qty := (v_item->>'quantity')::int;
        exit;
      end if;
    end loop;
    v_diff := v_current.quantity - v_new_qty;
    if v_diff > 0 then
      -- Devolver a venta-publico (si hay talle, devolver por talle)
      if coalesce(v_current.size, '') <> '' then
        v_normalized_size := trim(v_current.size);
        if v_normalized_size ~ '^\d+(\.\d+)?$' then
          v_normalized_size := split_part(v_normalized_size, '.', 1);
        end if;

        insert into public.variant_size_warehouse_stock (variant_id, size, warehouse_id, stock_qty, updated_at)
        values (v_current.variant_id, v_normalized_size, v_warehouse_venta_publico_id, v_diff, now())
        on conflict (variant_id, size, warehouse_id)
        do update set
          stock_qty = public.variant_size_warehouse_stock.stock_qty + v_diff,
          updated_at = now();
      else
        insert into public.variant_warehouse_stock (variant_id, warehouse_id, stock_qty, updated_at)
        values (v_current.variant_id, v_warehouse_venta_publico_id, v_diff, now())
        on conflict (variant_id, warehouse_id)
        do update set
          stock_qty = variant_warehouse_stock.stock_qty + v_diff,
          updated_at = now();
      end if;
    end if;
  end loop;

  -- 2) Validar y descontar stock por ítems nuevos o con cantidad aumentada (solo productos con variant_id)
  for v_item in select * from jsonb_array_elements(p_items) loop
    if (v_item->>'variant_id')::text is null or (v_item->>'variant_id')::text = 'null' or (v_item->>'variant_id')::text = '' then
      continue; -- extras especiales, no tocan stock
    end if;

    -- Devolución (precio negativo en el pedido): solo persistir en local_order_items; el stock se ajusta al finalizar la venta (rpc_create_public_sale + is_return)
    if coalesce((v_item->>'price_snapshot')::numeric, 0) < 0 then
      continue;
    end if;

    v_variant_id := (v_item->>'variant_id')::uuid;
    v_size := v_item->>'size';
    v_new_qty := (v_item->>'quantity')::int;

    v_old_qty := 0;
    for v_cur_item in
      select quantity from public.local_order_items
      where local_order_id = p_local_order_id
        and variant_id = v_variant_id
        and coalesce(size, '') = coalesce(v_size, '')
      limit 1
    loop
      v_old_qty := v_cur_item.quantity;
      exit;
    end loop;

    v_qty_to_deduct := v_new_qty - v_old_qty;
    if v_qty_to_deduct <= 0 then
      continue;
    end if;

    -- Detectar confirmación de "agregar sin stock" (frontend envía source 0,0)
    v_add_without_stock := (
      v_item->'source' is not null
      and coalesce((v_item->'source'->>'venta_publico')::int, 0) = 0
      and coalesce((v_item->'source'->>'general')::int, 0) = 0
    );
    -- Si se confirmó agregar sin stock, permitir guardar SIN descontar stock
    if v_add_without_stock then
      continue;
    end if;

    if coalesce(v_size, '') <> '' then
      -- Stock por talle (variant_size_warehouse_stock) + fallback a variant_sizes
      v_normalized_size := trim(v_size);
      if v_normalized_size ~ '^\d+(\.\d+)?$' then
        v_normalized_size := split_part(v_normalized_size, '.', 1);
      end if;

      select
        coalesce(sum(case when warehouse_id = v_warehouse_venta_publico_id then stock_qty else 0 end), 0),
        coalesce(sum(case when warehouse_id = v_warehouse_general_id then stock_qty else 0 end), 0)
      into v_size_stock_vp, v_size_stock_gen
      from public.variant_size_warehouse_stock
      where variant_id = v_variant_id
        and size = v_normalized_size
        and warehouse_id in (v_warehouse_venta_publico_id, v_warehouse_general_id);

      -- Fallback: si no hay stock por warehouse, usar variant_sizes.stock_qty como "general"
      v_fallback_stock_qty := 0;
      if coalesce(v_size_stock_vp, 0) = 0 and coalesce(v_size_stock_gen, 0) = 0 then
        select coalesce(stock_qty, 0) into v_fallback_stock_qty
        from public.variant_sizes
        where variant_id = v_variant_id
          and size = v_normalized_size
        limit 1;
        if coalesce(v_fallback_stock_qty, 0) > 0 then
          v_size_stock_gen := v_fallback_stock_qty;
        end if;
      end if;

      if (coalesce(v_size_stock_vp, 0) + coalesce(v_size_stock_gen, 0)) < v_qty_to_deduct then
        raise exception 'Stock insuficiente para % talle % (Cantidad a agregar: %, Disponible: venta-publico %, general %)',
          v_item->>'product_name', v_normalized_size, v_qty_to_deduct, coalesce(v_size_stock_vp, 0), coalesce(v_size_stock_gen, 0);
      end if;

      v_deduct_vp := least(v_qty_to_deduct, coalesce(v_size_stock_vp, 0));
      v_deduct_gen := v_qty_to_deduct - v_deduct_vp;

      -- Asegurar registros y aplicar descuento
      insert into public.variant_size_warehouse_stock (variant_id, size, warehouse_id, stock_qty, updated_at)
      values (v_variant_id, v_normalized_size, v_warehouse_venta_publico_id, 0, now())
      on conflict (variant_id, size, warehouse_id) do nothing;
      insert into public.variant_size_warehouse_stock (variant_id, size, warehouse_id, stock_qty, updated_at)
      values (v_variant_id, v_normalized_size, v_warehouse_general_id, coalesce(v_fallback_stock_qty, 0), now())
      on conflict (variant_id, size, warehouse_id)
      do update set
        stock_qty = greatest(public.variant_size_warehouse_stock.stock_qty, excluded.stock_qty),
        updated_at = now();

      if v_deduct_vp > 0 then
        update public.variant_size_warehouse_stock
        set stock_qty = stock_qty - v_deduct_vp,
            updated_at = now()
        where variant_id = v_variant_id
          and size = v_normalized_size
          and warehouse_id = v_warehouse_venta_publico_id;
      end if;
      if v_deduct_gen > 0 then
        update public.variant_size_warehouse_stock
        set stock_qty = stock_qty - v_deduct_gen,
            updated_at = now()
        where variant_id = v_variant_id
          and size = v_normalized_size
          and warehouse_id = v_warehouse_general_id;

        if coalesce(v_fallback_stock_qty, 0) > 0 then
          update public.variant_sizes
          set stock_qty = greatest(stock_qty - v_deduct_gen, 0),
              updated_at = now()
          where variant_id = v_variant_id
            and size = v_normalized_size;
        end if;
      end if;
    else
      -- Sin talle: stock legacy (variant_warehouse_stock)
      select coalesce(stock_qty, 0) into v_stock_vp
      from public.variant_warehouse_stock
      where variant_id = v_variant_id and warehouse_id = v_warehouse_venta_publico_id
      for update;

      select coalesce(stock_qty, 0) into v_stock_gen
      from public.variant_warehouse_stock
      where variant_id = v_variant_id and warehouse_id = v_warehouse_general_id
      for update;

      if coalesce(v_stock_vp, 0) + coalesce(v_stock_gen, 0) < v_qty_to_deduct then
        raise exception 'Stock insuficiente para % (Cantidad a agregar: %, Disponible: venta-publico %, general %)',
          v_item->>'product_name', v_qty_to_deduct, coalesce(v_stock_vp, 0), coalesce(v_stock_gen, 0);
      end if;

      v_deduct_vp := least(v_qty_to_deduct, coalesce(v_stock_vp, 0));
      v_deduct_gen := v_qty_to_deduct - v_deduct_vp;

      if v_deduct_vp > 0 then
        insert into public.variant_warehouse_stock (variant_id, warehouse_id, stock_qty, updated_at)
        values (v_variant_id, v_warehouse_venta_publico_id, coalesce(v_stock_vp, 0) - v_deduct_vp, now())
        on conflict (variant_id, warehouse_id)
        do update set
          stock_qty = variant_warehouse_stock.stock_qty - v_deduct_vp,
          updated_at = now();
      end if;
      if v_deduct_gen > 0 then
        insert into public.variant_warehouse_stock (variant_id, warehouse_id, stock_qty, updated_at)
        values (v_variant_id, v_warehouse_general_id, coalesce(v_stock_gen, 0) - v_deduct_gen, now())
        on conflict (variant_id, warehouse_id)
        do update set
          stock_qty = variant_warehouse_stock.stock_qty - v_deduct_gen,
          updated_at = now();
      end if;
    end if;
  end loop;

  -- 3) Eliminar todos los ítems actuales e insertar los nuevos
  delete from public.local_order_items where local_order_id = p_local_order_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_total_amount := v_total_amount + ((v_item->>'quantity')::int * (v_item->>'price_snapshot')::numeric);
    insert into public.local_order_items (
      local_order_id,
      variant_id,
      product_name,
      color,
      size,
      quantity,
      price_snapshot,
      imagen,
      status
    )
    values (
      p_local_order_id,
      case when (v_item->>'variant_id')::text is null or (v_item->>'variant_id')::text = 'null' or (v_item->>'variant_id')::text = ''
           then null else (v_item->>'variant_id')::uuid end,
      coalesce(v_item->>'product_name', 'Producto'),
      v_item->>'color',
      v_item->>'size',
      (v_item->>'quantity')::int,
      (v_item->>'price_snapshot')::numeric,
      v_item->>'imagen',
      'pending'
    );
  end loop;

  -- Igual que rpc_create_local_order: subtotal de líneas + shipping/discount + extras_amount + % sobre ese acumulado
  v_lines_sum := v_total_amount;
  v_total_amount := v_lines_sum;
  if v_notes_text is not null and btrim(v_notes_text) <> '' then
    begin
      v_notes := v_notes_text::jsonb;
    exception
      when others then
        v_notes := '{}'::jsonb;
    end;
  else
    v_notes := '{}'::jsonb;
  end if;
  if v_notes ? 'shipping' then
    v_shipping := coalesce((v_notes->>'shipping')::numeric, 0);
    v_total_amount := v_total_amount + v_shipping;
  end if;
  if v_notes ? 'discount' then
    v_discount := coalesce((v_notes->>'discount')::numeric, 0);
    v_total_amount := v_total_amount - v_discount;
  end if;
  if v_notes ? 'extras_amount' then
    v_extras_amount := coalesce((v_notes->>'extras_amount')::numeric, 0);
    v_total_amount := v_total_amount + v_extras_amount;
  end if;
  if v_notes ? 'extras_percentage' then
    v_extras_percentage := coalesce((v_notes->>'extras_percentage')::numeric, 0);
    v_total_amount := v_total_amount + (v_total_amount * v_extras_percentage / 100);
  end if;
  v_total_amount := greatest(v_total_amount, 0);

  update public.local_orders
  set total_amount = v_total_amount, updated_at = now()
  where id = p_local_order_id;

  return json_build_object(
    'success', true,
    'local_order_id', p_local_order_id,
    'total_amount', v_total_amount
  );
end $$;

