-- Hotfix staging: RAISE syntax + alineado a 217 canónico (digest fix en 216 ya aplicado vía migración separada).

create or replace function public.rpc_create_admin_order_atomic(
  p_payload jsonb,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_uid           uuid;
  v_is_admin      boolean;
  v_hash          text;
  v_ins_key       uuid;
  v_row           public.admin_order_create_idempotency%rowtype;
  v_customer_id   uuid;
  v_total         numeric;
  v_notes         text;
  v_extra         jsonb;
  v_items         jsonb;
  v_item          jsonb;
  v_items_eff     jsonb := '[]'::jsonb;
  v_ii            int;
  v_qty           int;
  v_g             int;
  v_v             int;
  v_has_split     boolean;
  v_norm_item     jsonb;
  v_norm_size     text;
  v_order_id      uuid;
  v_order_number  text;
  v_open_order    uuid;
  v_general       uuid;
  v_venta         uuid;
  v_resp          jsonb;
  v_manual        jsonb := '[]'::jsonb;
  v_deductions    jsonb := '[]'::jsonb;
  v_item_ids      uuid[] := array[]::uuid[];
  v_oi_id         uuid;
  v_ps            numeric;
  v_deduct_result jsonb;
begin
  if p_idempotency_key is null then
    raise exception 'rpc_create_admin_order_atomic: p_idempotency_key es obligatorio'
      using errcode = '22023';
  end if;

  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'rpc_create_admin_order_atomic: usuario no autenticado';
  end if;

  select exists (select 1 from public.admins a where a.user_id = v_uid)
  into v_is_admin;

  if not v_is_admin then
    raise exception 'rpc_create_admin_order_atomic: forbidden (solo admins)';
  end if;

  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'rpc_create_admin_order_atomic: p_payload debe ser objeto jsonb';
  end if;

  v_hash := fyl_private.admin_order_payload_sha256(p_payload);

  insert into public.admin_order_create_idempotency (
    idempotency_key, admin_user_id, payload_hash, status
  ) values (
    p_idempotency_key, v_uid, v_hash, 'pending'
  )
  on conflict (idempotency_key) do nothing
  returning idempotency_key into v_ins_key;

  if v_ins_key is null then
    select * into v_row
    from public.admin_order_create_idempotency d
    where d.idempotency_key = p_idempotency_key;

    if not found then
      raise exception 'rpc_create_admin_order_atomic: idempotency inconsistente';
    end if;

    if v_row.admin_user_id is distinct from v_uid then
      raise exception 'rpc_create_admin_order_atomic: idempotency key pertenece a otro admin';
    end if;

    if v_row.status = 'success' then
      if v_row.payload_hash is distinct from v_hash then
        raise exception
          'rpc_create_admin_order_atomic: IDEMPOTENCY_CONFLICT — mismo idempotency_key con payload distinto'
          using errcode = 'P0001';
      end if;
      return coalesce(v_row.response_jsonb, '{}'::jsonb)
        || jsonb_build_object(
             'idempotency', jsonb_build_object('replay', true)
           );
    end if;

    raise exception 'rpc_create_admin_order_atomic: reintentá en unos segundos (idempotency en curso)';
  end if;

  v_customer_id := nullif(trim(both from p_payload->>'customer_id'), '')::uuid;
  if v_customer_id is null then
    raise exception 'rpc_create_admin_order_atomic: customer_id inválido';
  end if;

  if not exists (select 1 from public.customers c where c.id = v_customer_id) then
    raise exception
      'rpc_create_admin_order_atomic: CUSTOMER_NOT_FOUND — cliente no encontrado'
      using errcode = 'P0001';
  end if;

  v_extra := p_payload->'extra_notes';
  if v_extra is not null and jsonb_typeof(v_extra) = 'object' and v_extra <> '{}'::jsonb then
    v_notes := v_extra::text;
  elsif p_payload ? 'notes' and p_payload->'notes' is not null then
    if jsonb_typeof(p_payload->'notes') in ('object', 'array') then
      v_notes := (p_payload->'notes')::text;
    else
      v_notes := nullif(trim(both from p_payload->>'notes'), '');
    end if;
  else
    v_notes := null;
  end if;

  v_total := coalesce((p_payload->>'total_amount')::numeric, 0);

  v_items := p_payload->'items';
  if v_items is null or jsonb_typeof(v_items) <> 'array' or jsonb_array_length(v_items) = 0 then
    raise exception 'rpc_create_admin_order_atomic: items debe ser un array no vacío';
  end if;

  for v_ii in 0..jsonb_array_length(v_items) - 1 loop
    v_item := v_items -> v_ii;
    if nullif(trim(both from v_item ->> 'variant_id'), '') is null then
      raise exception 'rpc_create_admin_order_atomic: variant_id requerido en ítem %', v_ii + 1;
    end if;
    begin
      perform (trim(both from v_item ->> 'variant_id'))::uuid;
    exception
      when invalid_text_representation then
        raise exception 'rpc_create_admin_order_atomic: variant_id UUID inválido en ítem %', v_ii + 1;
    end;

    v_qty := coalesce((v_item ->> 'quantity')::int, 0);
    if v_qty <= 0 then
      raise exception 'rpc_create_admin_order_atomic: quantity debe ser > 0 (ítem %)', v_ii + 1;
    end if;

    v_g := coalesce((v_item ->> 'qty_from_general')::int, 0);
    v_v := coalesce((v_item ->> 'qty_from_venta')::int, 0);
    v_has_split := (v_g + v_v) > 0;
    v_norm_size := fyl_private.normalize_size_admin_order(v_item ->> 'size');

    if v_norm_size <> '' and not v_has_split then
      v_norm_item := v_item
        || jsonb_build_object(
             'status', coalesce(nullif(trim(both from v_item ->> 'status'), ''), 'picked'),
             'admin_confirmed_missing', true
           );
    else
      v_norm_item := v_item
        || jsonb_build_object(
             'status', coalesce(nullif(trim(both from v_item ->> 'status'), ''), 'picked'),
             'admin_confirmed_missing', coalesce((v_item ->> 'admin_confirmed_missing')::boolean, false)
           );
    end if;

    v_norm_item := v_norm_item || jsonb_build_object('size', nullif(v_norm_size, ''));
    v_items_eff := v_items_eff || jsonb_build_array(v_norm_item);
  end loop;

  select o.id
    into v_open_order
  from public.orders o
  where o.customer_id = v_customer_id
    and o.status in ('active', 'closing_soon')
  order by o.created_at desc
  limit 1;

  if v_open_order is not null then
    raise exception
      'rpc_create_admin_order_atomic: OPEN_ORDER_EXISTS — el cliente ya tiene pedido abierto (%s)',
      v_open_order
      using errcode = 'P0001';
  end if;

  select w.id into v_general from public.warehouses w where w.code = 'general' limit 1;
  select w.id into v_venta from public.warehouses w where w.code = 'venta-publico' limit 1;

  if v_general is null or v_venta is null then
    raise exception 'rpc_create_admin_order_atomic: warehouses general o venta-publico no encontrados';
  end if;

  insert into public.orders (
    customer_id, status, total_amount, notes, source, created_by_user_id
  ) values (
    v_customer_id, 'active', v_total, v_notes, 'admin', v_uid
  )
  returning id, order_number into v_order_id, v_order_number;

  for v_ii in 0..jsonb_array_length(v_items_eff) - 1 loop
    v_item := v_items_eff -> v_ii;
    v_norm_size := fyl_private.normalize_size_admin_order(v_item ->> 'size');

    if v_item ? 'price_snapshot' and jsonb_typeof(v_item -> 'price_snapshot') = 'number' then
      v_ps := (v_item -> 'price_snapshot')::text::numeric;
    elsif nullif(trim(both from v_item ->> 'price_snapshot'), '') is not null then
      v_ps := trim(both from v_item ->> 'price_snapshot')::numeric;
    else
      v_ps := null;
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
      (v_item ->> 'variant_id')::uuid,
      v_item ->> 'product_name',
      v_item ->> 'color',
      nullif(v_norm_size, ''),
      (v_item ->> 'quantity')::int,
      v_ps,
      v_item ->> 'imagen',
      coalesce(nullif(trim(both from v_item ->> 'status'), ''), 'picked'),
      coalesce((v_item ->> 'admin_confirmed_missing')::boolean, false)
    )
    returning id into v_oi_id;

    v_item_ids := array_append(v_item_ids, v_oi_id);
  end loop;

  v_manual := '[]'::jsonb;
  for v_ii in 0..jsonb_array_length(v_items_eff) - 1 loop
    v_item := v_items_eff -> v_ii;
    if coalesce((v_item ->> 'admin_confirmed_missing')::boolean, false)
       and nullif(trim(both from v_item ->> 'variant_id'), '') is not null
       and fyl_private.normalize_size_admin_order(v_item ->> 'size') <> ''
       and coalesce((v_item ->> 'quantity')::int, 0) > 0 then
      v_manual := v_manual || jsonb_build_array(
        jsonb_build_object(
          'variant_id', (v_item ->> 'variant_id')::uuid,
          'size', fyl_private.normalize_size_admin_order(v_item ->> 'size'),
          'warehouse_id', v_general,
          'qty', (v_item ->> 'quantity')::int,
          'order_item_id', v_item_ids[v_ii + 1]
        )
      );
    end if;
  end loop;

  if jsonb_array_length(v_manual) > 0 then
    perform public.rpc_admin_manual_inject_and_deduct(v_manual, v_order_id);
  end if;

  v_deductions := '[]'::jsonb;
  for v_ii in 0..jsonb_array_length(v_items_eff) - 1 loop
    v_item := v_items_eff -> v_ii;
    if not fyl_private.admin_order_item_qualifies_deduction(v_item) then
      continue;
    end if;

    v_norm_size := fyl_private.normalize_size_admin_order(v_item ->> 'size');
    v_qty := (v_item ->> 'quantity')::int;
    v_g := coalesce((v_item ->> 'qty_from_general')::int, 0);
    v_v := coalesce((v_item ->> 'qty_from_venta')::int, 0);

    if v_g > 0 then
      v_deductions := v_deductions || jsonb_build_array(
        jsonb_build_object(
          'variant_id', (v_item ->> 'variant_id')::uuid,
          'size', v_norm_size,
          'warehouse_id', v_general,
          'qty_to_deduct', v_g,
          'order_item_id', v_item_ids[v_ii + 1]
        )
      );
    end if;

    if v_v > 0 then
      v_deductions := v_deductions || jsonb_build_array(
        jsonb_build_object(
          'variant_id', (v_item ->> 'variant_id')::uuid,
          'size', v_norm_size,
          'warehouse_id', v_venta,
          'qty_to_deduct', v_v,
          'order_item_id', v_item_ids[v_ii + 1]
        )
      );
    end if;
  end loop;

  if jsonb_array_length(v_deductions) > 0 then
    select public.rpc_apply_order_stock_deduction(
      v_deductions,
      v_order_id,
      'order_creation'
    )
    into v_deduct_result;
  end if;

  v_resp := jsonb_build_object(
    'ok', true,
    'order_id', v_order_id,
    'order_number', v_order_number,
    'order_items', coalesce(
      (
        select jsonb_agg(
                 jsonb_build_object(
                   'id', oi.id,
                   'variant_id', oi.variant_id,
                   'size', oi.size,
                   'quantity', oi.quantity,
                   'admin_confirmed_missing', oi.admin_confirmed_missing
                 )
                 order by oi.created_at
               )
        from public.order_items oi
        where oi.order_id = v_order_id
      ),
      '[]'::jsonb
    ),
    'stock', jsonb_build_object(
      'manual_processed', coalesce(jsonb_array_length(v_manual), 0),
      'deduction_applied_items',
        case
          when jsonb_array_length(v_deductions) > 0 then coalesce((v_deduct_result ->> 'applied_items')::int, 0)
          else 0
        end,
      'source', 'order_creation'
    ),
    'idempotency', jsonb_build_object('replay', false)
  );

  update public.admin_order_create_idempotency d
     set status = 'success',
         order_id = v_order_id,
         response_jsonb = v_resp,
         completed_at = now()
   where d.idempotency_key = p_idempotency_key;

  return v_resp;
end;
$$;

select pg_notify('pgrst', 'reload schema');
