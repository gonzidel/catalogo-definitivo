-- 311_mirror_local_order_to_retiro.sql
--
-- Al crear un pedido local (public-sales), espejarlo en orders para el Kanban
-- Retiro (/nj/admin/retiro) como Apartados (ítems picked: stock ya descontado).
--
-- Soft-fail si el cliente ya tiene pedido abierto (active/closing_soon/closed):
-- el local_order se crea igual; el espejo se omite con reason en el JSON.
--
-- NO descuenta stock otra vez (ya lo hizo rpc_create_local_order).
--
-- Rollback: dropear rpc_mirror_local_order_to_retiro y restaurar rpc_create_local_order
-- desde 18_local_orders / definición previa (sin llamada al mirror).

create schema if not exists fyl_private;

-- Resuelve o crea customers a partir de public_sales_customers.
create or replace function fyl_private.resolve_customer_for_public_sales(
  p_public_sales_customer_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_psc record;
  v_customer_id uuid;
  v_full_name text;
begin
  if p_public_sales_customer_id is null then
    return null;
  end if;

  select
    id,
    first_name,
    last_name,
    phone,
    email,
    document_number
  into v_psc
  from public.public_sales_customers
  where id = p_public_sales_customer_id;

  if not found then
    return null;
  end if;

  -- 1) Link directo
  select c.id into v_customer_id
  from public.customers c
  where c.public_sales_customer_id = v_psc.id
  limit 1;

  if v_customer_id is not null then
    return v_customer_id;
  end if;

  -- 2) Match por DNI
  if nullif(trim(coalesce(v_psc.document_number, '')), '') is not null then
    select c.id into v_customer_id
    from public.customers c
    where nullif(trim(coalesce(c.dni, '')), '') is not null
      and trim(c.dni) = trim(v_psc.document_number)
    order by c.created_by_admin desc nulls last
    limit 1;

    if v_customer_id is not null then
      update public.customers
      set public_sales_customer_id = coalesce(public_sales_customer_id, v_psc.id)
      where id = v_customer_id;
      return v_customer_id;
    end if;
  end if;

  -- 3) Match por teléfono
  if nullif(trim(coalesce(v_psc.phone, '')), '') is not null then
    select c.id into v_customer_id
    from public.customers c
    where nullif(trim(coalesce(c.phone, '')), '') is not null
      and trim(c.phone) = trim(v_psc.phone)
    order by c.created_by_admin desc nulls last
    limit 1;

    if v_customer_id is not null then
      update public.customers
      set public_sales_customer_id = coalesce(public_sales_customer_id, v_psc.id)
      where id = v_customer_id;
      return v_customer_id;
    end if;
  end if;

  -- 4) Match por email
  if nullif(trim(coalesce(v_psc.email, '')), '') is not null then
    select c.id into v_customer_id
    from public.customers c
    where nullif(trim(coalesce(c.email, '')), '') is not null
      and lower(trim(c.email)) = lower(trim(v_psc.email))
    order by c.created_by_admin desc nulls last
    limit 1;

    if v_customer_id is not null then
      update public.customers
      set public_sales_customer_id = coalesce(public_sales_customer_id, v_psc.id)
      where id = v_customer_id;
      return v_customer_id;
    end if;
  end if;

  -- 5) Crear customer admin (sin auth user)
  v_full_name := trim(both from concat_ws(' ', v_psc.first_name, v_psc.last_name));
  if v_full_name = '' then
    v_full_name := 'Cliente local';
  end if;

  insert into public.customers (
    id,
    full_name,
    phone,
    dni,
    email,
    created_by_admin,
    public_sales_customer_id
  ) values (
    gen_random_uuid(),
    v_full_name,
    nullif(trim(coalesce(v_psc.phone, '')), ''),
    nullif(trim(coalesce(v_psc.document_number, '')), ''),
    nullif(trim(coalesce(v_psc.email, '')), ''),
    true,
    v_psc.id
  )
  returning id into v_customer_id;

  return v_customer_id;
end;
$$;

revoke all on function fyl_private.resolve_customer_for_public_sales(uuid) from public, anon, authenticated;
grant execute on function fyl_private.resolve_customer_for_public_sales(uuid) to service_role;

-- Espejo local_orders → orders (Retiro / Apartados). Soft-fail.
create or replace function public.rpc_mirror_local_order_to_retiro(
  p_local_order_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_uid uuid := auth.uid();
  v_is_admin boolean;
  v_lo record;
  v_customer_id uuid;
  v_open_id uuid;
  v_order_id uuid;
  v_order_number text;
  v_notes jsonb;
  v_item record;
  v_transport_id uuid;
  v_norm_size text;
begin
  if v_uid is null then
    raise exception 'rpc_mirror_local_order_to_retiro: no autenticado';
  end if;

  select exists (select 1 from public.admins a where a.user_id = v_uid)
  into v_is_admin;
  if not v_is_admin then
    raise exception 'rpc_mirror_local_order_to_retiro: solo administradores';
  end if;

  if p_local_order_id is null then
    return jsonb_build_object('ok', false, 'reason', 'missing_local_order_id');
  end if;

  select
    lo.id,
    lo.order_number,
    lo.customer_id,
    lo.source_order_id,
    lo.status,
    lo.total_amount,
    lo.notes
  into v_lo
  from public.local_orders lo
  where lo.id = p_local_order_id
  for update of lo;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'local_order_not_found');
  end if;

  if v_lo.source_order_id is not null then
    return jsonb_build_object(
      'ok', true,
      'replay', true,
      'order_id', v_lo.source_order_id,
      'reason', 'already_mirrored'
    );
  end if;

  if v_lo.status in ('completed', 'cancelled') then
    return jsonb_build_object('ok', false, 'reason', 'local_order_not_open', 'status', v_lo.status);
  end if;

  v_customer_id := fyl_private.resolve_customer_for_public_sales(v_lo.customer_id);
  if v_customer_id is null then
    return jsonb_build_object('ok', false, 'reason', 'customer_unresolved');
  end if;

  -- Soft-fail: un solo pedido abierto por cliente
  select o.id into v_open_id
  from public.orders o
  where o.customer_id = v_customer_id
    and o.status in ('active', 'closing_soon', 'closed')
  order by o.created_at desc
  limit 1;

  if v_open_id is not null then
    return jsonb_build_object(
      'ok', false,
      'reason', 'open_order_exists',
      'open_order_id', v_open_id,
      'customer_id', v_customer_id
    );
  end if;

  begin
    v_notes := coalesce(v_lo.notes::jsonb, '{}'::jsonb);
  exception when others then
    v_notes := '{}'::jsonb;
  end;

  v_notes := v_notes || jsonb_build_object(
    'kanban_scope', 'local_pickup',
    'local_order_id', v_lo.id,
    'local_order_number', v_lo.order_number,
    'mirrored_from_local_order', true
  );

  select t.id into v_transport_id
  from public.transports t
  where lower(trim(coalesce(t.name, ''))) in ('retira local', 'retiro de local', 'retiro local')
  order by case when lower(trim(t.name)) = 'retira local' then 0 else 1 end
  limit 1;

  if v_transport_id is not null then
    update public.customers
    set transport_id = coalesce(transport_id, v_transport_id)
    where id = v_customer_id
      and transport_id is null;
  end if;

  insert into public.orders (
    customer_id,
    status,
    total_amount,
    notes,
    source,
    created_by_user_id,
    local_deferred_pickup
  ) values (
    v_customer_id,
    'active',
    coalesce(v_lo.total_amount, 0),
    v_notes::text,
    'admin',
    v_uid,
    true
  )
  returning id, order_number into v_order_id, v_order_number;

  for v_item in
    select *
    from public.local_order_items loi
    where loi.local_order_id = v_lo.id
    order by loi.created_at asc
  loop
    v_norm_size := nullif(trim(coalesce(v_item.size, '')), '');
    if v_norm_size is not null and v_norm_size ~ '^\d+(\.\d+)?$' then
      v_norm_size := split_part(v_norm_size, '.', 1);
    end if;

    insert into public.order_items (
      order_id,
      variant_id,
      product_name,
      color,
      size,
      quantity,
      price_snapshot,
      imagen,
      status,
      admin_confirmed_missing
    ) values (
      v_order_id,
      v_item.variant_id,
      coalesce(nullif(trim(v_item.product_name), ''), 'Producto'),
      nullif(trim(coalesce(v_item.color, '')), ''),
      v_norm_size,
      greatest(1, coalesce(v_item.quantity, 1)),
      v_item.price_snapshot,
      v_item.imagen,
      -- Stock ya descontado en local_orders → Apartados
      'picked',
      false
    );
  end loop;

  update public.local_orders
  set source_order_id = v_order_id,
      updated_at = now()
  where id = v_lo.id;

  return jsonb_build_object(
    'ok', true,
    'order_id', v_order_id,
    'order_number', v_order_number,
    'customer_id', v_customer_id,
    'local_order_id', v_lo.id,
    'local_order_number', v_lo.order_number
  );
exception
  when unique_violation then
    return jsonb_build_object(
      'ok', false,
      'reason', 'open_order_exists_unique',
      'customer_id', v_customer_id
    );
end;
$$;

comment on function public.rpc_mirror_local_order_to_retiro(uuid) is
  'canonical:311 | Espeja local_orders → orders (Retiro/Apartados). Soft-fail si hay pedido abierto. Sin re-descuento de stock.';

revoke all on function public.rpc_mirror_local_order_to_retiro(uuid) from public, anon;
grant execute on function public.rpc_mirror_local_order_to_retiro(uuid) to authenticated, service_role;

-- Cierra el espejo Retiro cuando el pedido local se completa/cancela.
create or replace function public.rpc_close_mirrored_retiro_from_local_order(
  p_local_order_id uuid,
  p_payment_method text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_uid uuid := auth.uid();
  v_is_admin boolean;
  v_order_id uuid;
  v_status text;
begin
  if v_uid is null then
    raise exception 'rpc_close_mirrored_retiro_from_local_order: no autenticado';
  end if;
  select exists (select 1 from public.admins a where a.user_id = v_uid) into v_is_admin;
  if not v_is_admin then
    raise exception 'rpc_close_mirrored_retiro_from_local_order: solo administradores';
  end if;

  select lo.source_order_id into v_order_id
  from public.local_orders lo
  where lo.id = p_local_order_id;

  if v_order_id is null then
    return jsonb_build_object('ok', true, 'skipped', true, 'reason', 'no_mirror');
  end if;

  select o.status into v_status from public.orders o where o.id = v_order_id;
  if v_status is null then
    return jsonb_build_object('ok', true, 'skipped', true, 'reason', 'order_missing');
  end if;
  if v_status in ('sent', 'devolución', 'devolucion', 'expired') then
    return jsonb_build_object('ok', true, 'skipped', true, 'reason', 'already_final', 'status', v_status);
  end if;

  -- Preferir RPC de cierre si existe; fallback update.
  begin
    perform public.rpc_close_order(
      p_order_id := v_order_id,
      p_payment_method := coalesce(nullif(trim(p_payment_method), ''), 'Efectivo')
    );
  exception when undefined_function then
    update public.orders
    set status = 'closed',
        closed_at = coalesce(closed_at, now()),
        updated_at = now()
    where id = v_order_id;
  end;

  return jsonb_build_object('ok', true, 'order_id', v_order_id);
end;
$$;

revoke all on function public.rpc_close_mirrored_retiro_from_local_order(uuid, text) from public, anon;
grant execute on function public.rpc_close_mirrored_retiro_from_local_order(uuid, text) to authenticated, service_role;

-- Integrar mirror al final de rpc_create_local_order (misma lógica de stock; solo agrega espejo).
-- Se obtiene el cuerpo actual y se envuelve el return.
create or replace function public.rpc_create_local_order(
  p_customer_id uuid,
  p_items jsonb,
  p_extras jsonb default '{}'::jsonb
)
returns json
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $function$
declare
  v_local_order_id uuid;
  v_order_number text;
  v_total_amount numeric(12,2) := 0;
  v_item jsonb;
  v_item_total numeric;
  v_shipping numeric := 0;
  v_discount numeric := 0;
  v_extras_amount numeric := 0;
  v_extras_percentage numeric := 0;
  v_result json;
  v_mirror jsonb;
  v_variant_id uuid;
  v_quantity int;
  v_warehouse_venta_publico_id uuid;
  v_warehouse_general_id uuid;
  v_stock_venta_publico int;
  v_stock_general int;
  v_total_stock int;
  v_size text;
  v_normalized_size text;
  v_size_stock_vp int;
  v_size_stock_gen int;
  v_size_total_stock int;
  v_deduct_vp int;
  v_deduct_gen int;
  v_add_without_stock boolean;
  v_has_size_model boolean;
begin
  if not exists (select 1 from public.public_sales_customers where id = p_customer_id) then
    raise exception 'Cliente no encontrado';
  end if;

  select id into v_warehouse_venta_publico_id
  from public.warehouses where code = 'venta-publico' limit 1;
  select id into v_warehouse_general_id
  from public.warehouses where code = 'general' limit 1;

  if v_warehouse_venta_publico_id is null then
    raise exception 'Warehouse venta-publico no encontrado';
  end if;
  if v_warehouse_general_id is null then
    raise exception 'Warehouse general no encontrado';
  end if;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    if (v_item->>'variant_id')::text is not null
       and (v_item->>'variant_id')::text != 'null'
       and (v_item->>'variant_id')::text != '' then
      v_variant_id := (v_item->>'variant_id')::uuid;
      v_quantity := (v_item->>'quantity')::int;
      v_size := v_item->>'size';
      v_add_without_stock := (
        v_item->'source' is not null
        and coalesce((v_item->'source'->>'venta_publico')::int, 0) = 0
        and coalesce((v_item->'source'->>'general')::int, 0) = 0
        and v_quantity > 0
      );
      if v_size is not null and trim(v_size) <> '' then
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

        v_size_total_stock := coalesce(v_size_stock_vp, 0) + coalesce(v_size_stock_gen, 0);

        if v_size_total_stock < v_quantity and not v_add_without_stock then
          raise exception 'Stock insuficiente para % talle % (Cantidad: %, Disponible: % - venta-publico: %, general: %)',
            v_item->>'product_name', v_normalized_size, v_quantity, v_size_total_stock,
            coalesce(v_size_stock_vp, 0), coalesce(v_size_stock_gen, 0);
        end if;
      else
        select (
          exists (
            select 1 from public.variant_size_warehouse_stock
            where variant_id = v_variant_id limit 1
          )
          or exists (
            select 1 from public.variant_sizes
            where variant_id = v_variant_id
              and trim(coalesce(size, '')) <> ''
            limit 1
          )
        ) into v_has_size_model;

        if coalesce(v_has_size_model, false) then
          raise exception 'La variante % usa talles. Debes enviar size para operar stock.', v_variant_id;
        end if;

        select coalesce(stock_qty, 0) into v_stock_venta_publico
        from public.variant_warehouse_stock
        where variant_id = v_variant_id
          and warehouse_id = v_warehouse_venta_publico_id
        for update;

        select coalesce(stock_qty, 0) into v_stock_general
        from public.variant_warehouse_stock
        where variant_id = v_variant_id
          and warehouse_id = v_warehouse_general_id
        for update;

        v_total_stock := coalesce(v_stock_venta_publico, 0) + coalesce(v_stock_general, 0);

        if v_total_stock < v_quantity and not v_add_without_stock then
          raise exception 'Stock insuficiente para % (Cantidad: %, Disponible: % - venta-publico: %, general: %)',
            v_item->>'product_name', v_quantity, v_total_stock,
            coalesce(v_stock_venta_publico, 0), coalesce(v_stock_general, 0);
        end if;
      end if;
    end if;

    v_item_total := (v_item->>'quantity')::int * (v_item->>'price_snapshot')::numeric;
    v_total_amount := v_total_amount + v_item_total;
  end loop;

  if p_extras ? 'shipping' then
    v_shipping := (p_extras->>'shipping')::numeric;
    v_total_amount := v_total_amount + v_shipping;
  end if;
  if p_extras ? 'discount' then
    v_discount := (p_extras->>'discount')::numeric;
    v_total_amount := v_total_amount - v_discount;
  end if;
  if p_extras ? 'extras_amount' then
    v_extras_amount := (p_extras->>'extras_amount')::numeric;
    v_total_amount := v_total_amount + v_extras_amount;
  end if;
  if p_extras ? 'extras_percentage' then
    v_extras_percentage := (p_extras->>'extras_percentage')::numeric;
    v_total_amount := v_total_amount + (v_total_amount * v_extras_percentage / 100);
  end if;

  v_total_amount := greatest(v_total_amount, 0);
  v_order_number := public.generate_local_order_number();

  insert into public.local_orders (
    order_number, customer_id, status, total_amount, notes
  ) values (
    v_order_number,
    p_customer_id,
    'pending',
    v_total_amount,
    jsonb_build_object(
      'shipping', v_shipping,
      'discount', v_discount,
      'extras_amount', v_extras_amount,
      'extras_percentage', v_extras_percentage
    )::text
  )
  returning id into v_local_order_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    if (v_item->>'variant_id')::text is not null
       and (v_item->>'variant_id')::text != 'null'
       and (v_item->>'variant_id')::text != '' then
      v_variant_id := (v_item->>'variant_id')::uuid;
      v_quantity := (v_item->>'quantity')::int;
      v_size := v_item->>'size';
      v_add_without_stock := (
        v_item->'source' is not null
        and coalesce((v_item->'source'->>'venta_publico')::int, 0) = 0
        and coalesce((v_item->'source'->>'general')::int, 0) = 0
        and v_quantity > 0
      );

      if not v_add_without_stock then
        if v_size is not null and trim(v_size) <> '' then
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

          v_deduct_vp := least(v_quantity, coalesce(v_size_stock_vp, 0));
          v_deduct_gen := v_quantity - v_deduct_vp;

          insert into public.variant_size_warehouse_stock (variant_id, size, warehouse_id, stock_qty, updated_at)
          values (v_variant_id, v_normalized_size, v_warehouse_venta_publico_id, 0, now())
          on conflict (variant_id, size, warehouse_id) do nothing;
          insert into public.variant_size_warehouse_stock (variant_id, size, warehouse_id, stock_qty, updated_at)
          values (v_variant_id, v_normalized_size, v_warehouse_general_id, 0, now())
          on conflict (variant_id, size, warehouse_id)
          do update set
            stock_qty = greatest(public.variant_size_warehouse_stock.stock_qty, 0),
            updated_at = now();

          if v_deduct_vp > 0 then
            update public.variant_size_warehouse_stock
            set stock_qty = stock_qty - v_deduct_vp, updated_at = now()
            where variant_id = v_variant_id
              and size = v_normalized_size
              and warehouse_id = v_warehouse_venta_publico_id;
          end if;
          if v_deduct_gen > 0 then
            update public.variant_size_warehouse_stock
            set stock_qty = stock_qty - v_deduct_gen, updated_at = now()
            where variant_id = v_variant_id
              and size = v_normalized_size
              and warehouse_id = v_warehouse_general_id;
          end if;
        else
          select (
            exists (
              select 1 from public.variant_size_warehouse_stock
              where variant_id = v_variant_id limit 1
            )
            or exists (
              select 1 from public.variant_sizes
              where variant_id = v_variant_id
                and trim(coalesce(size, '')) <> ''
              limit 1
            )
          ) into v_has_size_model;

          if coalesce(v_has_size_model, false) then
            raise exception 'La variante % usa talles. Debes enviar size para descontar stock.', v_variant_id;
          end if;

          declare
            v_stock_vp int;
            v_stock_gen int;
          begin
            select coalesce(stock_qty, 0) into v_stock_vp
            from public.variant_warehouse_stock
            where variant_id = v_variant_id
              and warehouse_id = v_warehouse_venta_publico_id
            for update;

            select coalesce(stock_qty, 0) into v_stock_gen
            from public.variant_warehouse_stock
            where variant_id = v_variant_id
              and warehouse_id = v_warehouse_general_id
            for update;

            v_deduct_vp := least(v_quantity, coalesce(v_stock_vp, 0));
            v_deduct_gen := v_quantity - v_deduct_vp;

            if v_deduct_vp > 0 then
              insert into public.variant_warehouse_stock (variant_id, warehouse_id, stock_qty, updated_at)
              values (v_variant_id, v_warehouse_venta_publico_id, coalesce(v_stock_vp, 0) - v_deduct_vp, now())
              on conflict (variant_id, warehouse_id)
              do update set
                stock_qty = public.variant_warehouse_stock.stock_qty - v_deduct_vp,
                updated_at = now();
            end if;
            if v_deduct_gen > 0 then
              insert into public.variant_warehouse_stock (variant_id, warehouse_id, stock_qty, updated_at)
              values (v_variant_id, v_warehouse_general_id, coalesce(v_stock_gen, 0) - v_deduct_gen, now())
              on conflict (variant_id, warehouse_id)
              do update set
                stock_qty = public.variant_warehouse_stock.stock_qty - v_deduct_gen,
                updated_at = now();
            end if;
          end;
        end if;
      end if;
    end if;

    insert into public.local_order_items (
      local_order_id, variant_id, product_name, color, size,
      quantity, price_snapshot, imagen, status
    ) values (
      v_local_order_id,
      case when (v_item->>'variant_id')::text = 'null' or (v_item->>'variant_id')::text is null
           then null else (v_item->>'variant_id')::uuid end,
      v_item->>'product_name',
      v_item->>'color',
      v_item->>'size',
      (v_item->>'quantity')::int,
      (v_item->>'price_snapshot')::numeric,
      v_item->>'imagen',
      'pending'
    );
  end loop;

  -- Espejo Retiro (soft-fail; no rompe el alta del pedido local)
  begin
    v_mirror := public.rpc_mirror_local_order_to_retiro(v_local_order_id);
  exception when others then
    v_mirror := jsonb_build_object(
      'ok', false,
      'reason', 'mirror_exception',
      'error', SQLERRM
    );
  end;

  select json_build_object(
    'success', true,
    'local_order_id', v_local_order_id,
    'order_number', v_order_number,
    'total_amount', v_total_amount,
    'retiro_mirror', v_mirror
  ) into v_result;
  return v_result;
end
$function$;

comment on function public.rpc_create_local_order(uuid, jsonb, jsonb) is
  'canonical:311 | Crea local_order + descuenta stock + espeja a Retiro (Apartados) vía rpc_mirror_local_order_to_retiro (soft-fail).';
