-- 42_statistics_rpc.sql — Funciones RPC para módulo de Estadísticas (idempotente)
-- Todas las funciones verifican que el usuario sea admin usando public.admins

-- Función helper para verificar admin
create or replace function public.is_admin()
returns boolean
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  return exists (select 1 from public.admins where user_id = auth.uid());
end;
$$;

-- 1) get_dashboard_kpis: KPIs principales del dashboard
create or replace function public.get_dashboard_kpis(
  p_from timestamptz,
  p_to timestamptz,
  p_channel text default 'all'
)
returns json
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_result json;
  v_envio_revenue numeric := 0;
  v_envio_orders_sent int := 0;
  v_envio_units int := 0;
  v_publico_revenue numeric := 0;
  v_publico_sales_count int := 0;
  v_publico_units int := 0;
  v_total_revenue numeric := 0;
  v_total_units int := 0;
  v_ticket_prom_envios numeric := 0;
  v_ticket_prom_publico numeric := 0;
  v_margin_amount_total numeric := 0;
  v_margin_percent_total numeric := 0;
  v_revenue_items numeric := 0;
  v_missing_cost_items_count int := 0;
  v_publico_margin numeric := 0;
  v_publico_revenue_items numeric := 0;
  v_publico_missing_cost int := 0;
  v_missing_variant_items_count_envios int := 0;
  v_legacy_sent_without_sent_at_count int := 0;
  v_carts_created int := 0;
  v_cart_items_qty int := 0;
  v_carts_active int := 0;
begin
  -- Verificar admin
  if not public.is_admin() then
    raise exception 'Solo administradores pueden acceder a estadísticas';
  end if;

  -- Validar canal
  if p_channel not in ('all', 'envios', 'publico') then
    raise exception 'p_channel debe ser all, envios o publico';
  end if;

  -- KPIs Envíos (solo si p_channel IN ('all', 'envios'))
  if p_channel in ('all', 'envios') then
    -- Revenue: usar orders.total_amount
    select 
      coalesce(sum(o.total_amount), 0),
      count(*)::int,
      coalesce(sum(oi.quantity), 0)::int,
      count(*) filter (where o.status = 'sent' and o.sent_at is null)::int
    into 
      v_envio_revenue,
      v_envio_orders_sent,
      v_envio_units,
      v_legacy_sent_without_sent_at_count
    from public.orders o
    left join public.order_items oi on oi.order_id = o.id
    where o.status = 'sent' 
      and o.sent_at is not null
      and o.sent_at between p_from and p_to;

    -- Missing variant items en envíos
    select count(*)::int
    into v_missing_variant_items_count_envios
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
    where o.status = 'sent'
      and o.sent_at is not null
      and o.sent_at between p_from and p_to
      and oi.variant_id is null;

    -- Ticket promedio envíos
    if v_envio_orders_sent > 0 then
      v_ticket_prom_envios := v_envio_revenue / v_envio_orders_sent;
    end if;
  end if;

  -- KPIs Público (solo si p_channel IN ('all', 'publico'))
  if p_channel in ('all', 'publico') then
    -- Revenue: usar public_sales.total_amount (neto, incluye devoluciones y créditos)
    select 
      coalesce(sum(ps.total_amount), 0),
      count(*)::int,
      coalesce(sum(case when psi.is_return then -psi.qty else psi.qty end), 0)::int
    into 
      v_publico_revenue,
      v_publico_sales_count,
      v_publico_units
    from public.public_sales ps
    left join public.public_sale_items psi on psi.sale_id = ps.id
    where ps.created_at between p_from and p_to;

    -- Ticket promedio público
    if v_publico_sales_count > 0 then
      v_ticket_prom_publico := v_publico_revenue / v_publico_sales_count;
    end if;
  end if;

  -- Totales (solo si p_channel = 'all')
  if p_channel = 'all' then
    v_total_revenue := v_envio_revenue + v_publico_revenue;
    v_total_units := v_envio_units + v_publico_units;
  end if;

  -- Margen: calcular por ítem (solo items con cost y variant_id)
  -- Envíos
  if p_channel in ('all', 'envios') then
    select 
      coalesce(sum(oi.quantity * (oi.price_snapshot - p.cost)), 0),
      coalesce(sum(oi.quantity * oi.price_snapshot), 0),
      count(*) filter (where p.cost is null)::int
    into 
      v_margin_amount_total,
      v_revenue_items,
      v_missing_cost_items_count
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
    join public.product_variants pv on pv.id = oi.variant_id
    join public.products p on p.id = pv.product_id
    where o.status = 'sent'
      and o.sent_at is not null
      and o.sent_at between p_from and p_to
      and oi.variant_id is not null
      and p.cost is not null;
  end if;

  -- Público: agregar al margen (con signo para devoluciones)
  if p_channel in ('all', 'publico') then
    select 
      coalesce(sum((case when psi.is_return then -psi.qty else psi.qty end) * (psi.price_snapshot - p.cost)), 0),
      coalesce(sum((case when psi.is_return then -psi.qty else psi.qty end) * psi.price_snapshot), 0),
      count(*) filter (where p.cost is null)::int
    into 
      v_publico_margin,
      v_publico_revenue_items,
      v_publico_missing_cost
    from public.public_sale_items psi
    join public.public_sales ps on ps.id = psi.sale_id
    join public.product_variants pv on pv.id = psi.variant_id
    join public.products p on p.id = pv.product_id
    where ps.created_at between p_from and p_to
      and p.cost is not null;

    -- Sumar al margen total (si es 'all', combinar con envíos)
    v_margin_amount_total := v_margin_amount_total + v_publico_margin;
    v_revenue_items := v_revenue_items + v_publico_revenue_items;
    v_missing_cost_items_count := v_missing_cost_items_count + v_publico_missing_cost;
  end if;

  -- Margen porcentual
  if v_revenue_items > 0 then
    v_margin_percent_total := (v_margin_amount_total / v_revenue_items) * 100;
  end if;

  -- Carritos
  select 
    count(*)::int,
    coalesce(sum(ci.qty), 0)::int,
    count(*) filter (where c.status in ('open','submitted','confirmed','ready_to_ship'))::int
  into 
    v_carts_created,
    v_cart_items_qty,
    v_carts_active
  from public.carts c
  left join public.cart_items ci on ci.cart_id = c.id
  where c.created_at between p_from and p_to;

  -- Construir resultado JSON según canal
  if p_channel = 'all' then
    v_result := json_build_object(
      'envio_revenue', v_envio_revenue,
      'envio_orders_sent', v_envio_orders_sent,
      'envio_units', v_envio_units,
      'publico_revenue', v_publico_revenue,
      'publico_sales_count', v_publico_sales_count,
      'publico_units', v_publico_units,
      'total_revenue', v_total_revenue,
      'total_units', v_total_units,
      'ticket_prom_envios', v_ticket_prom_envios,
      'ticket_prom_publico', v_ticket_prom_publico,
      'margin_amount_total', v_margin_amount_total,
      'margin_percent_total', v_margin_percent_total,
      'missing_cost_items_count', v_missing_cost_items_count,
      'missing_variant_items_count_envios', v_missing_variant_items_count_envios,
      'legacy_sent_without_sent_at_count', v_legacy_sent_without_sent_at_count,
      'carts_created', v_carts_created,
      'cart_items_qty', v_cart_items_qty,
      'carts_active', v_carts_active
    );
  elsif p_channel = 'envios' then
    v_result := json_build_object(
      'envio_revenue', v_envio_revenue,
      'envio_orders_sent', v_envio_orders_sent,
      'envio_units', v_envio_units,
      'ticket_prom_envios', v_ticket_prom_envios,
      'margin_amount_total', v_margin_amount_total,
      'margin_percent_total', v_margin_percent_total,
      'missing_cost_items_count', v_missing_cost_items_count,
      'missing_variant_items_count_envios', v_missing_variant_items_count_envios,
      'legacy_sent_without_sent_at_count', v_legacy_sent_without_sent_at_count
    );
  else -- publico
    v_result := json_build_object(
      'publico_revenue', v_publico_revenue,
      'publico_sales_count', v_publico_sales_count,
      'publico_units', v_publico_units,
      'ticket_prom_publico', v_ticket_prom_publico,
      'margin_amount_total', v_margin_amount_total,
      'margin_percent_total', v_margin_percent_total,
      'missing_cost_items_count', v_missing_cost_items_count
    );
  end if;

  return v_result;
end;
$$;

-- 2) get_sales_timeseries: Series temporales de ventas
create or replace function public.get_sales_timeseries(
  p_from timestamptz,
  p_to timestamptz,
  p_granularity text default 'day',
  p_channel text default 'all'
)
returns table (
  date date,
  envios_revenue numeric,
  publico_revenue numeric,
  total_revenue numeric,
  envios_orders_sent int,
  publico_sales_count int,
  units_total int
)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  -- Verificar admin
  if not public.is_admin() then
    raise exception 'Solo administradores pueden acceder a estadísticas';
  end if;

  -- Validar granularidad
  if p_granularity not in ('day', 'week', 'month') then
    raise exception 'p_granularity debe ser day, week o month';
  end if;

  -- Validar canal
  if p_channel not in ('all', 'envios', 'publico') then
    raise exception 'p_channel debe ser all, envios o publico';
  end if;

  -- Retornar series temporales
  return query
  with dates as (
    select generate_series(
      case p_granularity
        when 'day' then (p_from AT TIME ZONE 'America/Argentina/Cordoba')::date
        when 'week' then date_trunc('week', (p_from AT TIME ZONE 'America/Argentina/Cordoba'))::date
        when 'month' then date_trunc('month', (p_from AT TIME ZONE 'America/Argentina/Cordoba'))::date
      end,
      case p_granularity
        when 'day' then (p_to AT TIME ZONE 'America/Argentina/Cordoba')::date
        when 'week' then date_trunc('week', (p_to AT TIME ZONE 'America/Argentina/Cordoba'))::date
        when 'month' then date_trunc('month', (p_to AT TIME ZONE 'America/Argentina/Cordoba'))::date
      end,
      case p_granularity
        when 'day' then '1 day'::interval
        when 'week' then '1 week'::interval
        when 'month' then '1 month'::interval
      end
    )::date as date
  ),
  envios_data as (
    select 
      case p_granularity
        when 'day' then (o.sent_at AT TIME ZONE 'America/Argentina/Cordoba')::date
        when 'week' then date_trunc('week', (o.sent_at AT TIME ZONE 'America/Argentina/Cordoba'))::date
        when 'month' then date_trunc('month', (o.sent_at AT TIME ZONE 'America/Argentina/Cordoba'))::date
      end as sale_date,
      sum(o.total_amount) as revenue,
      count(*)::int as orders_count,
      sum(oi.quantity)::int as units
    from public.orders o
    left join public.order_items oi on oi.order_id = o.id
    where o.status = 'sent'
      and o.sent_at is not null
      and o.sent_at between p_from and p_to
    group by case p_granularity
        when 'day' then (o.sent_at AT TIME ZONE 'America/Argentina/Cordoba')::date
        when 'week' then date_trunc('week', (o.sent_at AT TIME ZONE 'America/Argentina/Cordoba'))::date
        when 'month' then date_trunc('month', (o.sent_at AT TIME ZONE 'America/Argentina/Cordoba'))::date
      end
  ),
  publico_data as (
    select 
      case p_granularity
        when 'day' then (ps.created_at AT TIME ZONE 'America/Argentina/Cordoba')::date
        when 'week' then date_trunc('week', (ps.created_at AT TIME ZONE 'America/Argentina/Cordoba'))::date
        when 'month' then date_trunc('month', (ps.created_at AT TIME ZONE 'America/Argentina/Cordoba'))::date
      end as sale_date,
      sum(ps.total_amount) as revenue,
      count(*)::int as sales_count,
      sum(case when psi.is_return then -psi.qty else psi.qty end)::int as units
    from public.public_sales ps
    left join public.public_sale_items psi on psi.sale_id = ps.id
    where ps.created_at between p_from and p_to
    group by case p_granularity
        when 'day' then (ps.created_at AT TIME ZONE 'America/Argentina/Cordoba')::date
        when 'week' then date_trunc('week', (ps.created_at AT TIME ZONE 'America/Argentina/Cordoba'))::date
        when 'month' then date_trunc('month', (ps.created_at AT TIME ZONE 'America/Argentina/Cordoba'))::date
      end
  )
  select 
    d.date,
    case when p_channel in ('all', 'envios') then coalesce(ed.revenue, 0) else 0 end as envios_revenue,
    case when p_channel in ('all', 'publico') then coalesce(pd.revenue, 0) else 0 end as publico_revenue,
    case when p_channel = 'all' then coalesce(ed.revenue, 0) + coalesce(pd.revenue, 0) else 0 end as total_revenue,
    coalesce(ed.orders_count, 0) as envios_orders_sent,
    coalesce(pd.sales_count, 0) as publico_sales_count,
    coalesce(ed.units, 0) + coalesce(pd.units, 0) as units_total
  from dates d
  left join envios_data ed on ed.sale_date = d.date
  left join publico_data pd on pd.sale_date = d.date
  where (p_channel = 'all' 
         or (p_channel = 'envios' and ed.revenue is not null)
         or (p_channel = 'publico' and pd.revenue is not null))
  order by d.date;
end;
$$;

-- 3) get_top_skus: Ranking de SKUs más vendidos
create or replace function public.get_top_skus(
  p_from timestamptz,
  p_to timestamptz,
  p_channel text default 'all',
  p_limit int default 10
)
returns table (
  variant_id uuid,
  sku text,
  title text,
  color text,
  size text,
  category text,
  units int,
  revenue numeric,
  margin_amount numeric
)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  -- Verificar admin
  if not public.is_admin() then
    raise exception 'Solo administradores pueden acceder a estadísticas';
  end if;

  -- Validar canal
  if p_channel not in ('all', 'envios', 'publico') then
    raise exception 'p_channel debe ser all, envios o publico';
  end if;

  -- Retornar ranking
  return query
  with envios_items as (
    select 
      oi.variant_id,
      sum(oi.quantity)::int as units,
      sum(oi.quantity * oi.price_snapshot) as revenue,
      sum(oi.quantity * (oi.price_snapshot - p.cost)) as margin
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
    join public.product_variants pv on pv.id = oi.variant_id
    join public.products p on p.id = pv.product_id
    where o.status = 'sent'
      and o.sent_at is not null
      and o.sent_at between p_from and p_to
      and oi.variant_id is not null
      and p.cost is not null
    group by oi.variant_id
  ),
  publico_items as (
    select 
      psi.variant_id,
      sum(case when psi.is_return then -psi.qty else psi.qty end)::int as units,
      sum((case when psi.is_return then -psi.qty else psi.qty end) * psi.price_snapshot) as revenue,
      sum((case when psi.is_return then -psi.qty else psi.qty end) * (psi.price_snapshot - p.cost)) as margin
    from public.public_sale_items psi
    join public.public_sales ps on ps.id = psi.sale_id
    join public.product_variants pv on pv.id = psi.variant_id
    join public.products p on p.id = pv.product_id
    where ps.created_at between p_from and p_to
      and p.cost is not null
    group by psi.variant_id
  ),
  combined as (
    select 
      coalesce(ei.variant_id, pi.variant_id) as variant_id,
      coalesce(ei.units, 0) + coalesce(pi.units, 0) as units,
      coalesce(ei.revenue, 0) + coalesce(pi.revenue, 0) as revenue,
      coalesce(ei.margin, 0) + coalesce(pi.margin, 0) as margin
    from envios_items ei
    full outer join publico_items pi on pi.variant_id = ei.variant_id
    where (p_channel = 'all')
       or (p_channel = 'envios' and ei.variant_id is not null)
       or (p_channel = 'publico' and pi.variant_id is not null)
  )
  select 
    pv.id as variant_id,
    pv.sku,
    p.name as title,
    pv.color,
    pv.size,
    p.category,
    c.units,
    c.revenue,
    c.margin as margin_amount
  from combined c
  join public.product_variants pv on pv.id = c.variant_id
  join public.products p on p.id = pv.product_id
  order by c.revenue desc
  limit p_limit;
end;
$$;

-- 4) get_top_products: Ranking de productos más vendidos
create or replace function public.get_top_products(
  p_from timestamptz,
  p_to timestamptz,
  p_channel text default 'all',
  p_limit int default 10
)
returns table (
  product_id uuid,
  product_name text,
  category text,
  units int,
  revenue numeric,
  margin_amount numeric
)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  -- Verificar admin
  if not public.is_admin() then
    raise exception 'Solo administradores pueden acceder a estadísticas';
  end if;

  -- Validar canal
  if p_channel not in ('all', 'envios', 'publico') then
    raise exception 'p_channel debe ser all, envios o publico';
  end if;

  -- Retornar ranking
  return query
  with envios_items as (
    select 
      pv.product_id,
      sum(oi.quantity)::int as units,
      sum(oi.quantity * oi.price_snapshot) as revenue,
      sum(oi.quantity * (oi.price_snapshot - p.cost)) as margin
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
    join public.product_variants pv on pv.id = oi.variant_id
    join public.products p on p.id = pv.product_id
    where o.status = 'sent'
      and o.sent_at is not null
      and o.sent_at between p_from and p_to
      and oi.variant_id is not null
      and p.cost is not null
    group by pv.product_id
  ),
  publico_items as (
    select 
      pv.product_id,
      sum(case when psi.is_return then -psi.qty else psi.qty end)::int as units,
      sum((case when psi.is_return then -psi.qty else psi.qty end) * psi.price_snapshot) as revenue,
      sum((case when psi.is_return then -psi.qty else psi.qty end) * (psi.price_snapshot - p.cost)) as margin
    from public.public_sale_items psi
    join public.public_sales ps on ps.id = psi.sale_id
    join public.product_variants pv on pv.id = psi.variant_id
    join public.products p on p.id = pv.product_id
    where ps.created_at between p_from and p_to
      and p.cost is not null
    group by pv.product_id
  ),
  combined as (
    select 
      coalesce(ei.product_id, pi.product_id) as product_id,
      coalesce(ei.units, 0) + coalesce(pi.units, 0) as units,
      coalesce(ei.revenue, 0) + coalesce(pi.revenue, 0) as revenue,
      coalesce(ei.margin, 0) + coalesce(pi.margin, 0) as margin
    from envios_items ei
    full outer join publico_items pi on pi.product_id = ei.product_id
    where (p_channel = 'all')
       or (p_channel = 'envios' and ei.product_id is not null)
       or (p_channel = 'publico' and pi.product_id is not null)
  )
  select 
    p.id as product_id,
    p.name as product_name,
    p.category,
    c.units,
    c.revenue,
    c.margin as margin_amount
  from combined c
  join public.products p on p.id = c.product_id
  order by c.revenue desc
  limit p_limit;
end;
$$;

-- 5) get_top_categories: Ranking de categorías más vendidas
create or replace function public.get_top_categories(
  p_from timestamptz,
  p_to timestamptz,
  p_channel text default 'all'
)
returns table (
  category text,
  units int,
  revenue numeric
)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  -- Verificar admin
  if not public.is_admin() then
    raise exception 'Solo administradores pueden acceder a estadísticas';
  end if;

  -- Validar canal
  if p_channel not in ('all', 'envios', 'publico') then
    raise exception 'p_channel debe ser all, envios o publico';
  end if;

  -- Retornar ranking
  return query
  with envios_items as (
    select 
      p.category,
      sum(oi.quantity)::int as units,
      sum(oi.quantity * oi.price_snapshot) as revenue
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
    join public.product_variants pv on pv.id = oi.variant_id
    join public.products p on p.id = pv.product_id
    where o.status = 'sent'
      and o.sent_at is not null
      and o.sent_at between p_from and p_to
      and oi.variant_id is not null
    group by p.category
  ),
  publico_items as (
    select 
      p.category,
      sum(case when psi.is_return then -psi.qty else psi.qty end)::int as units,
      sum((case when psi.is_return then -psi.qty else psi.qty end) * psi.price_snapshot) as revenue
    from public.public_sale_items psi
    join public.public_sales ps on ps.id = psi.sale_id
    join public.product_variants pv on pv.id = psi.variant_id
    join public.products p on p.id = pv.product_id
    where ps.created_at between p_from and p_to
    group by p.category
  ),
  combined as (
    select 
      coalesce(ei.category, pi.category) as category,
      coalesce(ei.units, 0) + coalesce(pi.units, 0) as units,
      coalesce(ei.revenue, 0) + coalesce(pi.revenue, 0) as revenue
    from envios_items ei
    full outer join publico_items pi on pi.category = ei.category
    where (p_channel = 'all')
       or (p_channel = 'envios' and ei.category is not null)
       or (p_channel = 'publico' and pi.category is not null)
  )
  select 
    c.category,
    c.units,
    c.revenue
  from combined c
  where c.category is not null
  order by c.revenue desc;
end;
$$;

-- 6) get_customer_kpis: KPIs de clientes
create or replace function public.get_customer_kpis(
  p_from timestamptz,
  p_to timestamptz
)
returns json
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_result json;
  v_customers_new int := 0;
  v_customers_with_purchase int := 0;
  v_customers_returning int := 0;
  v_customers_new_and_purchased_7d int := 0;
  v_customers_new_and_purchased_30d int := 0;
begin
  -- Verificar admin
  if not public.is_admin() then
    raise exception 'Solo administradores pueden acceder a estadísticas';
  end if;

  -- Clientes nuevos
  select count(*)::int
  into v_customers_new
  from public.customers
  where created_at between p_from and p_to;

  -- Clientes que compraron en el rango
  select count(distinct customer_id)::int
  into v_customers_with_purchase
  from (
    select customer_id from public.orders
    where status = 'sent' and sent_at is not null and sent_at between p_from and p_to
    union
    select customer_id from public.public_sales
    where created_at between p_from and p_to
      and customer_id is not null
  ) buyers;

  -- Clientes que volvieron (compraron en rango y su primera compra fue antes de p_from)
  with first_purchases as (
    select customer_id, min(first_date) as first_purchase_date
    from (
      select customer_id, min(sent_at::date) as first_date
      from public.orders
      where status = 'sent' and sent_at is not null
      group by customer_id
      union all
      select customer_id, min(created_at::date) as first_date
      from public.public_sales
      where customer_id is not null
      group by customer_id
    ) combined
    group by customer_id
  ),
  buyers_in_range as (
    select distinct customer_id
    from (
      select customer_id from public.orders
      where status = 'sent' and sent_at is not null and sent_at between p_from and p_to
      union
      select customer_id from public.public_sales
      where created_at between p_from and p_to and customer_id is not null
    ) buyers
  )
  select count(*)::int
  into v_customers_returning
  from buyers_in_range bir
  join first_purchases fp on fp.customer_id = bir.customer_id
  where fp.first_purchase_date < p_from::date;

  -- Nuevos que compraron en 7 días
  select count(distinct c.id)::int
  into v_customers_new_and_purchased_7d
  from public.customers c
  where c.created_at between p_from and p_to
    and exists (
      select 1 from public.orders o
      where o.customer_id = c.id
        and o.status = 'sent'
        and o.sent_at is not null
        and o.sent_at between c.created_at and (c.created_at + interval '7 days')
      union
      select 1 from public.public_sales ps
      where ps.customer_id = c.id
        and ps.created_at between c.created_at and (c.created_at + interval '7 days')
    );

  -- Nuevos que compraron en 30 días
  select count(distinct c.id)::int
  into v_customers_new_and_purchased_30d
  from public.customers c
  where c.created_at between p_from and p_to
    and exists (
      select 1 from public.orders o
      where o.customer_id = c.id
        and o.status = 'sent'
        and o.sent_at is not null
        and o.sent_at between c.created_at and (c.created_at + interval '30 days')
      union
      select 1 from public.public_sales ps
      where ps.customer_id = c.id
        and ps.created_at between c.created_at and (c.created_at + interval '30 days')
    );

  v_result := json_build_object(
    'customers_new', v_customers_new,
    'customers_with_purchase', v_customers_with_purchase,
    'customers_returning', v_customers_returning,
    'customers_new_and_purchased_7d', v_customers_new_and_purchased_7d,
    'customers_new_and_purchased_30d', v_customers_new_and_purchased_30d
  );

  return v_result;
end;
$$;

-- 7) get_customer_timeseries: Series temporales de clientes
create or replace function public.get_customer_timeseries(
  p_from timestamptz,
  p_to timestamptz,
  p_granularity text default 'day'
)
returns table (
  date date,
  new_customers int,
  buyers_unique int,
  returning_buyers int
)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  -- Verificar admin
  if not public.is_admin() then
    raise exception 'Solo administradores pueden acceder a estadísticas';
  end if;

  -- Validar granularidad
  if p_granularity not in ('day', 'week', 'month') then
    raise exception 'p_granularity debe ser day, week o month';
  end if;

  -- Retornar series temporales
  return query
  with dates as (
    select generate_series(
      case p_granularity
        when 'day' then (p_from AT TIME ZONE 'America/Argentina/Cordoba')::date
        when 'week' then date_trunc('week', (p_from AT TIME ZONE 'America/Argentina/Cordoba'))::date
        when 'month' then date_trunc('month', (p_from AT TIME ZONE 'America/Argentina/Cordoba'))::date
      end,
      case p_granularity
        when 'day' then (p_to AT TIME ZONE 'America/Argentina/Cordoba')::date
        when 'week' then date_trunc('week', (p_to AT TIME ZONE 'America/Argentina/Cordoba'))::date
        when 'month' then date_trunc('month', (p_to AT TIME ZONE 'America/Argentina/Cordoba'))::date
      end,
      case p_granularity
        when 'day' then '1 day'::interval
        when 'week' then '1 week'::interval
        when 'month' then '1 month'::interval
      end
    )::date as date
  ),
  new_customers_data as (
    select 
      case p_granularity
        when 'day' then (c.created_at AT TIME ZONE 'America/Argentina/Cordoba')::date
        when 'week' then date_trunc('week', (c.created_at AT TIME ZONE 'America/Argentina/Cordoba'))::date
        when 'month' then date_trunc('month', (c.created_at AT TIME ZONE 'America/Argentina/Cordoba'))::date
      end as reg_date,
      count(*)::int as new_count
    from public.customers c
    where c.created_at between p_from and p_to
    group by case p_granularity
        when 'day' then (c.created_at AT TIME ZONE 'America/Argentina/Cordoba')::date
        when 'week' then date_trunc('week', (c.created_at AT TIME ZONE 'America/Argentina/Cordoba'))::date
        when 'month' then date_trunc('month', (c.created_at AT TIME ZONE 'America/Argentina/Cordoba'))::date
      end
  ),
  buyers_data as (
    select 
      sale_date,
      count(distinct customer_id)::int as buyers_count
    from (
      select 
        case p_granularity
          when 'day' then (o.sent_at AT TIME ZONE 'America/Argentina/Cordoba')::date
          when 'week' then date_trunc('week', (o.sent_at AT TIME ZONE 'America/Argentina/Cordoba'))::date
          when 'month' then date_trunc('month', (o.sent_at AT TIME ZONE 'America/Argentina/Cordoba'))::date
        end as sale_date,
        o.customer_id
      from public.orders o
      where o.status = 'sent' and o.sent_at is not null and o.sent_at between p_from and p_to
      union
      select 
        case p_granularity
          when 'day' then (ps.created_at AT TIME ZONE 'America/Argentina/Cordoba')::date
          when 'week' then date_trunc('week', (ps.created_at AT TIME ZONE 'America/Argentina/Cordoba'))::date
          when 'month' then date_trunc('month', (ps.created_at AT TIME ZONE 'America/Argentina/Cordoba'))::date
        end as sale_date,
        ps.customer_id
      from public.public_sales ps
      where ps.created_at between p_from and p_to and ps.customer_id is not null
    ) combined
    group by sale_date
  ),
  first_purchases as (
    select customer_id, min(first_date) as first_purchase_date
    from (
      select customer_id, min(sent_at::date) as first_date
      from public.orders
      where status = 'sent' and sent_at is not null
      group by customer_id
      union all
      select customer_id, min(created_at::date) as first_date
      from public.public_sales
      where customer_id is not null
      group by customer_id
    ) combined
    group by customer_id
  ),
  returning_buyers_data as (
    select 
      sale_date,
      count(distinct customer_id)::int as returning_count
    from (
      select 
        case p_granularity
          when 'day' then (o.sent_at AT TIME ZONE 'America/Argentina/Cordoba')::date
          when 'week' then date_trunc('week', (o.sent_at AT TIME ZONE 'America/Argentina/Cordoba'))::date
          when 'month' then date_trunc('month', (o.sent_at AT TIME ZONE 'America/Argentina/Cordoba'))::date
        end as sale_date,
        o.customer_id
      from public.orders o
      join first_purchases fp on fp.customer_id = o.customer_id
      where o.status = 'sent' 
        and o.sent_at is not null 
        and o.sent_at between p_from and p_to
        and fp.first_purchase_date < p_from::date
      union
      select 
        case p_granularity
          when 'day' then (ps.created_at AT TIME ZONE 'America/Argentina/Cordoba')::date
          when 'week' then date_trunc('week', (ps.created_at AT TIME ZONE 'America/Argentina/Cordoba'))::date
          when 'month' then date_trunc('month', (ps.created_at AT TIME ZONE 'America/Argentina/Cordoba'))::date
        end as sale_date,
        ps.customer_id
      from public.public_sales ps
      join first_purchases fp on fp.customer_id = ps.customer_id
      where ps.created_at between p_from and p_to
        and ps.customer_id is not null
        and fp.first_purchase_date < p_from::date
    ) combined
    group by sale_date
  )
  select 
    d.date,
    coalesce(ncd.new_count, 0) as new_customers,
    coalesce(bd.buyers_count, 0) as buyers_unique,
    coalesce(rbd.returning_count, 0) as returning_buyers
  from dates d
  left join new_customers_data ncd on ncd.reg_date = d.date
  left join buyers_data bd on bd.sale_date = d.date
  left join returning_buyers_data rbd on rbd.sale_date = d.date
  order by d.date;
end;
$$;

-- 8) get_order_source_breakdown: Desglose de pedidos por origen (solo envíos)
create or replace function public.get_order_source_breakdown(
  p_from timestamptz,
  p_to timestamptz
)
returns json
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_result json;
  v_orders_customer int := 0;
  v_orders_admin int := 0;
  v_revenue_customer numeric := 0;
  v_revenue_admin numeric := 0;
begin
  -- Verificar admin
  if not public.is_admin() then
    raise exception 'Solo administradores pueden acceder a estadísticas';
  end if;

  -- Pedidos y revenue por origen (solo sent con sent_at)
  select 
    count(*) filter (where o.source = 'customer' or o.source is null)::int,
    count(*) filter (where o.source = 'admin')::int,
    coalesce(sum(o.total_amount) filter (where o.source = 'customer' or o.source is null), 0),
    coalesce(sum(o.total_amount) filter (where o.source = 'admin'), 0)
  into 
    v_orders_customer,
    v_orders_admin,
    v_revenue_customer,
    v_revenue_admin
  from public.orders o
  where o.status = 'sent'
    and o.sent_at is not null
    and o.sent_at between p_from and p_to;

  v_result := json_build_object(
    'orders_customer', v_orders_customer,
    'orders_admin', v_orders_admin,
    'revenue_customer', v_revenue_customer,
    'revenue_admin', v_revenue_admin
  );

  return v_result;
end;
$$;

-- 9) get_customer_registration_methods: Métodos de registro de clientes
create or replace function public.get_customer_registration_methods(
  p_from timestamptz,
  p_to timestamptz
)
returns json
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_result json;
  v_oauth int := 0;
  v_magiclink int := 0;
  v_admin_created int := 0;
  v_email int := 0;
begin
  -- Verificar admin
  if not public.is_admin() then
    raise exception 'Solo administradores pueden acceder a estadísticas';
  end if;

  -- Contar por método de registro
  select 
    count(*) filter (where auth_provider = 'google')::int,
    count(*) filter (where auth_provider = 'magiclink')::int,
    count(*) filter (where created_by_admin = true or auth_provider = 'admin')::int,
    count(*) filter (where auth_provider = 'email' and (created_by_admin is null or created_by_admin = false))::int
  into 
    v_oauth,
    v_magiclink,
    v_admin_created,
    v_email
  from public.customers
  where created_at between p_from and p_to;

  v_result := json_build_object(
    'oauth', v_oauth,
    'magiclink', v_magiclink,
    'admin_created', v_admin_created,
    'email', v_email
  );

  return v_result;
end;
$$;

-- Recargar esquema
select pg_notify('pgrst','reload schema');

