-- 05_orders.sql — Carrito, reservas y RPC (idempotente)

create or replace function public.set_updated_at()
returns trigger language plpgsql
SET search_path = public, pg_catalog
as $$
begin
  if to_jsonb(new) ? 'updated_at' then
    new.updated_at = now();
  end if;
  return new;
end $$;

alter table public.product_variants
  add column if not exists reserved_qty int default 0;

create table if not exists public.carts (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  status text not null default 'open',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.cart_items (
  id uuid primary key default gen_random_uuid(),
  cart_id uuid not null references public.carts(id) on delete cascade,
  variant_id uuid not null references public.product_variants(id) on delete cascade,
  qty int not null check (qty > 0),
  status text not null default 'reserved',
  price_snapshot numeric,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'carts_set_updated_at') then
    create trigger carts_set_updated_at before update on public.carts
      for each row execute function public.set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'cart_items_set_updated_at') then
    create trigger cart_items_set_updated_at before update on public.cart_items
      for each row execute function public.set_updated_at();
  end if;
end $$;

alter table public.carts enable row level security;
alter table public.cart_items enable row level security;

drop policy if exists carts_self_access on public.carts;
drop policy if exists carts_admin_access on public.carts;
drop policy if exists cart_items_self_access on public.cart_items;
drop policy if exists cart_items_admin_access on public.cart_items;

create policy carts_self_access on public.carts
  for all to authenticated
  using (customer_id = auth.uid())
  with check (customer_id = auth.uid());

create policy cart_items_self_access on public.cart_items
  for all to authenticated
  using (exists (select 1 from public.carts c where c.id = cart_id and c.customer_id = auth.uid()))
  with check (exists (select 1 from public.carts c where c.id = cart_id and c.customer_id = auth.uid()));

create policy carts_admin_access on public.carts
  for all to authenticated
  using (exists (select 1 from public.admins a where a.user_id = auth.uid()))
  with check (exists (select 1 from public.admins a where a.user_id = auth.uid()));

create policy cart_items_admin_access on public.cart_items
  for all to authenticated
  using (exists (select 1 from public.admins a where a.user_id = auth.uid()))
  with check (exists (select 1 from public.admins a where a.user_id = auth.uid()));

drop function if exists public.rpc_get_or_create_cart();
create or replace function public.rpc_get_or_create_cart()
returns uuid language plpgsql security definer
SET search_path = public, pg_catalog
as $$
declare cid uuid;
begin
  select id into cid from public.carts where customer_id = auth.uid() and status = 'open' limit 1;
  if cid is null then
    insert into public.carts(id, customer_id, status) values (gen_random_uuid(), auth.uid(), 'open') returning id into cid;
  end if;
  return cid;
end $$;

drop function if exists public.rpc_reserve_item(uuid,int);
create or replace function public.rpc_reserve_item(variant uuid, qty int)
returns uuid language plpgsql security definer
SET search_path = public, pg_catalog
as $$
declare cid uuid; v_available int; item_id uuid; v_price numeric;
begin
  if qty <= 0 then raise exception 'qty must be > 0'; end if;
  select rpc_get_or_create_cart() into cid;
  select stock_qty - reserved_qty into v_available from public.product_variants where id = variant for update;
  if v_available < qty then raise exception 'No hay disponibilidad suficiente'; end if;
  select price into v_price from public.product_variants where id = variant;
  update public.product_variants set reserved_qty = reserved_qty + qty where id = variant;
  insert into public.cart_items(id, cart_id, variant_id, qty, status, price_snapshot)
    values (gen_random_uuid(), cid, variant, qty, 'reserved', v_price)
    returning id into item_id;
  return item_id;
end $$;

drop function if exists public.rpc_submit_cart(uuid);
create or replace function public.rpc_submit_cart(cid uuid)
returns void language plpgsql security definer
SET search_path = public, pg_catalog
as $$
begin
  update public.carts set status = 'submitted'
   where id = cid and customer_id = auth.uid() and status = 'open';
end $$;

drop function if exists public.rpc_admin_set_item_status(uuid,text);
create or replace function public.rpc_admin_set_item_status(item uuid, new_status text)
returns void language plpgsql security definer
SET search_path = public, pg_catalog
as $$
declare v_variant uuid; v_qty int;
begin
  if not exists (select 1 from public.admins a where a.user_id = auth.uid()) then
    raise exception 'forbidden';
  end if;
  if new_status = 'confirmed' then
    update public.cart_items set status = 'confirmed'
     where id = item and status in ('reserved','confirmed');
  elsif new_status = 'rejected' then
    select variant_id, qty into v_variant, v_qty from public.cart_items where id = item;
    update public.product_variants set reserved_qty = reserved_qty - v_qty where id = v_variant;
    update public.cart_items set status = 'rejected' where id = item;
  else
    raise exception 'Estado no soportado: %', new_status;
  end if;
end $$;

drop function if exists public.rpc_close_cart(uuid);
create or replace function public.rpc_close_cart(cid uuid)
returns void language plpgsql security definer
SET search_path = public, pg_catalog
as $$
declare r record;
begin
  if not exists (select 1 from public.admins a where a.user_id = auth.uid()) then
    raise exception 'forbidden';
  end if;
  for r in select variant_id, qty from public.cart_items where cart_id = cid and status = 'confirmed'
  loop
    update public.product_variants
       set stock_qty = stock_qty - r.qty,
           reserved_qty = reserved_qty - r.qty
     where id = r.variant_id;
  end loop;
  update public.carts set status = 'closed' where id = cid;
end $$;

select pg_notify('pgrst','reload schema');

