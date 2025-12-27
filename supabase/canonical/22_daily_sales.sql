-- 22_daily_sales.sql — Ventas diarias (Local y Envíos) + RLS (idempotente)

-- Crear tabla de ventas diarias
create table if not exists public.daily_sales (
  id uuid primary key default gen_random_uuid(),
  sale_date date not null,
  sale_type text not null check (sale_type in ('local', 'envios')),
  sale_time time not null,
  customer_name text not null,
  product_quantity integer not null check (product_quantity >= 0),
  sale_amount numeric(10,2) not null check (sale_amount >= 0),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Crear índices para búsquedas eficientes
create index if not exists idx_daily_sales_date on public.daily_sales(sale_date);
create index if not exists idx_daily_sales_type on public.daily_sales(sale_type);
create index if not exists idx_daily_sales_date_type on public.daily_sales(sale_date, sale_type);

-- Trigger para updated_at
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'daily_sales_set_updated_at') then
    create trigger daily_sales_set_updated_at
      before update on public.daily_sales
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- Habilitar RLS
alter table public.daily_sales enable row level security;

-- Eliminar políticas existentes si existen
drop policy if exists daily_sales_admin_all on public.daily_sales;

-- Política RLS: Solo admins pueden ver y gestionar ventas diarias
do $$ begin
  if not exists (
    select 1 from pg_policies 
    where schemaname='public' 
    and tablename='daily_sales' 
    and policyname='daily_sales_admin_all'
  ) then
    create policy daily_sales_admin_all on public.daily_sales
      for all to authenticated
      using (exists (select 1 from public.admins a where a.user_id = auth.uid()))
      with check (exists (select 1 from public.admins a where a.user_id = auth.uid()));
  end if;
end $$;

-- Función RPC para obtener resumen diario de ventas
create or replace function public.get_daily_sales_summary(
  p_sale_date date default current_date,
  p_sale_type text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result json;
  v_total_sales integer;
  v_total_amount numeric;
  v_local_sales integer;
  v_local_amount numeric;
  v_envios_sales integer;
  v_envios_amount numeric;
begin
  -- Verificar que el usuario es admin
  if not exists (select 1 from public.admins a where a.user_id = auth.uid()) then
    raise exception 'Solo los administradores pueden consultar ventas diarias';
  end if;

  -- Si se especifica un tipo, filtrar por ese tipo
  if p_sale_type is not null and p_sale_type in ('local', 'envios') then
    select 
      count(*)::integer,
      coalesce(sum(sale_amount), 0)
    into v_total_sales, v_total_amount
    from public.daily_sales
    where sale_date = p_sale_date
      and sale_type = p_sale_type;
    
    v_result := json_build_object(
      'date', p_sale_date,
      'type', p_sale_type,
      'total_sales', v_total_sales,
      'total_amount', v_total_amount
    );
  else
    -- Obtener totales generales y por tipo
    select 
      count(*)::integer,
      coalesce(sum(sale_amount), 0)
    into v_total_sales, v_total_amount
    from public.daily_sales
    where sale_date = p_sale_date;
    
    select 
      count(*)::integer,
      coalesce(sum(sale_amount), 0)
    into v_local_sales, v_local_amount
    from public.daily_sales
    where sale_date = p_sale_date
      and sale_type = 'local';
    
    select 
      count(*)::integer,
      coalesce(sum(sale_amount), 0)
    into v_envios_sales, v_envios_amount
    from public.daily_sales
    where sale_date = p_sale_date
      and sale_type = 'envios';
    
    v_result := json_build_object(
      'date', p_sale_date,
      'total_sales', v_total_sales,
      'total_amount', v_total_amount,
      'local', json_build_object(
        'sales', v_local_sales,
        'amount', v_local_amount
      ),
      'envios', json_build_object(
        'sales', v_envios_sales,
        'amount', v_envios_amount
      )
    );
  end if;
  
  return v_result;
end;
$$;

-- Trigger para registrar ventas locales automáticamente desde public_sales
create or replace function public.register_local_sale_to_daily_sales()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer_name text;
  v_sale_time time;
  v_total_items int;
begin
  -- Obtener nombre del cliente si existe
  if NEW.customer_id is not null then
    select coalesce(
      first_name || ' ' || coalesce(last_name, ''),
      'Cliente sin nombre'
    )
    into v_customer_name
    from public.public_sales_customers
    where id = NEW.customer_id;
  else
    v_customer_name := 'Cliente sin nombre';
  end if;
  
  -- Extraer hora de created_at
  v_sale_time := (NEW.created_at::time);
  
  -- Usar item_count como cantidad de productos
  v_total_items := NEW.item_count;
  
  -- Verificar que no exista ya un registro para esta venta
  -- Usamos una combinación única de sale_date, sale_type, sale_time y monto para identificar ventas únicas
  if not exists (
    select 1 from public.daily_sales
    where sale_date = NEW.created_at::date
      and sale_type = 'local'
      and sale_time = v_sale_time
      and sale_amount = NEW.total_amount
      and customer_name = v_customer_name
      and product_quantity = v_total_items
  ) then
    -- Insertar en daily_sales
    insert into public.daily_sales (
      sale_date,
      sale_type,
      sale_time,
      customer_name,
      product_quantity,
      sale_amount,
      created_by
    ) values (
      NEW.created_at::date,
      'local',
      v_sale_time,
      v_customer_name,
      v_total_items,
      NEW.total_amount,
      NEW.sold_by
    );
  end if;
  
  return NEW;
end;
$$;

-- Crear trigger después de insertar en public_sales
do $$
begin
  if not exists (
    select 1 from pg_trigger 
    where tgname = 'trigger_register_local_sale'
  ) then
    create trigger trigger_register_local_sale
      after insert on public.public_sales
      for each row
      execute function public.register_local_sale_to_daily_sales();
  end if;
end $$;

-- Trigger para registrar envíos automáticamente desde orders cuando se marca como sent
create or replace function public.register_envio_to_daily_sales()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer_name text;
  v_sale_time time;
  v_total_items int;
  v_total_amount numeric;
begin
  -- Solo procesar cuando el status cambia a 'sent' y sent_at se establece
  if NEW.status = 'sent' and NEW.sent_at is not null and (OLD.status is distinct from 'sent' or OLD.sent_at is null) then
    -- Obtener nombre del cliente
    if NEW.customer_id is not null then
      select coalesce(full_name, 'Cliente sin nombre')
      into v_customer_name
      from public.customers
      where id = NEW.customer_id;
    else
      v_customer_name := 'Cliente sin nombre';
    end if;
    
    -- Extraer hora de sent_at (o created_at si sent_at no tiene hora)
    v_sale_time := (NEW.sent_at::time);
    
    -- Contar items del pedido
    select count(*), coalesce(sum(quantity), 0)
    into v_total_items, v_total_amount
    from public.order_items
    where order_id = NEW.id
      and status != 'cancelled';
    
    -- Si no hay items, usar total_amount del pedido y cantidad 0
    if v_total_items = 0 then
      v_total_items := 0;
      v_total_amount := coalesce(NEW.total_amount, 0);
    end if;
    
    -- Verificar que no exista ya un registro para este envío
    if not exists (
      select 1 from public.daily_sales
      where sale_date = NEW.sent_at::date
        and sale_type = 'envios'
        and sale_time = v_sale_time
        and sale_amount = coalesce(v_total_amount, NEW.total_amount, 0)
        and customer_name = v_customer_name
        and product_quantity = v_total_items
    ) then
      -- Insertar en daily_sales
      insert into public.daily_sales (
        sale_date,
        sale_type,
        sale_time,
        customer_name,
        product_quantity,
        sale_amount,
        created_by
      ) values (
        NEW.sent_at::date,
        'envios',
        v_sale_time,
        v_customer_name,
        v_total_items,
        coalesce(v_total_amount, NEW.total_amount, 0),
        auth.uid()
      );
    end if;
    
  end if;
  
  return NEW;
end;
$$;

-- Crear trigger después de actualizar orders
do $$
begin
  if not exists (
    select 1 from pg_trigger 
    where tgname = 'trigger_register_envio_sale'
  ) then
    create trigger trigger_register_envio_sale
      after update on public.orders
      for each row
      execute function public.register_envio_to_daily_sales();
  end if;
end $$;

-- Recargar esquema
select pg_notify('pgrst','reload schema');
