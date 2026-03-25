-- 128_fix_daily_sales_public_sales_link.sql
-- Vincula daily_sales con public_sales por id para evitar faltantes.

-- 1) Agregar columna public_sale_id (idempotente)
alter table public.daily_sales
add column if not exists public_sale_id uuid;

-- 2) FK a public_sales (idempotente)
do $$
begin
  if not exists (
    select 1
    from information_schema.table_constraints
    where constraint_schema = 'public'
      and table_name = 'daily_sales'
      and constraint_name = 'daily_sales_public_sale_id_fk'
  ) then
    alter table public.daily_sales
      add constraint daily_sales_public_sale_id_fk
      foreign key (public_sale_id)
      references public.public_sales(id)
      on delete set null;
  end if;
end $$;

-- 3) Constraint única (permite múltiples NULL)
do $$
begin
  if not exists (
    select 1
    from information_schema.table_constraints
    where constraint_schema = 'public'
      and table_name = 'daily_sales'
      and constraint_name = 'daily_sales_public_sale_id_uk'
  ) then
    alter table public.daily_sales
      add constraint daily_sales_public_sale_id_uk unique (public_sale_id);
  end if;
end $$;

-- 4) Reemplazar función del trigger para insertar por public_sale_id
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
  if NEW.customer_id is not null then
    select coalesce(
      nullif(trim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')), ''),
      'Cliente sin nombre'
    )
    into v_customer_name
    from public.public_sales_customers
    where id = NEW.customer_id;
  else
    v_customer_name := 'Cliente sin nombre';
  end if;

  v_sale_time := ((NEW.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::time);
  v_total_items := NEW.item_count;

  insert into public.daily_sales (
    public_sale_id,
    sale_date,
    sale_type,
    sale_time,
    customer_name,
    product_quantity,
    sale_amount,
    created_by
  ) values (
    NEW.id,
    (NEW.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date,
    'local',
    v_sale_time,
    v_customer_name,
    v_total_items,
    NEW.total_amount,
    NEW.sold_by
  )
  on conflict (public_sale_id) do nothing;

  return NEW;
end;
$$;

-- 5) Asegurar trigger AFTER INSERT sobre public_sales (idempotente)
do $$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgname = 'trigger_register_local_sale'
  ) then
    create trigger trigger_register_local_sale
      after insert on public.public_sales
      for each row
      execute function public.register_local_sale_to_daily_sales();
  end if;
end $$;

-- 6) Backfill opcional (ejecutar por fecha cuando haga falta)
-- Reemplaza la fecha según corresponda.
-- insert into public.daily_sales (
--   public_sale_id, sale_date, sale_type, sale_time,
--   customer_name, product_quantity, sale_amount, created_by
-- )
-- select
--   ps.id as public_sale_id,
--   (ps.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date as sale_date,
--   'local' as sale_type,
--   ((ps.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::time) as sale_time,
--   coalesce(
--     nullif(trim(coalesce(psc.first_name, '') || ' ' || coalesce(psc.last_name, '')), ''),
--     'Cliente sin nombre'
--   ) as customer_name,
--   ps.item_count as product_quantity,
--   ps.total_amount as sale_amount,
--   ps.sold_by as created_by
-- from public.public_sales ps
-- left join public.public_sales_customers psc on psc.id = ps.customer_id
-- left join public.daily_sales ds on ds.public_sale_id = ps.id
-- where (ps.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date = '2026-03-14'
--   and ds.id is null;

select pg_notify('pgrst','reload schema');
