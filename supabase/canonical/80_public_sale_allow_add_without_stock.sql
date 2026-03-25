-- 80_public_sale_allow_add_without_stock.sql
-- Permite registrar ventas cuando el frontend envía source 0,0 (agregar sin stock confirmado).
-- No se valida ni se descuenta stock para esos ítems; el resto del flujo no cambia.

create or replace function public.rpc_create_public_sale(
  p_items jsonb,
  p_customer_id uuid default null,
  p_notes text default null,
  p_apply_credit boolean default true
)
returns json language plpgsql security definer as $$
declare
  v_user_id uuid;
  v_sale_id uuid;
  v_sale_number text;
  v_total_amount numeric := 0;
  v_item_count int := 0;
  v_credit_used numeric := 0;
  v_total_credit numeric := 0;
  v_item jsonb;
  v_variant_id uuid;
  v_qty int;
  v_price numeric;
  v_is_return boolean;
  v_stock_data jsonb;
  v_warehouse_code text;
  v_available_stock int;
  v_credit_remaining numeric;
  v_general_stock int;
  v_venta_publico_stock int;
  v_remaining_credit numeric;
  v_credit_record record;
  v_qty_venta_publico int;
  v_qty_general int;
  v_return_rows int;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  if not exists (select 1 from public.admins where user_id = v_user_id) then
    raise exception 'No tienes permiso para realizar ventas';
  end if;

  v_sale_number := public.generate_sale_number();

  if p_customer_id is not null and p_apply_credit then
    select public.rpc_get_customer_total_credit(p_customer_id) into v_total_credit;
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_variant_id := (v_item->>'variant_id')::uuid;
    v_qty := (v_item->>'qty')::int;
    v_price := (v_item->>'price')::numeric;
    v_is_return := coalesce((v_item->>'is_return')::boolean, false);
    declare
      v_from_local_order boolean := coalesce((v_item->>'from_local_order')::boolean, false);
      v_add_without_stock boolean := false;
    begin
      if not v_is_return then
        if not v_from_local_order then
          -- Detectar "agregar sin stock" (frontend envió source con 0,0)
          v_add_without_stock := (
            v_item->'source' is not null
            and coalesce((v_item->'source'->>'venta_publico')::int, 0) = 0
            and coalesce((v_item->'source'->>'general')::int, 0) = 0
          );

          if not v_add_without_stock then
            -- Validar stock disponible
            select json_agg(
              json_build_object(
                'warehouse_code', warehouse_code,
                'stock', stock
              )
            ) into v_stock_data
            from (
              select 
                w.code as warehouse_code,
                coalesce(vws.stock_qty, 0) as stock
              from public.warehouses w
              left join public.variant_warehouse_stock vws 
                on vws.warehouse_id = w.id 
                and vws.variant_id = v_variant_id
              where w.code in ('general', 'venta-publico')
              order by w.code
            ) stock_info;

            v_general_stock := 0;
            v_venta_publico_stock := 0;

            select coalesce((elem->>'stock')::int, 0) into v_general_stock
            from jsonb_array_elements(v_stock_data) elem
            where (elem->>'warehouse_code') = 'general'
            limit 1;

            select coalesce((elem->>'stock')::int, 0) into v_venta_publico_stock
            from jsonb_array_elements(v_stock_data) elem
            where (elem->>'warehouse_code') = 'venta-publico'
            limit 1;

            if v_general_stock = 0 and v_venta_publico_stock = 0 then
              raise exception 'No hay stock disponible para la variante %', v_variant_id;
            end if;

            if v_qty > (v_general_stock + v_venta_publico_stock) then
              raise exception 'Stock insuficiente. Disponible: %, Solicitado: %', 
                (v_general_stock + v_venta_publico_stock), v_qty;
            end if;

            v_qty_venta_publico := 0;
            v_qty_general := 0;

            if v_item->'source' is not null then
              v_qty_venta_publico := coalesce((v_item->'source'->>'venta_publico')::int, 0);
              v_qty_general := coalesce((v_item->'source'->>'general')::int, 0);

              if (v_qty_venta_publico + v_qty_general) != v_qty then
                v_qty_venta_publico := 0;
                v_qty_general := 0;
              end if;
            end if;

            if v_qty_venta_publico = 0 and v_qty_general = 0 then
              if v_venta_publico_stock > 0 then
                if v_qty <= v_venta_publico_stock then
                  v_qty_venta_publico := v_qty;
                  v_qty_general := 0;
                else
                  v_qty_venta_publico := v_venta_publico_stock;
                  v_qty_general := v_qty - v_venta_publico_stock;
                end if;
              else
                v_qty_venta_publico := 0;
                v_qty_general := v_qty;
              end if;
            end if;

            if v_qty_venta_publico > v_venta_publico_stock then
              raise exception 'Stock insuficiente en venta-publico. Disponible: %, Solicitado: %', 
                v_venta_publico_stock, v_qty_venta_publico;
            end if;

            if v_qty_general > v_general_stock then
              raise exception 'Stock insuficiente en general. Disponible: %, Solicitado: %', 
                v_general_stock, v_qty_general;
            end if;

            if v_qty_venta_publico > 0 then
              update public.variant_warehouse_stock
              set stock_qty = stock_qty - v_qty_venta_publico,
                  updated_at = now()
              where variant_id = v_variant_id
                and warehouse_id = (select id from public.warehouses where code = 'venta-publico');
            end if;

            if v_qty_general > 0 then
              update public.variant_warehouse_stock
              set stock_qty = stock_qty - v_qty_general,
                  updated_at = now()
              where variant_id = v_variant_id
                and warehouse_id = (select id from public.warehouses where code = 'general');
            end if;
          end if;
        end if;
      else
        -- Es devolución: sumar stock SOLO a venta-publico (nunca tocar general)
        update public.variant_warehouse_stock
        set stock_qty = stock_qty + v_qty,
            updated_at = now()
        where variant_id = v_variant_id
          and warehouse_id = (select id from public.warehouses where code = 'venta-publico');
        get diagnostics v_return_rows = row_count;
        if v_return_rows = 0 then
          insert into public.variant_warehouse_stock (variant_id, warehouse_id, stock_qty)
          values (
            v_variant_id,
            (select id from public.warehouses where code = 'venta-publico'),
            v_qty
          );
        end if;
      end if;

      if v_is_return then
        v_total_amount := v_total_amount - (v_price * v_qty);
      else
        v_total_amount := v_total_amount + (v_price * v_qty);
      end if;
      v_item_count := v_item_count + 1;
    end;
  end loop;

  if v_total_credit > 0 and p_apply_credit and v_total_amount > 0 then
    if v_total_credit >= v_total_amount then
      v_credit_used := v_total_amount;
      v_total_amount := 0;
    else
      v_credit_used := v_total_credit;
      v_total_amount := v_total_amount - v_credit_used;
    end if;

    v_remaining_credit := v_credit_used;
    for v_credit_record in 
      select id, amount
      from public.public_sales_customer_credits
      where customer_id = p_customer_id
        and expires_at > now()
        and amount > 0
      order by expires_at asc
    loop
      if v_remaining_credit <= 0 then
        exit;
      end if;

      if v_credit_record.amount <= v_remaining_credit then
        update public.public_sales_customer_credits
        set amount = 0
        where id = v_credit_record.id;
        v_remaining_credit := v_remaining_credit - v_credit_record.amount;
      else
        update public.public_sales_customer_credits
        set amount = amount - v_remaining_credit
        where id = v_credit_record.id;
        v_remaining_credit := 0;
      end if;
    end loop;
  end if;

  insert into public.public_sales (
    sale_number,
    sold_by,
    customer_id,
    total_amount,
    item_count,
    credit_used,
    notes
  )
  values (
    v_sale_number,
    v_user_id,
    p_customer_id,
    v_total_amount,
    v_item_count,
    v_credit_used,
    p_notes
  )
  returning id into v_sale_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    insert into public.public_sale_items (
      sale_id,
      variant_id,
      qty,
      price_snapshot,
      is_return
    )
    values (
      v_sale_id,
      (v_item->>'variant_id')::uuid,
      (v_item->>'qty')::int,
      (v_item->>'price')::numeric,
      coalesce((v_item->>'is_return')::boolean, false)
    );
  end loop;

  return json_build_object(
    'success', true,
    'sale_id', v_sale_id,
    'sale_number', v_sale_number,
    'total_amount', v_total_amount,
    'credit_used', v_credit_used,
    'item_count', v_item_count
  );
end $$;
