-- 372: guard de admin en RPCs de caja, créditos y stock que cualquier authenticated podía ejecutar.
--
-- Contexto: docs/FYL-Obsidian/73-SUPABASE-ADVISORS-SECURITY-DEFINER-RLS-2026-10-08.md (fase 2)
--
-- Cada función recibe UNA línea nueva después del BEGIN principal:
--   PERFORM public.fyl_require_admin_or_internal();
-- El resto del cuerpo es el de producción al 2026-10-09 (pg_get_functiondef). Verificación:
--   md5(replace(prosrc, E'\n  PERFORM public.fyl_require_admin_or_internal();', '')) = md5 previo (en cada bloque).
--
-- El helper deja pasar: sin contexto JWT (cron, postgres, conexiones directas), service_role y admins.
-- Rechaza con 42501 a anon y authenticated no admin.
--
-- Además: cleanup_missing_order_item_sources, log_stock_change y rpc_move_stock quedan solo para
-- service_role (las llaman triggers/funciones DEFINER; ningún frontend).

BEGIN;

CREATE OR REPLACE FUNCTION public.fyl_require_admin_or_internal()
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $function$
DECLARE
  v_role text := coalesce(auth.role(), '');
BEGIN
  IF v_role = '' OR v_role = 'service_role' THEN
    RETURN;
  END IF;
  IF public.is_admin() THEN
    RETURN;
  END IF;
  RAISE EXCEPTION 'Solo administradores' USING ERRCODE = '42501';
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.fyl_require_admin_or_internal() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fyl_require_admin_or_internal() TO authenticated, service_role;

-- purchase_create_rule_version(uuid,jsonb) (md5 prosrc previo: 668103ed4dec7eb3e71e144b5d55f178)
CREATE OR REPLACE FUNCTION public.purchase_create_rule_version(p_supplier_id uuid, p_rules jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_next int;
  v_id uuid;
begin
  PERFORM public.fyl_require_admin_or_internal();
  if p_supplier_id is null or p_rules is null or jsonb_typeof(p_rules) <> 'object' then
    raise exception 'supplier_id y rules json objeto son obligatorios';
  end if;

  update public.purchase_supplier_rule_versions
  set is_active = false
  where supplier_id = p_supplier_id;

  select coalesce(max(version), 0) + 1 into v_next
  from public.purchase_supplier_rule_versions
  where supplier_id = p_supplier_id;

  insert into public.purchase_supplier_rule_versions (supplier_id, version, is_active, rules)
  values (p_supplier_id, v_next, true, p_rules)
  returning id into v_id;

  return v_id;
end;
$function$;

-- purchase_register_receipt(uuid,timestamp with time zone,text,text,jsonb) (md5 prosrc previo: 8189ce59e9a5948fdc15ebfc377f6428)
CREATE OR REPLACE FUNCTION public.purchase_register_receipt(p_order_id uuid, p_received_at timestamp with time zone, p_note text, p_source text, p_lines jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_rid uuid;
  v_line jsonb;
  v_oid uuid;
  v_qty numeric;
  v_pairs numeric;
  v_pending numeric;
  v_sum numeric;
begin
  PERFORM public.fyl_require_admin_or_internal();
  if p_order_id is null then
    return jsonb_build_object('ok', false, 'message', 'order_id obligatorio');
  end if;

  if not exists (select 1 from public.purchase_orders o where o.id = p_order_id) then
    return jsonb_build_object('ok', false, 'message', 'Pedido no existe');
  end if;

  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    return jsonb_build_object('ok', false, 'message', 'p_lines debe ser array no vacío');
  end if;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_oid := nullif(v_line ->> 'order_line_id', '')::uuid;
    v_qty := (v_line ->> 'qty_received')::numeric;
    v_pairs := coalesce((v_line ->> 'pairs_received')::numeric, 0);

    if v_oid is null or v_qty is null or v_qty <= 0 then
      return jsonb_build_object('ok', false, 'message', 'Cada línea requiere order_line_id y qty_received > 0');
    end if;

    if not exists (
      select 1 from public.purchase_order_lines pl
      join public.purchase_orders po on po.id = pl.order_id
      where pl.id = v_oid and po.id = p_order_id
    ) then
      return jsonb_build_object('ok', false, 'message', 'order_line_id no pertenece al pedido');
    end if;

    select coalesce(sum(rl.qty_received), 0) into v_sum
    from public.purchase_receipt_lines rl
    join public.purchase_receipts r on r.id = rl.receipt_id
    where rl.order_line_id = v_oid and r.order_id = p_order_id;

    select pl.qty_ordered into v_pending
    from public.purchase_order_lines pl where pl.id = v_oid;

    if v_sum + v_qty > v_pending + 0.0001 then
      return jsonb_build_object('ok', false, 'message', format('qty_received excede pendiente para línea %s', v_oid));
    end if;
  end loop;

  insert into public.purchase_receipts (order_id, received_at, note, source)
  values (
    p_order_id,
    coalesce(p_received_at, now()),
    p_note,
    coalesce(nullif(trim(p_source), ''), 'manual_admin')
  )
  returning id into v_rid;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_oid := nullif(v_line ->> 'order_line_id', '')::uuid;
    v_qty := (v_line ->> 'qty_received')::numeric;
    v_pairs := coalesce((v_line ->> 'pairs_received')::numeric, 0);
    insert into public.purchase_receipt_lines (receipt_id, order_line_id, qty_received, pairs_received, breakdown)
    values (v_rid, v_oid, v_qty, v_pairs, v_line -> 'breakdown');
  end loop;

  return jsonb_build_object('ok', true, 'receipt_id', v_rid);
end;
$function$;

-- rpc_add_customer_credit(uuid,numeric,text) (md5 prosrc previo: dcd8b560b9c1afab4a86e4535fb727d3)
CREATE OR REPLACE FUNCTION public.rpc_add_customer_credit(p_customer_id uuid, p_amount numeric, p_notes text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_credit_id uuid;
  v_expires_at timestamptz;
begin
  PERFORM public.fyl_require_admin_or_internal();
  if p_amount <= 0 then
    raise exception 'El monto del crédito debe ser mayor a 0';
  end if;

  -- Calcular fecha de expiración (6 meses)
  v_expires_at := now() + interval '6 months';

  insert into public.public_sales_customer_credits (
    customer_id,
    amount,
    expires_at,
    notes
  )
  values (
    p_customer_id,
    p_amount,
    v_expires_at,
    p_notes
  )
  returning id into v_credit_id;

  return json_build_object(
    'success', true,
    'credit_id', v_credit_id,
    'amount', p_amount,
    'expires_at', v_expires_at
  );
end $function$;

-- rpc_add_return_credit(uuid,numeric,text) (md5 prosrc previo: d4bdc1edf6681433107aeb52590a541c)
CREATE OR REPLACE FUNCTION public.rpc_add_return_credit(p_customer_id uuid, p_amount numeric, p_notes text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
begin
  PERFORM public.fyl_require_admin_or_internal();
  -- Los créditos de devolución también tienen 6 meses de validez
  return public.rpc_add_customer_credit(p_customer_id, p_amount, p_notes);
end $function$;

-- rpc_complete_pending_sale(uuid,uuid) (md5 prosrc previo: e4eb0584e0403153eca92e26fb46a88b)
CREATE OR REPLACE FUNCTION public.rpc_complete_pending_sale(p_pending_sale_id uuid, p_sale_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_current_status text;
  v_current_user uuid;
begin
  PERFORM public.fyl_require_admin_or_internal();
  -- Obtener usuario actual
  v_current_user := auth.uid();

  -- Obtener estado actual
  select status into v_current_status
  from public.pending_sales
  where id = p_pending_sale_id;

  -- Verificar que existe
  if v_current_status is null then
    raise exception 'Compra pendiente no encontrada';
  end if;

  -- Actualizar estado a completada
  update public.pending_sales
  set 
    status = 'completed',
    processed_at = now(),
    processed_by = v_current_user,
    sale_data = jsonb_set(
      sale_data,
      '{final_sale_id}',
      to_jsonb(p_sale_id::text)
    )
  where id = p_pending_sale_id;

  return true;
end $function$;

-- rpc_copy_customer_to_local(uuid) (md5 prosrc previo: 1b3fb9ed06cdcc4153630d59d0decd04)
CREATE OR REPLACE FUNCTION public.rpc_copy_customer_to_local(p_customer_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog, public'
AS $function$
declare
  v_customer_record record;
  v_local_customer_id uuid;
  v_customer_number text;
  v_qr_code uuid;
  v_result json;
begin
  PERFORM public.fyl_require_admin_or_internal();
  -- Obtener datos del cliente original
  select 
    c.id,
    c.full_name,
    c.phone,
    c.email,
    c.dni,
    c.city,
    c.province
  into v_customer_record
  from public.customers c
  where c.id = p_customer_id;

  if v_customer_record is null then
    raise exception 'Cliente no encontrado';
  end if;

  -- Verificar si el cliente ya existe en public_sales_customers por DNI o email
  if v_customer_record.dni is not null then
    select id into v_local_customer_id
    from public.public_sales_customers
    where document_number = v_customer_record.dni
    limit 1;
  end if;

  if v_local_customer_id is null and v_customer_record.email is not null then
    select id into v_local_customer_id
    from public.public_sales_customers
    where email = v_customer_record.email
    limit 1;
  end if;

  -- Si ya existe, retornar su ID
  if v_local_customer_id is not null then
    select json_build_object(
      'success', true,
      'customer_id', v_local_customer_id,
      'already_exists', true
    ) into v_result;
    return v_result;
  end if;

  -- Separar nombre y apellido
  declare
    name_parts text[];
    first_name text;
    last_name text;
  begin
    name_parts := string_to_array(trim(v_customer_record.full_name), ' ');
    if array_length(name_parts, 1) > 1 then
      first_name := array_to_string(name_parts[1:array_length(name_parts, 1) - 1], ' ');
      last_name := name_parts[array_length(name_parts, 1)];
    else
      first_name := v_customer_record.full_name;
      last_name := null;
    end if;

    -- Generar número de cliente
    v_customer_number := public.generate_customer_number();
    
    -- Generar QR code
    v_qr_code := gen_random_uuid();

    -- Crear cliente en public_sales_customers
    insert into public.public_sales_customers (
      customer_number,
      first_name,
      last_name,
      phone,
      email,
      document_number,
      qr_code
    )
    values (
      v_customer_number,
      first_name,
      last_name,
      v_customer_record.phone,
      v_customer_record.email,
      v_customer_record.dni,
      v_qr_code
    )
    returning id into v_local_customer_id;

    select json_build_object(
      'success', true,
      'customer_id', v_local_customer_id,
      'customer_number', v_customer_number,
      'qr_code', v_qr_code,
      'already_exists', false
    ) into v_result;
    return v_result;
  end;
end $function$;

-- rpc_create_local_order(uuid,jsonb,jsonb) (md5 prosrc previo: 78be98a6dded3d355f0b858d3f9df455)
CREATE OR REPLACE FUNCTION public.rpc_create_local_order(p_customer_id uuid, p_items jsonb, p_extras jsonb DEFAULT '{}'::jsonb)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
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
  PERFORM public.fyl_require_admin_or_internal();
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

-- rpc_create_pending_sale(integer,jsonb) (md5 prosrc previo: 904d9665dc7d2283cb1a2f1171d6e3db)
CREATE OR REPLACE FUNCTION public.rpc_create_pending_sale(p_source_caja integer, p_sale_data jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_pending_id uuid;
begin
  PERFORM public.fyl_require_admin_or_internal();
  -- Validar que source_caja sea 2 o 3
  if p_source_caja not in (2, 3) then
    raise exception 'source_caja debe ser 2 o 3';
  end if;

  -- Insertar compra pendiente
  insert into public.pending_sales (source_caja, sale_data, status)
  values (p_source_caja, p_sale_data, 'pending')
  returning id into v_pending_id;

  return v_pending_id;
end $function$;

-- rpc_create_public_customer(text,text,text,text,text) (md5 prosrc previo: 52426b96255a76b1f5cae982cedcfe38)
CREATE OR REPLACE FUNCTION public.rpc_create_public_customer(p_first_name text, p_last_name text DEFAULT NULL::text, p_phone text DEFAULT NULL::text, p_email text DEFAULT NULL::text, p_document_number text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_customer_id uuid;
  v_customer_number text;
  v_qr_code uuid;
begin
  PERFORM public.fyl_require_admin_or_internal();
  -- Validar nombre
  if p_first_name is null or trim(p_first_name) = '' then
    raise exception 'El nombre es obligatorio';
  end if;

  -- Generar número de cliente
  v_customer_number := public.generate_customer_number();
  
  -- Generar QR code (UUID)
  v_qr_code := gen_random_uuid();

  -- Crear cliente
  insert into public.public_sales_customers (
    customer_number,
    first_name,
    last_name,
    phone,
    email,
    document_number,
    qr_code
  )
  values (
    v_customer_number,
    trim(p_first_name),
    trim(p_last_name),
    trim(p_phone),
    trim(p_email),
    trim(p_document_number),
    v_qr_code
  )
  returning id, customer_number, qr_code into v_customer_id, v_customer_number, v_qr_code;

  return json_build_object(
    'success', true,
    'customer_id', v_customer_id,
    'customer_number', v_customer_number,
    'qr_code', v_qr_code
  );
end $function$;

-- rpc_get_customer_total_credit(uuid) (md5 prosrc previo: 0798e6d6064f3c9fcbfbc10a9d8e1f5e)
CREATE OR REPLACE FUNCTION public.rpc_get_customer_total_credit(p_customer_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_total numeric;
begin
  PERFORM public.fyl_require_admin_or_internal();
  select coalesce(sum(amount), 0) into v_total
  from public.public_sales_customer_credits
  where customer_id = p_customer_id
    and expires_at > now()
    and amount > 0;

  return coalesce(v_total, 0);
end $function$;

-- rpc_get_local_order_items(uuid) (md5 prosrc previo: ba505fe7408d9c2fc52895f112bd0ae8)
CREATE OR REPLACE FUNCTION public.rpc_get_local_order_items(p_local_order_id uuid)
 RETURNS TABLE(id uuid, variant_id uuid, product_name text, color text, size text, quantity integer, price_snapshot numeric, imagen text, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
begin
  PERFORM public.fyl_require_admin_or_internal();
  return query
  select 
    loi.id,
    loi.variant_id,
    loi.product_name,
    loi.color,
    loi.size,
    loi.quantity,
    loi.price_snapshot,
    loi.imagen,
    loi.status
  from public.local_order_items loi
  where loi.local_order_id = p_local_order_id
  order by loi.created_at;
end $function$;

-- rpc_get_local_orders(text,uuid) (md5 prosrc previo: 588d869f3ef79b2eefd27c7ce05b41b2)
CREATE OR REPLACE FUNCTION public.rpc_get_local_orders(p_status text DEFAULT NULL::text, p_source_order_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, order_number text, customer_id uuid, customer_number text, customer_name text, customer_phone text, customer_document_number text, source_order_id uuid, status text, total_amount numeric, notes text, created_at timestamp with time zone, updated_at timestamp with time zone, item_count bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
begin
  PERFORM public.fyl_require_admin_or_internal();
  return query
  select 
    lo.id,
    lo.order_number,
    lo.customer_id,
    psc.customer_number,
    (psc.first_name || ' ' || coalesce(psc.last_name, ''))::text as customer_name,
    psc.phone as customer_phone,
    psc.document_number as customer_document_number,
    lo.source_order_id,
    lo.status,
    lo.total_amount,
    lo.notes,
    lo.created_at,
    lo.updated_at,
    count(loi.id) as item_count
  from public.local_orders lo
  inner join public.public_sales_customers psc on lo.customer_id = psc.id
  left join public.local_order_items loi on lo.id = loi.local_order_id
  where 
    (p_status is null or lo.status = p_status)
    and (p_source_order_id is null or lo.source_order_id = p_source_order_id)
    -- Excluir pedidos completados y cancelados
    and lo.status not in ('completed', 'cancelled')
  group by lo.id, lo.order_number, lo.customer_id, psc.customer_number, psc.first_name, psc.last_name, 
           psc.phone, psc.document_number, lo.source_order_id, lo.status, lo.total_amount, lo.notes, lo.created_at, lo.updated_at
  order by lo.created_at desc;
end $function$;

-- rpc_get_pending_sales() (md5 prosrc previo: c01ef9a56a70e2e4f645b1fffadf1788)
CREATE OR REPLACE FUNCTION public.rpc_get_pending_sales()
 RETURNS TABLE(id uuid, source_caja integer, sale_data jsonb, status text, created_at timestamp with time zone, processed_at timestamp with time zone, processed_by uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
begin
  PERFORM public.fyl_require_admin_or_internal();
  return query
  select 
    ps.id,
    ps.source_caja,
    ps.sale_data,
    ps.status,
    ps.created_at,
    ps.processed_at,
    ps.processed_by
  from public.pending_sales ps
  where ps.status = 'pending'
    -- Excluir pedidos locales (source_caja = 1 con local_order_id en sale_data)
    and not (ps.source_caja = 1 and ps.sale_data ? 'local_order_id')
  order by ps.created_at asc;
end $function$;

-- rpc_get_public_sales_history(integer,integer,date,text) (md5 prosrc previo: 28fe4464c62b812a01be2f85ba58ec89)
CREATE OR REPLACE FUNCTION public.rpc_get_public_sales_history(p_limit integer DEFAULT 10, p_offset integer DEFAULT 0, p_date_filter date DEFAULT NULL::date, p_customer_search text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_result json;
begin
  PERFORM public.fyl_require_admin_or_internal();
  select json_agg(
    json_build_object(
      'id', ps.id,
      'sale_number', ps.sale_number,
      'created_at', ps.created_at,
      'customer_name', 
        case 
          when psc.first_name is not null 
          then psc.first_name || ' ' || coalesce(psc.last_name, '')
          else null
        end,
      'total_amount', ps.total_amount,
      'item_count', ps.item_count,
      'credit_used', ps.credit_used
    )
    order by ps.created_at desc
  ) into v_result
  from (
    select ps.id, ps.sale_number, ps.created_at, ps.total_amount, ps.item_count, ps.credit_used, ps.customer_id
    from public.public_sales ps
    left join public.public_sales_customers psc on psc.id = ps.customer_id
    where 
      (p_date_filter is null or date(ps.created_at) = p_date_filter)
      and (
        p_customer_search is null 
        or p_customer_search = ''
        or (
          psc.first_name ilike '%' || p_customer_search || '%'
          or psc.last_name ilike '%' || p_customer_search || '%'
          or (psc.first_name || ' ' || coalesce(psc.last_name, '')) ilike '%' || p_customer_search || '%'
        )
      )
    order by ps.created_at desc
    limit p_limit
    offset p_offset
  ) ps
  left join public.public_sales_customers psc on psc.id = ps.customer_id;

  return coalesce(v_result, '[]'::json);
end $function$;

-- rpc_get_public_sales_history(integer,integer) (md5 prosrc previo: ba96974bf87e5080f7817ddda230abf2)
CREATE OR REPLACE FUNCTION public.rpc_get_public_sales_history(p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_result json;
begin
  PERFORM public.fyl_require_admin_or_internal();
  select json_agg(
    json_build_object(
      'id', ps.id,
      'sale_number', ps.sale_number,
      'created_at', ps.created_at,
      'customer_name', 
        case 
          when psc.first_name is not null 
          then psc.first_name || ' ' || coalesce(psc.last_name, '')
          else null
        end,
      'total_amount', ps.total_amount,
      'item_count', ps.item_count,
      'credit_used', ps.credit_used
    )
    order by ps.created_at desc
  ) into v_result
  from (
    select ps.id, ps.sale_number, ps.created_at, ps.total_amount, ps.item_count, ps.credit_used, ps.customer_id
    from public.public_sales ps
    order by ps.created_at desc
    limit p_limit
    offset p_offset
  ) ps
  left join public.public_sales_customers psc on psc.id = ps.customer_id;

  return coalesce(v_result, '[]'::json);
end $function$;

-- rpc_load_local_order_to_sale(uuid) (md5 prosrc previo: 11bcb528774facd1e4c243b72b72a1c5)
CREATE OR REPLACE FUNCTION public.rpc_load_local_order_to_sale(p_local_order_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_order_record record;
  v_items jsonb;
  v_sale_data jsonb;
  v_pending_sale_id uuid;
  v_result json;
begin
  PERFORM public.fyl_require_admin_or_internal();
  -- Obtener pedido y items
  select 
    lo.*,
    psc.first_name,
    psc.last_name,
    psc.phone,
    psc.email,
    psc.document_number
  into v_order_record
  from public.local_orders lo
  inner join public.public_sales_customers psc on lo.customer_id = psc.id
  where lo.id = p_local_order_id;

  if v_order_record is null then
    raise exception 'Pedido local no encontrado';
  end if;

  -- Obtener items como JSON (incluyendo el ID del item para poder liberar stock si se elimina)
  select jsonb_agg(
    jsonb_build_object(
      'id', loi.id,
      'product_name', loi.product_name,
      'color', loi.color,
      'size', loi.size,
      'quantity', loi.quantity,
      'price_snapshot', loi.price_snapshot,
      'variant_id', loi.variant_id,
      'imagen', loi.imagen
    )
  )
  into v_items
  from public.local_order_items loi
  where loi.local_order_id = p_local_order_id;

  -- Construir sale_data similar a pending_sales
  v_sale_data := jsonb_build_object(
    'customer', jsonb_build_object(
      'id', v_order_record.customer_id,
      'first_name', v_order_record.first_name,
      'last_name', v_order_record.last_name,
      'phone', v_order_record.phone,
      'email', v_order_record.email,
      'document_number', v_order_record.document_number
    ),
    'items', coalesce(v_items, '[]'::jsonb),
    'total_amount', v_order_record.total_amount,
    'notes', v_order_record.notes,
    'local_order_id', p_local_order_id
  );

  -- Crear compra pendiente con source_caja = 1 (caja 1, pero viene de pedido local)
  -- El flag 'local_order_id' en sale_data indica que viene de un pedido local
  insert into public.pending_sales (
    source_caja,
    sale_data,
    status
  )
  values (
    1,
    v_sale_data,
    'pending'
  )
  returning id into v_pending_sale_id;

  -- Actualizar estado del pedido local a 'ready'
  update public.local_orders
  set status = 'ready', updated_at = now()
  where id = p_local_order_id;

  select json_build_object(
    'success', true,
    'sale_data', v_sale_data,
    'pending_sale_id', v_pending_sale_id
  ) into v_result;
  return v_result;
end $function$;

-- rpc_mark_order_as_devolucion(uuid,uuid,jsonb) (md5 prosrc previo: 3558db1ef298a345d420d5a6f58b00a5)
CREATE OR REPLACE FUNCTION public.rpc_mark_order_as_devolucion(p_order_id uuid, p_operation_id uuid, p_request jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_operation_request jsonb;
  v_prev_result jsonb;
  v_result jsonb;

  v_err_msg text;
  v_err_state text;
  v_err_detail text;
  v_err_hint text;
begin
  PERFORM public.fyl_require_admin_or_internal();
  if p_order_id is null then
    raise exception 'rpc_mark_order_as_devolucion: p_order_id es obligatorio'
      using errcode = '22023';
  end if;

  if p_operation_id is null then
    raise exception 'rpc_mark_order_as_devolucion: p_operation_id es obligatorio'
      using errcode = '22023';
  end if;

  -- Fingerprint canónico: incluir siempre order_id, además de metadata opcional.
  v_operation_request := coalesce(p_request, '{}'::jsonb)
    || jsonb_build_object('order_id', p_order_id);

  v_prev_result := public.rpc_operations_begin(
    p_operation_id => p_operation_id,
    p_operation_kind => 'mark_order_as_devolucion',
    p_request => v_operation_request,
    p_target_type => 'order',
    p_target_id => p_order_id::text
  );

  -- Replay de completed: devolver resultado previo exacto.
  if v_prev_result is not null then
    return coalesce(v_prev_result, '{}'::jsonb) || jsonb_build_object('idempotent_replay', true);
  end if;

  begin
    -- Dominio intacto: ejecutar lógica existente (locks, validaciones, stock, estado).
    perform public.rpc_mark_order_as_devolucion(p_order_id);

    v_result := jsonb_build_object(
      'ok', true,
      'order_id', p_order_id,
      'status', 'devolución'
    );

    v_result := coalesce(v_result, '{}'::jsonb) || jsonb_build_object('idempotent_replay', false);
    return public.rpc_operations_complete(p_operation_id, v_result);
  exception
    when others then
      get stacked diagnostics
        v_err_msg = message_text,
        v_err_state = returned_sqlstate,
        v_err_detail = pg_exception_detail,
        v_err_hint = pg_exception_hint;

      begin
        perform public.rpc_operations_fail(
          p_operation_id,
          jsonb_build_object(
            'message', v_err_msg,
            'sqlstate', v_err_state,
            'detail', v_err_detail,
            'hint', v_err_hint
          )
        );
      exception
        when others then
          -- No ocultar nunca el error original de dominio.
          null;
      end;

      raise;
  end;
end;
$function$;

-- rpc_mark_order_items_picked(uuid[],uuid,jsonb) (md5 prosrc previo: f46be35450315156ba4b90637fbddc1d)
CREATE OR REPLACE FUNCTION public.rpc_mark_order_items_picked(p_order_item_ids uuid[], p_operation_id uuid, p_request jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_operation_request jsonb;
  v_prev_result       jsonb;
  v_result            jsonb;

  v_existing_ids      uuid[];
  v_unknown_ids       uuid[];
  v_cancelled_ids     uuid[];
  v_updatable_ids     uuid[];
  v_updated_count     int;
  v_item_id           uuid;
  v_order_id          uuid;

  v_err_msg    text;
  v_err_state  text;
  v_err_detail text;
  v_err_hint   text;
BEGIN
  PERFORM public.fyl_require_admin_or_internal();
  IF p_operation_id IS NULL THEN
    RAISE EXCEPTION 'rpc_mark_order_items_picked: p_operation_id es obligatorio'
      USING errcode = '22023';
  END IF;

  IF p_order_item_ids IS NULL OR array_length(p_order_item_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'rpc_mark_order_items_picked: p_order_item_ids no puede estar vacío'
      USING errcode = '22023';
  END IF;

  v_operation_request := coalesce(p_request, '{}'::jsonb)
    || jsonb_build_object(
         'item_ids', (
           SELECT jsonb_agg(x ORDER BY x)
           FROM unnest(p_order_item_ids) AS x
         )
       );

  v_prev_result := public.rpc_operations_begin(
    p_operation_id   => p_operation_id,
    p_operation_kind => 'mark_order_items_picked',
    p_request        => v_operation_request,
    p_target_type    => 'order_items',
    p_target_id      => null
  );

  IF v_prev_result IS NOT NULL THEN
    RETURN coalesce(v_prev_result, '{}'::jsonb)
      || jsonb_build_object('idempotent_replay', true);
  END IF;

  BEGIN
    SELECT array_agg(id)
      INTO v_existing_ids
    FROM public.order_items
    WHERE id = ANY(p_order_item_ids);

    v_unknown_ids := ARRAY(
      SELECT unnest(p_order_item_ids)
      EXCEPT
      SELECT unnest(coalesce(v_existing_ids, '{}'))
    );

    IF array_length(v_unknown_ids, 1) > 0 THEN
      RAISE EXCEPTION
        'rpc_mark_order_items_picked: los siguientes order_item_ids no existen: %',
        v_unknown_ids
        USING errcode = '02000';
    END IF;

    SELECT array_agg(id)
      INTO v_cancelled_ids
    FROM public.order_items
    WHERE id = ANY(p_order_item_ids)
      AND status = 'cancelled';

    IF array_length(v_cancelled_ids, 1) > 0 THEN
      RAISE EXCEPTION
        'rpc_mark_order_items_picked: no se pueden marcar como picked items cancelados: %',
        v_cancelled_ids
        USING errcode = '23000';
    END IF;

    -- 1) Commit stock diferido (awaiting_apartado → sources)
    FOREACH v_item_id IN ARRAY p_order_item_ids LOOP
      PERFORM public.fn_commit_deferred_order_item_stock(v_item_id);
    END LOOP;

    -- 2) Pasar a picked
    SELECT array_agg(id)
      INTO v_updatable_ids
    FROM public.order_items
    WHERE id = ANY(p_order_item_ids)
      AND status NOT IN ('picked', 'cancelled');

    IF v_updatable_ids IS NOT NULL AND array_length(v_updatable_ids, 1) > 0 THEN
      UPDATE public.order_items
      SET
        status     = 'picked',
        updated_at = now()
      WHERE id = ANY(v_updatable_ids)
        AND status IN ('reserved', 'waiting', 'awaiting_apartado');

      GET DIAGNOSTICS v_updated_count = ROW_COUNT;
    ELSE
      v_updated_count := 0;
    END IF;

    -- 3) Timer 36h al primer apartado (después de picked)
    FOREACH v_item_id IN ARRAY p_order_item_ids LOOP
      SELECT oi.order_id INTO v_order_id FROM public.order_items oi WHERE oi.id = v_item_id;
      IF v_order_id IS NOT NULL THEN
        PERFORM public.fn_start_local_pickup_timer_if_needed(v_order_id);
      END IF;
    END LOOP;

    v_result := jsonb_build_object(
      'ok',            true,
      'updated_count', v_updated_count,
      'skipped_count', array_length(p_order_item_ids, 1) - v_updated_count,
      'idempotent_replay', false
    );

    RETURN public.rpc_operations_complete(p_operation_id, v_result);

  EXCEPTION
    WHEN others THEN
      GET STACKED DIAGNOSTICS
        v_err_msg    = message_text,
        v_err_state  = returned_sqlstate,
        v_err_detail = pg_exception_detail,
        v_err_hint   = pg_exception_hint;

      BEGIN
        PERFORM public.rpc_operations_fail(
          p_operation_id,
          jsonb_build_object(
            'message',  v_err_msg,
            'sqlstate', v_err_state,
            'detail',   v_err_detail,
            'hint',     v_err_hint
          )
        );
      EXCEPTION
        WHEN others THEN NULL;
      END;

      RAISE;
  END;
END;
$function$;

-- rpc_mark_pending_sale_processing(uuid) (md5 prosrc previo: 1388165544ae14588a51af14259c74a2)
CREATE OR REPLACE FUNCTION public.rpc_mark_pending_sale_processing(p_pending_sale_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_current_status text;
begin
  PERFORM public.fyl_require_admin_or_internal();
  -- Obtener estado actual
  select status into v_current_status
  from public.pending_sales
  where id = p_pending_sale_id;

  -- Verificar que existe y está pendiente
  if v_current_status is null then
    raise exception 'Compra pendiente no encontrada';
  end if;

  if v_current_status != 'pending' then
    raise exception 'La compra ya está siendo procesada o fue completada';
  end if;

  -- Actualizar estado
  update public.pending_sales
  set status = 'processing'
  where id = p_pending_sale_id;

  return true;
end $function$;

-- rpc_move_size_stock(uuid,text,text,text,integer,text,uuid,jsonb) (md5 prosrc previo: 216b359907c12a810a217e1edc185cf3)
CREATE OR REPLACE FUNCTION public.rpc_move_size_stock(p_variant_id uuid, p_size text, p_from_warehouse_code text, p_to_warehouse_code text, p_quantity integer, p_notes text, p_operation_id uuid, p_request jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_operation_request jsonb;
  v_prev_result jsonb;
  v_result jsonb;

  v_err_msg text;
  v_err_state text;
  v_err_detail text;
  v_err_hint text;
begin
  PERFORM public.fyl_require_admin_or_internal();
  if p_operation_id is null then
    raise exception 'rpc_move_size_stock: p_operation_id es obligatorio'
      using errcode = '22023';
  end if;

  -- Fingerprint canónico: incluir SIEMPRE los argumentos de dominio.
  v_operation_request := coalesce(p_request, '{}'::jsonb)
    || jsonb_build_object(
      'variant_id', p_variant_id,
      'size', p_size,
      'from_warehouse_code', p_from_warehouse_code,
      'to_warehouse_code', p_to_warehouse_code,
      'quantity', p_quantity,
      'notes', p_notes
    );

  v_prev_result := public.rpc_operations_begin(
    p_operation_id => p_operation_id,
    p_operation_kind => 'move_size_stock',
    p_request => v_operation_request,
    p_target_type => 'variant_size_stock',
    p_target_id => coalesce(p_variant_id::text, null)
  );

  -- Replay de completed: devolver resultado previo exacto.
  if v_prev_result is not null then
    return coalesce(v_prev_result, '{}'::jsonb) || jsonb_build_object('idempotent_replay', true);
  end if;

  begin
    -- Dominio intacto: ejecutar lógica existente (validaciones, locks, movimiento, trazabilidad).
    v_result := public.rpc_move_size_stock(
      p_variant_id,
      p_size,
      p_from_warehouse_code,
      p_to_warehouse_code,
      p_quantity,
      p_notes
    )::jsonb;

    v_result := coalesce(v_result, '{}'::jsonb) || jsonb_build_object('idempotent_replay', false);
    return public.rpc_operations_complete(p_operation_id, v_result);
  exception
    when others then
      get stacked diagnostics
        v_err_msg = message_text,
        v_err_state = returned_sqlstate,
        v_err_detail = pg_exception_detail,
        v_err_hint = pg_exception_hint;

      begin
        perform public.rpc_operations_fail(
          p_operation_id,
          jsonb_build_object(
            'message', v_err_msg,
            'sqlstate', v_err_state,
            'detail', v_err_detail,
            'hint', v_err_hint
          )
        );
      exception
        when others then
          -- No ocultar nunca el error original de dominio.
          null;
      end;

      raise;
  end;
end;
$function$;

-- rpc_move_size_stock(uuid,text,text,text,integer,text) (md5 prosrc previo: fe53fcd33350334b9cf8b1f4e0c21bbf)
CREATE OR REPLACE FUNCTION public.rpc_move_size_stock(p_variant_id uuid, p_size text, p_from_warehouse_code text, p_to_warehouse_code text, p_quantity integer, p_notes text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_from_warehouse_id uuid;
  v_to_warehouse_id uuid;
  v_available_stock int;
  v_user_id uuid;
  v_movement_id uuid;
  v_result json;
  v_normalized_size text;
begin
  PERFORM public.fyl_require_admin_or_internal();
  if p_quantity <= 0 then
    raise exception 'La cantidad debe ser mayor a 0';
  end if;

  v_normalized_size := trim(both ' ' from p_size);
  if v_normalized_size ~ '^\d+(\.\d+)?$' then
    v_normalized_size := split_part(v_normalized_size, '.', 1);
  end if;

  if v_normalized_size is null or v_normalized_size = '' then
    raise exception 'El tamaño no puede estar vacío';
  end if;

  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  select id into v_from_warehouse_id
  from public.warehouses
  where code = p_from_warehouse_code;

  if v_from_warehouse_id is null then
    raise exception 'Almacén origen no encontrado: %', p_from_warehouse_code;
  end if;

  select id into v_to_warehouse_id
  from public.warehouses
  where code = p_to_warehouse_code;

  if v_to_warehouse_id is null then
    raise exception 'Almacén destino no encontrado: %', p_to_warehouse_code;
  end if;

  if v_from_warehouse_id = v_to_warehouse_id then
    raise exception 'El almacén origen y destino no pueden ser el mismo';
  end if;

  select coalesce(stock_qty, 0) into v_available_stock
  from public.variant_size_warehouse_stock
  where variant_id = p_variant_id
    and size = v_normalized_size
    and warehouse_id = v_from_warehouse_id;

  if v_available_stock < p_quantity then
    raise exception
      'Stock insuficiente en almacén origen para talle %. Disponible: %, Solicitado: %',
      v_normalized_size, v_available_stock, p_quantity;
  end if;

  perform 1
  from public.variant_size_warehouse_stock
  where variant_id = p_variant_id
    and size = v_normalized_size
    and warehouse_id in (v_from_warehouse_id, v_to_warehouse_id)
  for update;

  update public.variant_size_warehouse_stock
  set stock_qty = stock_qty - p_quantity,
      updated_at = now()
  where variant_id = p_variant_id
    and size = v_normalized_size
    and warehouse_id = v_from_warehouse_id;

  insert into public.variant_size_warehouse_stock (variant_id, size, warehouse_id, stock_qty)
  select p_variant_id, v_normalized_size, v_from_warehouse_id, 0
  where not exists (
    select 1
    from public.variant_size_warehouse_stock
    where variant_id = p_variant_id
      and size = v_normalized_size
      and warehouse_id = v_from_warehouse_id
  );

  insert into public.variant_size_warehouse_stock (variant_id, size, warehouse_id, stock_qty)
  values (p_variant_id, v_normalized_size, v_to_warehouse_id, p_quantity)
  on conflict (variant_id, size, warehouse_id)
  do update set
    stock_qty = variant_size_warehouse_stock.stock_qty + p_quantity,
    updated_at = now();

  insert into public.stock_movements (
    variant_id,
    size,
    from_warehouse_id,
    to_warehouse_id,
    qty,
    moved_by,
    notes
  )
  values (
    p_variant_id,
    v_normalized_size,
    v_from_warehouse_id,
    v_to_warehouse_id,
    p_quantity,
    v_user_id,
    p_notes
  )
  returning id into v_movement_id;

  select json_build_object(
    'success', true,
    'movement_id', v_movement_id,
    'from_warehouse', p_from_warehouse_code,
    'to_warehouse', p_to_warehouse_code,
    'size', v_normalized_size,
    'quantity', p_quantity,
    'from_stock_after', v_available_stock - p_quantity,
    'to_stock_after', (
      select coalesce(stock_qty, 0)
      from public.variant_size_warehouse_stock
      where variant_id = p_variant_id
        and size = v_normalized_size
        and warehouse_id = v_to_warehouse_id
    )
  ) into v_result;

  return v_result;
end $function$;

-- rpc_search_public_customer(text) (md5 prosrc previo: e2ebd7f1345a12016fd8563c5e371636)
CREATE OR REPLACE FUNCTION public.rpc_search_public_customer(p_search_term text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_result json;
begin
  PERFORM public.fyl_require_admin_or_internal();
  select json_agg(
    json_build_object(
      'id', id,
      'customer_number', customer_number,
      'first_name', first_name,
      'last_name', last_name,
      'phone', phone,
      'email', email,
      'document_number', document_number,
      'qr_code', qr_code
    )
  ) into v_result
  from public.public_sales_customers
  where 
    lower(first_name || ' ' || coalesce(last_name, '')) like '%' || lower(trim(p_search_term)) || '%'
    or lower(coalesce(last_name, '')) like '%' || lower(trim(p_search_term)) || '%'
    or document_number = trim(p_search_term)
    or customer_number = upper(trim(p_search_term))
    or qr_code::text = trim(p_search_term)
  limit 20;

  return coalesce(v_result, '[]'::json);
end $function$;

-- rpc_send_order_to_local(uuid) (md5 prosrc previo: cccefba8a1c0b3419b4261109cd0f64c)
CREATE OR REPLACE FUNCTION public.rpc_send_order_to_local(p_order_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_order_record record;
  v_local_customer_id uuid;
  v_local_order_id uuid;
  v_order_number text;
  v_total_amount numeric(12,2);
  v_lines_sum numeric(12,2);
  v_customer_result json;
  v_result json;
  v_total_items int;
  v_picked_items int;
begin
  PERFORM public.fyl_require_admin_or_internal();
  select
    o.id,
    o.customer_id,
    o.total_amount,
    o.notes,
    o.status
  into v_order_record
  from public.orders o
  where o.id = p_order_id;

  if v_order_record is null then
    raise exception 'Pedido no encontrado';
  end if;

  if v_order_record.status = 'stock_pending' then
    raise exception
      'rpc_send_order_to_local: la orden % está en stock_pending; resolver stock antes de enviarla.',
      p_order_id;
  end if;

  -- Reutilizar pedido local existente (mismo pedido web), p. ej. reintento de red o doble clic
  select lo.id, lo.order_number, lo.customer_id
  into v_local_order_id, v_order_number, v_local_customer_id
  from public.local_orders lo
  where lo.source_order_id = p_order_id
    and lo.status <> 'cancelled'
  order by lo.created_at desc
  limit 1;

  if v_local_order_id is not null then
    update public.orders o
    set
      status = 'sent',
      sent_at = coalesce(o.sent_at, now()),
      updated_at = now()
    where o.id = p_order_id
      and o.status is distinct from 'sent';

    select json_build_object(
      'success', true,
      'local_order_id', v_local_order_id,
      'order_number', v_order_number,
      'customer_id', v_local_customer_id,
      'already_exists', true
    ) into v_result;
    return v_result;
  end if;

  if v_order_record.status = 'sent' then
    raise exception 'El pedido ya fue enviado o marcado como enviado';
  end if;

  select count(*), count(*) filter (where status = 'picked' or status = 'waiting')
  into v_total_items, v_picked_items
  from public.order_items
  where order_id = p_order_id and status != 'cancelled';

  if v_total_items = 0 then
    raise exception 'El pedido no tiene items';
  end if;

  if v_picked_items < v_total_items then
    raise exception 'El pedido no está completamente apartado';
  end if;

  select public.rpc_copy_customer_to_local(v_order_record.customer_id) into v_customer_result;

  if (v_customer_result->>'success')::boolean = false then
    raise exception 'Error al copiar cliente: %', v_customer_result->>'error';
  end if;

  v_local_customer_id := (v_customer_result->>'customer_id')::uuid;

  v_order_number := public.generate_local_order_number();

  select coalesce(sum((quantity * price_snapshot)), 0)
  into v_lines_sum
  from public.order_items
  where order_id = p_order_id and status != 'cancelled';

  v_total_amount := coalesce(v_order_record.total_amount, v_lines_sum);
  if v_total_amount is null then
    v_total_amount := v_lines_sum;
  end if;

  insert into public.local_orders (
    order_number,
    customer_id,
    source_order_id,
    status,
    total_amount,
    notes
  )
  values (
    v_order_number,
    v_local_customer_id,
    p_order_id,
    'pending',
    v_total_amount,
    v_order_record.notes
  )
  returning id into v_local_order_id;

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
  select
    v_local_order_id,
    oi.variant_id,
    oi.product_name,
    oi.color,
    oi.size,
    oi.quantity,
    oi.price_snapshot,
    oi.imagen,
    'pending'
  from public.order_items oi
  where oi.order_id = p_order_id and oi.status != 'cancelled';

  update public.orders
  set status = 'sent',
      sent_at = now(),
      updated_at = now()
  where id = p_order_id;

  select json_build_object(
    'success', true,
    'local_order_id', v_local_order_id,
    'order_number', v_order_number,
    'customer_id', v_local_customer_id,
    'already_exists', false
  ) into v_result;
  return v_result;
end $function$;

-- rpc_update_local_order(uuid,jsonb) (md5 prosrc previo: c2e617959fb4b30f27a9bbefa5683116)
CREATE OR REPLACE FUNCTION public.rpc_update_local_order(p_local_order_id uuid, p_items jsonb)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
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
  v_has_size_model boolean;
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
  v_size_row record;
begin
  PERFORM public.fyl_require_admin_or_internal();
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
        select (
          exists (
            select 1
            from public.variant_size_warehouse_stock
            where variant_id = v_current.variant_id
            limit 1
          )
          or exists (
            select 1
            from public.variant_sizes
            where variant_id = v_current.variant_id
              and trim(coalesce(size, '')) <> ''
            limit 1
          )
        )
        into v_has_size_model;

        if coalesce(v_has_size_model, false) then
          raise exception 'La variante % usa talles. No se puede devolver stock sin size.', v_current.variant_id;
        end if;

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

    perform 1
    from public.product_variants pv
    where pv.id = v_variant_id
    for update;

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
      -- Stock por talle (variant_size_warehouse_stock) sin fallback derivado
      v_normalized_size := trim(v_size);
      if v_normalized_size ~ '^\d+(\.\d+)?$' then
        v_normalized_size := split_part(v_normalized_size, '.', 1);
      end if;

      insert into public.variant_size_warehouse_stock (variant_id, size, warehouse_id, stock_qty, updated_at)
      values (v_variant_id, v_normalized_size, v_warehouse_venta_publico_id, 0, now())
      on conflict (variant_id, size, warehouse_id) do nothing;
      insert into public.variant_size_warehouse_stock (variant_id, size, warehouse_id, stock_qty, updated_at)
      values (v_variant_id, v_normalized_size, v_warehouse_general_id, 0, now())
      on conflict (variant_id, size, warehouse_id) do nothing;

      v_size_stock_vp := 0;
      v_size_stock_gen := 0;
      for v_size_row in
        select warehouse_id, stock_qty
        from public.variant_size_warehouse_stock
        where variant_id = v_variant_id
          and size = v_normalized_size
          and warehouse_id in (v_warehouse_venta_publico_id, v_warehouse_general_id)
        order by warehouse_id
        for update
      loop
        if v_size_row.warehouse_id = v_warehouse_venta_publico_id then
          v_size_stock_vp := coalesce(v_size_row.stock_qty, 0);
        elsif v_size_row.warehouse_id = v_warehouse_general_id then
          v_size_stock_gen := coalesce(v_size_row.stock_qty, 0);
        end if;
      end loop;

      if (coalesce(v_size_stock_vp, 0) + coalesce(v_size_stock_gen, 0)) < v_qty_to_deduct then
        raise exception 'Stock insuficiente para % talle % (Cantidad a agregar: %, Disponible: venta-publico %, general %)',
          v_item->>'product_name', v_normalized_size, v_qty_to_deduct, coalesce(v_size_stock_vp, 0), coalesce(v_size_stock_gen, 0);
      end if;

      v_deduct_vp := least(v_qty_to_deduct, coalesce(v_size_stock_vp, 0));
      v_deduct_gen := v_qty_to_deduct - v_deduct_vp;

      -- Registros ya lockeados; aplicar descuento en write phase.

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

        -- variant_sizes se actualiza automáticamente via trigger 84
      end if;
    else
      -- Sin talle: stock legacy (variant_warehouse_stock)
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
        raise exception 'La variante % usa talles. Debes enviar size para descontar stock.', v_variant_id;
      end if;

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
end $function$;

-- rpc_void_public_sale(uuid,uuid,jsonb) (md5 prosrc previo: 08db5e1321ebe23bd9196e6f2cd298c7)
CREATE OR REPLACE FUNCTION public.rpc_void_public_sale(p_sale_id uuid, p_operation_id uuid, p_request jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_sale record;
  v_psi record;
  v_wh_vp uuid;
  v_wh_g uuid;
  v_pv_size text;
  v_norm text;
  v_has_size_model boolean;

  v_operation_request jsonb;
  v_prev_result jsonb;
  v_result jsonb;

  v_err_msg text;
  v_err_state text;
  v_err_detail text;
  v_err_hint text;
begin
  PERFORM public.fyl_require_admin_or_internal();
  if p_sale_id is null then
    raise exception 'rpc_void_public_sale: p_sale_id es obligatorio'
      using errcode = '22023';
  end if;

  if p_operation_id is null then
    raise exception 'rpc_void_public_sale: p_operation_id es obligatorio'
      using errcode = '22023';
  end if;

  -- Incluye target en el fingerprint para diferenciar reuso accidental de operation_id
  -- sobre otra venta, incluso si el cliente envía p_request vacío.
  v_operation_request := coalesce(p_request, '{}'::jsonb)
    || jsonb_build_object('sale_id', p_sale_id);

  v_prev_result := public.rpc_operations_begin(
    p_operation_id => p_operation_id,
    p_operation_kind => 'void_public_sale',
    p_request => v_operation_request,
    p_target_type => 'public_sale',
    p_target_id => p_sale_id::text
  );

  -- Replay de operación ya completada: devolver resultado previo exacto.
  if v_prev_result is not null then
    return coalesce(v_prev_result, '{}'::jsonb) || jsonb_build_object('idempotent_replay', true);
  end if;

  begin
    select id into v_wh_vp from public.warehouses where code = 'venta-publico' limit 1;
    select id into v_wh_g from public.warehouses where code = 'general' limit 1;

    if v_wh_vp is null then
      raise exception 'Warehouse venta-publico no encontrado';
    end if;
    if v_wh_g is null then
      raise exception 'Warehouse general no encontrado';
    end if;

    -- Lock fuerte para evitar doble restauración concurrente.
    select id, sale_number, customer_id, credit_used, voided_at
    into v_sale
    from public.public_sales
    where id = p_sale_id
    for update;

    if v_sale.id is null then
      raise exception 'Venta no encontrada';
    end if;

    -- Idempotencia de dominio: si ya está anulada (por otra operación previa),
    -- devolvemos noop y registramos completed para esta operation_id.
    if v_sale.voided_at is not null then
      v_result := jsonb_build_object(
        'success', true,
        'sale_number', v_sale.sale_number,
        'idempotent_noop', true
      );
      v_result := coalesce(v_result, '{}'::jsonb) || jsonb_build_object('idempotent_replay', false);
      return public.rpc_operations_complete(p_operation_id, v_result);
    end if;

    for v_psi in
      select psi.*, pv.size as pv_size
      from public.public_sale_items psi
      left join public.product_variants pv on pv.id = psi.variant_id
      where psi.sale_id = p_sale_id and psi.variant_id is not null
    loop
      if (v_psi.qty_venta_publico is null) <> (v_psi.qty_general is null) then
        raise exception 'public_sale_items id %: qty_venta_publico y qty_general deben ser ambas NULL o ambas NOT NULL',
          v_psi.id;
      end if;

      if v_psi.qty_venta_publico is null and v_psi.qty_general is null then
        select (
          exists (
            select 1
            from public.variant_size_warehouse_stock
            where variant_id = v_psi.variant_id
            limit 1
          )
          or exists (
            select 1
            from public.variant_sizes
            where variant_id = v_psi.variant_id
              and trim(coalesce(size, '')) <> ''
            limit 1
          )
        )
        into v_has_size_model;

        if coalesce(v_has_size_model, false) then
          raise exception 'La variante % usa talles. No se puede anular línea legacy sin size.', v_psi.variant_id;
        end if;

        if v_psi.is_return then
          update public.variant_warehouse_stock
          set stock_qty = greatest(0, stock_qty - v_psi.qty), updated_at = now()
          where variant_id = v_psi.variant_id and warehouse_id = v_wh_vp;
        else
          insert into public.variant_warehouse_stock (variant_id, warehouse_id, stock_qty)
          values (v_psi.variant_id, v_wh_vp, v_psi.qty)
          on conflict (variant_id, warehouse_id)
          do update set
            stock_qty = public.variant_warehouse_stock.stock_qty + v_psi.qty,
            updated_at = now();
        end if;
        continue;
      end if;

      v_norm := null;
      if v_psi.sold_size_normalized is not null and trim(v_psi.sold_size_normalized::text) != '' then
        v_norm := trim(v_psi.sold_size_normalized::text);
        if v_norm ~ '^\d+(\.\d+)?$' then
          v_norm := split_part(v_norm, '.', 1);
        end if;
      end if;
      if v_norm is null or v_norm = '' then
        v_pv_size := v_psi.pv_size;
        if v_pv_size is not null and trim(v_pv_size::text) != '' then
          v_norm := trim(v_pv_size::text);
          if v_norm ~ '^\d+(\.\d+)?$' then
            v_norm := split_part(v_norm, '.', 1);
          end if;
        end if;
      end if;

      if v_norm is null or v_norm = '' then
        select (
          exists (
            select 1
            from public.variant_size_warehouse_stock
            where variant_id = v_psi.variant_id
            limit 1
          )
          or exists (
            select 1
            from public.variant_sizes
            where variant_id = v_psi.variant_id
              and trim(coalesce(size, '')) <> ''
            limit 1
          )
        )
        into v_has_size_model;

        if coalesce(v_has_size_model, false) then
          raise exception 'La variante % usa talles. No se puede anular línea sin size.', v_psi.variant_id;
        end if;

        if v_psi.is_return then
          update public.variant_warehouse_stock
          set stock_qty = greatest(0, stock_qty - v_psi.qty), updated_at = now()
          where variant_id = v_psi.variant_id and warehouse_id = v_wh_vp;
        else
          insert into public.variant_warehouse_stock (variant_id, warehouse_id, stock_qty)
          values (v_psi.variant_id, v_wh_vp, v_psi.qty)
          on conflict (variant_id, warehouse_id)
          do update set
            stock_qty = public.variant_warehouse_stock.stock_qty + v_psi.qty,
            updated_at = now();
        end if;
        continue;
      end if;

      if v_psi.is_return then
        if v_psi.qty_venta_publico > 0 then
          update public.variant_size_warehouse_stock
          set stock_qty = greatest(0, stock_qty - v_psi.qty_venta_publico), updated_at = now()
          where variant_id = v_psi.variant_id and size = v_norm and warehouse_id = v_wh_vp;
        end if;
      else
        if v_psi.qty_venta_publico > 0 then
          insert into public.variant_size_warehouse_stock (variant_id, size, warehouse_id, stock_qty)
          values (v_psi.variant_id, v_norm, v_wh_vp, 0)
          on conflict (variant_id, size, warehouse_id) do nothing;
          update public.variant_size_warehouse_stock
          set stock_qty = stock_qty + v_psi.qty_venta_publico, updated_at = now()
          where variant_id = v_psi.variant_id and size = v_norm and warehouse_id = v_wh_vp;
        end if;
        if v_psi.qty_general > 0 then
          insert into public.variant_size_warehouse_stock (variant_id, size, warehouse_id, stock_qty)
          values (v_psi.variant_id, v_norm, v_wh_g, 0)
          on conflict (variant_id, size, warehouse_id) do nothing;
          update public.variant_size_warehouse_stock
          set stock_qty = stock_qty + v_psi.qty_general, updated_at = now()
          where variant_id = v_psi.variant_id and size = v_norm and warehouse_id = v_wh_g;
        end if;
      end if;
    end loop;

    if v_sale.customer_id is not null and coalesce(v_sale.credit_used, 0) > 0 then
      perform public.rpc_add_customer_credit(
        v_sale.customer_id,
        v_sale.credit_used,
        'Crédito restaurado por anulación de venta ' || v_sale.sale_number
      );
    end if;

    update public.public_sales
    set voided_at = now()
    where id = p_sale_id
      and voided_at is null;

    v_result := jsonb_build_object(
      'success', true,
      'sale_number', v_sale.sale_number,
      'idempotent_noop', false
    );

    v_result := coalesce(v_result, '{}'::jsonb) || jsonb_build_object('idempotent_replay', false);
    return public.rpc_operations_complete(p_operation_id, v_result);
  exception
    when others then
      get stacked diagnostics
        v_err_msg = message_text,
        v_err_state = returned_sqlstate,
        v_err_detail = pg_exception_detail,
        v_err_hint = pg_exception_hint;

      begin
        perform public.rpc_operations_fail(
          p_operation_id,
          jsonb_build_object(
            'message', v_err_msg,
            'sqlstate', v_err_state,
            'detail', v_err_detail,
            'hint', v_err_hint
          )
        );
      exception
        when others then
          -- No ocultar nunca el error de dominio original.
          null;
      end;
      raise;
  end;
end;
$function$;

-- rpc_void_public_sale(uuid) (md5 prosrc previo: 772938024789272e77e5810dad37fc92)
CREATE OR REPLACE FUNCTION public.rpc_void_public_sale(p_sale_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_sale record;
  v_psi record;
  v_wh_vp uuid;
  v_wh_g uuid;
  v_pv_size text;
  v_norm text;
  v_has_size_model boolean;
BEGIN
  PERFORM public.fyl_require_admin_or_internal();
  SELECT id INTO v_wh_vp FROM public.warehouses WHERE code = 'venta-publico' LIMIT 1;
  SELECT id INTO v_wh_g FROM public.warehouses WHERE code = 'general' LIMIT 1;

  IF v_wh_vp IS NULL THEN
    RAISE EXCEPTION 'Warehouse venta-publico no encontrado';
  END IF;
  IF v_wh_g IS NULL THEN
    RAISE EXCEPTION 'Warehouse general no encontrado';
  END IF;

  -- Lock fuerte para evitar doble restauración concurrente.
  SELECT id, sale_number, customer_id, credit_used, voided_at
  INTO v_sale
  FROM public.public_sales
  WHERE id = p_sale_id
  FOR UPDATE;

  IF v_sale.id IS NULL THEN
    RAISE EXCEPTION 'Venta no encontrada';
  END IF;

  -- Idempotencia: si ya está anulada, responder éxito sin tocar stock.
  IF v_sale.voided_at IS NOT NULL THEN
    RETURN json_build_object(
      'success', true,
      'sale_number', v_sale.sale_number,
      'idempotent_noop', true
    );
  END IF;

  FOR v_psi IN
    SELECT psi.*, pv.size AS pv_size
    FROM public.public_sale_items psi
    LEFT JOIN public.product_variants pv ON pv.id = psi.variant_id
    WHERE psi.sale_id = p_sale_id AND psi.variant_id IS NOT NULL
  LOOP
    IF (v_psi.qty_venta_publico IS NULL) <> (v_psi.qty_general IS NULL) THEN
      RAISE EXCEPTION 'public_sale_items id %: qty_venta_publico y qty_general deben ser ambas NULL o ambas NOT NULL',
        v_psi.id;
    END IF;

    IF v_psi.qty_venta_publico IS NULL AND v_psi.qty_general IS NULL THEN
      SELECT (
        EXISTS (
          SELECT 1
          FROM public.variant_size_warehouse_stock
          WHERE variant_id = v_psi.variant_id
          LIMIT 1
        )
        OR EXISTS (
          SELECT 1
          FROM public.variant_sizes
          WHERE variant_id = v_psi.variant_id
            AND TRIM(COALESCE(size, '')) <> ''
          LIMIT 1
        )
      )
      INTO v_has_size_model;

      IF COALESCE(v_has_size_model, false) THEN
        RAISE EXCEPTION 'La variante % usa talles. No se puede anular línea legacy sin size.', v_psi.variant_id;
      END IF;

      IF v_psi.is_return THEN
        UPDATE public.variant_warehouse_stock
        SET stock_qty = greatest(0, stock_qty - v_psi.qty), updated_at = now()
        WHERE variant_id = v_psi.variant_id AND warehouse_id = v_wh_vp;
      ELSE
        INSERT INTO public.variant_warehouse_stock (variant_id, warehouse_id, stock_qty)
        VALUES (v_psi.variant_id, v_wh_vp, v_psi.qty)
        ON CONFLICT (variant_id, warehouse_id)
        DO UPDATE SET
          stock_qty = public.variant_warehouse_stock.stock_qty + v_psi.qty,
          updated_at = now();
      END IF;
      CONTINUE;
    END IF;

    v_norm := NULL;
    IF v_psi.sold_size_normalized IS NOT NULL AND TRIM(v_psi.sold_size_normalized::text) != '' THEN
      v_norm := TRIM(v_psi.sold_size_normalized::text);
      IF v_norm ~ '^\d+(\.\d+)?$' THEN
        v_norm := split_part(v_norm, '.', 1);
      END IF;
    END IF;
    IF v_norm IS NULL OR v_norm = '' THEN
      v_pv_size := v_psi.pv_size;
      IF v_pv_size IS NOT NULL AND TRIM(v_pv_size::text) != '' THEN
        v_norm := TRIM(v_pv_size::text);
        IF v_norm ~ '^\d+(\.\d+)?$' THEN
          v_norm := split_part(v_norm, '.', 1);
        END IF;
      END IF;
    END IF;

    IF v_norm IS NULL OR v_norm = '' THEN
      SELECT (
        EXISTS (
          SELECT 1
          FROM public.variant_size_warehouse_stock
          WHERE variant_id = v_psi.variant_id
          LIMIT 1
        )
        OR EXISTS (
          SELECT 1
          FROM public.variant_sizes
          WHERE variant_id = v_psi.variant_id
            AND TRIM(COALESCE(size, '')) <> ''
          LIMIT 1
        )
      )
      INTO v_has_size_model;

      IF COALESCE(v_has_size_model, false) THEN
        RAISE EXCEPTION 'La variante % usa talles. No se puede anular línea sin size.', v_psi.variant_id;
      END IF;

      IF v_psi.is_return THEN
        UPDATE public.variant_warehouse_stock
        SET stock_qty = greatest(0, stock_qty - v_psi.qty), updated_at = now()
        WHERE variant_id = v_psi.variant_id AND warehouse_id = v_wh_vp;
      ELSE
        INSERT INTO public.variant_warehouse_stock (variant_id, warehouse_id, stock_qty)
        VALUES (v_psi.variant_id, v_wh_vp, v_psi.qty)
        ON CONFLICT (variant_id, warehouse_id)
        DO UPDATE SET
          stock_qty = public.variant_warehouse_stock.stock_qty + v_psi.qty,
          updated_at = now();
      END IF;
      CONTINUE;
    END IF;

    IF v_psi.is_return THEN
      IF v_psi.qty_venta_publico > 0 THEN
        UPDATE public.variant_size_warehouse_stock
        SET stock_qty = greatest(0, stock_qty - v_psi.qty_venta_publico), updated_at = now()
        WHERE variant_id = v_psi.variant_id AND size = v_norm AND warehouse_id = v_wh_vp;
      END IF;
    ELSE
      IF v_psi.qty_venta_publico > 0 THEN
        INSERT INTO public.variant_size_warehouse_stock (variant_id, size, warehouse_id, stock_qty)
        VALUES (v_psi.variant_id, v_norm, v_wh_vp, 0)
        ON CONFLICT (variant_id, size, warehouse_id) DO NOTHING;
        UPDATE public.variant_size_warehouse_stock
        SET stock_qty = stock_qty + v_psi.qty_venta_publico, updated_at = now()
        WHERE variant_id = v_psi.variant_id AND size = v_norm AND warehouse_id = v_wh_vp;
      END IF;
      IF v_psi.qty_general > 0 THEN
        INSERT INTO public.variant_size_warehouse_stock (variant_id, size, warehouse_id, stock_qty)
        VALUES (v_psi.variant_id, v_norm, v_wh_g, 0)
        ON CONFLICT (variant_id, size, warehouse_id) DO NOTHING;
        UPDATE public.variant_size_warehouse_stock
        SET stock_qty = stock_qty + v_psi.qty_general, updated_at = now()
        WHERE variant_id = v_psi.variant_id AND size = v_norm AND warehouse_id = v_wh_g;
      END IF;
    END IF;
  END LOOP;

  IF v_sale.customer_id IS NOT NULL AND coalesce(v_sale.credit_used, 0) > 0 THEN
    PERFORM public.rpc_add_customer_credit(
      v_sale.customer_id,
      v_sale.credit_used,
      'Crédito restaurado por anulación de venta ' || v_sale.sale_number
    );
  END IF;

  UPDATE public.public_sales
  SET voided_at = now()
  WHERE id = p_sale_id
    AND voided_at IS NULL;

  RETURN json_build_object(
    'success', true,
    'sale_number', v_sale.sale_number,
    'idempotent_noop', false
  );
END $function$;

REVOKE EXECUTE ON FUNCTION
  public.cleanup_missing_order_item_sources(uuid, text),
  public.log_stock_change(uuid, uuid, text, uuid, text, integer, integer, uuid, uuid, text),
  public.rpc_move_stock(uuid, text, text, integer, text)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.cleanup_missing_order_item_sources(uuid, text),
  public.log_stock_change(uuid, uuid, text, uuid, text, integer, integer, uuid, uuid, text),
  public.rpc_move_stock(uuid, text, text, integer, text)
TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
