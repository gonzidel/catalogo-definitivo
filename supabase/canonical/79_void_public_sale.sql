-- LEGACY (Plan 3): este archivo queda como versión histórica.
-- La versión canónica efectiva de rpc_void_public_sale es canonical:141
-- y se reafirma en 149_consolidate_critical_rpcs.sql.
-- 79_void_public_sale.sql — Anular venta y restablecer stock en venta al público (idempotente)

-- 1) Columna voided_at en public_sales
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'public_sales' and column_name = 'voided_at'
  ) then
    alter table public.public_sales add column voided_at timestamptz default null;
  end if;
end $$;

-- 2) RPC: Anular venta y restablecer stock en venta-publico
create or replace function public.rpc_void_public_sale(p_sale_id uuid)
returns json language plpgsql security definer as $$
declare
  v_sale record;
  v_item record;
  v_warehouse_venta_publico_id uuid;
begin
  -- Obtener id del warehouse venta-publico
  select id into v_warehouse_venta_publico_id
  from public.warehouses where code = 'venta-publico' limit 1;

  if v_warehouse_venta_publico_id is null then
    raise exception 'Warehouse venta-publico no encontrado';
  end if;

  -- Obtener venta y validar que existe y no está anulada
  select id, sale_number, customer_id, credit_used, voided_at into v_sale
  from public.public_sales where id = p_sale_id;

  if v_sale.id is null then
    raise exception 'Venta no encontrada';
  end if;

  if v_sale.voided_at is not null then
    raise exception 'La venta ya está anulada';
  end if;

  -- Restaurar stock por cada ítem con variant_id
  for v_item in
    select psi.variant_id, psi.qty, psi.is_return
    from public.public_sale_items psi
    where psi.sale_id = p_sale_id and psi.variant_id is not null
  loop
    if v_item.is_return then
      -- Era devolución: se había sumado a venta-publico, ahora restamos
      update public.variant_warehouse_stock
      set stock_qty = greatest(0, stock_qty - v_item.qty),
          updated_at = now()
      where variant_id = v_item.variant_id
        and warehouse_id = v_warehouse_venta_publico_id;
    else
      -- Venta normal: se había restado, ahora sumamos a venta-publico
      insert into public.variant_warehouse_stock (variant_id, warehouse_id, stock_qty)
      select v_item.variant_id, v_warehouse_venta_publico_id, v_item.qty
      on conflict (variant_id, warehouse_id)
      do update set
        stock_qty = variant_warehouse_stock.stock_qty + v_item.qty,
        updated_at = now();
    end if;
  end loop;

  -- Devolver crédito usado al cliente
  if v_sale.customer_id is not null and coalesce(v_sale.credit_used, 0) > 0 then
    perform public.rpc_add_customer_credit(
      v_sale.customer_id,
      v_sale.credit_used,
      'Crédito restaurado por anulación de venta ' || v_sale.sale_number
    );
  end if;

  -- Marcar venta como anulada
  update public.public_sales
  set voided_at = now()
  where id = p_sale_id;

  return json_build_object('success', true, 'sale_number', v_sale.sale_number);
end $$;

-- 3) Incluir voided_at en historial de ventas
create or replace function public.rpc_get_public_sales_history(
  p_limit int default 10,
  p_offset int default 0,
  p_date_filter date default null,
  p_customer_search text default null
)
returns json language plpgsql security definer as $$
declare
  v_result json;
begin
  select json_agg(
    json_build_object(
      'id', ps.id,
      'sale_number', ps.sale_number,
      'created_at', ps.created_at,
      'voided_at', ps.voided_at,
      'customer_name',
        case
          when psc.first_name is not null
          then psc.first_name || ' ' || coalesce(psc.last_name, '')
          else null
        end,
      'total_amount', ps.total_amount,
      'item_count', ps.item_count,
      'credit_used', ps.credit_used
    ) order by ps.created_at desc
  ) into v_result
  from (
    select ps.id, ps.sale_number, ps.created_at, ps.voided_at, ps.total_amount, ps.item_count, ps.credit_used, ps.customer_id
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
end $$;
