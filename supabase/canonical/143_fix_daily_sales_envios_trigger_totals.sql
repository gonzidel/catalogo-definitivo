-- 143_fix_daily_sales_envios_trigger_totals.sql
-- Corrige el monto de envíos en daily_sales y agrega una RPC para resincronizar por fecha.

create or replace function public.register_envio_to_daily_sales()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer_name text;
  v_event_at timestamptz;
  v_sale_time time;
  v_sale_date date;
  v_total_items int;
  v_items_amount numeric;
  v_total_amount numeric;
begin
  -- Procesar cuando el pedido pasa a "sent" o cuando su fecha efectiva de envío cambia.
  if NEW.status = 'sent'
     and (
       OLD.status is distinct from 'sent'
       or NEW.sent_at is distinct from OLD.sent_at
     ) then

    -- Si sent_at no está poblado por alguna versión antigua de RPC, usar updated_at como fallback.
    v_event_at := coalesce(NEW.sent_at, NEW.updated_at, now());
    v_sale_time := ((v_event_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::time);
    v_sale_date := (v_event_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date;

    if NEW.customer_id is not null then
      select coalesce(c.full_name, 'Cliente sin nombre')
      into v_customer_name
      from public.customers c
      where c.id = NEW.customer_id;
    else
      v_customer_name := 'Cliente sin nombre';
    end if;

    -- Cantidad de prendas y subtotal de líneas (no canceladas).
    select
      coalesce(sum(oi.quantity), 0)::int,
      coalesce(sum(oi.quantity * coalesce(oi.price_snapshot, 0)), 0)
    into v_total_items, v_items_amount
    from public.order_items oi
    where oi.order_id = NEW.id
      and oi.status <> 'cancelled';

    -- Monto del envío: priorizar total_amount del pedido y luego subtotal de líneas.
    v_total_amount := coalesce(nullif(NEW.total_amount, 0), nullif(v_items_amount, 0), 0);

    if not exists (
      select 1
      from public.daily_sales ds
      where ds.sale_date = v_sale_date
        and ds.sale_type = 'envios'
        and ds.sale_time = v_sale_time
        and ds.customer_name = v_customer_name
        and ds.product_quantity = v_total_items
        and abs(ds.sale_amount - v_total_amount) < 0.01
    ) then
      insert into public.daily_sales (
        sale_date,
        sale_type,
        sale_time,
        customer_name,
        product_quantity,
        sale_amount,
        created_by
      ) values (
        v_sale_date,
        'envios',
        v_sale_time,
        v_customer_name,
        v_total_items,
        v_total_amount,
        auth.uid()
      );
    end if;
  end if;

  return NEW;
end;
$$;

drop function if exists public.rpc_sync_daily_sales_envios_by_date(date);
create or replace function public.rpc_sync_daily_sales_envios_by_date(p_sale_date date default current_date)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows_inserted integer;
begin
  if not exists (select 1 from public.admins a where a.user_id = auth.uid()) then
    raise exception 'Solo administradores pueden sincronizar envíos';
  end if;

  -- Reemplazar snapshot del día para envíos y evitar arrastrar montos viejos incorrectos.
  delete from public.daily_sales
  where sale_type = 'envios'
    and sale_date = p_sale_date;

  insert into public.daily_sales (
    sale_date,
    sale_type,
    sale_time,
    customer_name,
    product_quantity,
    sale_amount,
    created_by
  )
  select
    (coalesce(o.sent_at, o.updated_at) AT TIME ZONE 'America/Argentina/Buenos_Aires')::date as sale_date,
    'envios' as sale_type,
    (coalesce(o.sent_at, o.updated_at) AT TIME ZONE 'America/Argentina/Buenos_Aires')::time as sale_time,
    coalesce(c.full_name, 'Cliente sin nombre') as customer_name,
    coalesce((
      select sum(oi.quantity)::int
      from public.order_items oi
      where oi.order_id = o.id
        and oi.status <> 'cancelled'
    ), 0) as product_quantity,
    coalesce(
      nullif(o.total_amount, 0),
      nullif((
        select sum(oi.quantity * coalesce(oi.price_snapshot, 0))
        from public.order_items oi
        where oi.order_id = o.id
          and oi.status <> 'cancelled'
      ), 0),
      0
    ) as sale_amount,
    auth.uid() as created_by
  from public.orders o
  left join public.customers c on c.id = o.customer_id
  where o.status = 'sent'
    and coalesce(o.sent_at, o.updated_at) is not null
    and (coalesce(o.sent_at, o.updated_at) AT TIME ZONE 'America/Argentina/Buenos_Aires')::date = p_sale_date;

  get diagnostics v_rows_inserted = row_count;
  return v_rows_inserted;
end;
$$;

comment on function public.rpc_sync_daily_sales_envios_by_date(date) is
  'Reconstituye registros de envíos en daily_sales para una fecha concreta, usando orders + order_items con monto correcto.';

select pg_notify('pgrst', 'reload schema');
