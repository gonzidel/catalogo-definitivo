-- Tabla de clientes (perfiles) y políticas RLS

create table if not exists public.customers (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  address text,
  city text,
  province text,
  phone text,
  dni text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- trigger de updated_at
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end; $$;

do $$ begin
  if not exists (
    select 1 from pg_trigger where tgname = 'customers_set_updated_at'
  ) then
    create trigger customers_set_updated_at
      before update on public.customers
      for each row execute function public.set_updated_at();
  end if;
end $$;

alter table public.customers enable row level security;

-- El usuario autenticado solo puede ver/editar su propio perfil
create policy if not exists customers_self_select
  on public.customers for select to authenticated
  using (id = auth.uid());

create policy if not exists customers_self_upsert
  on public.customers for insert to authenticated
  with check (id = auth.uid());

create policy if not exists customers_self_update
  on public.customers for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- Recargar esquema
select pg_notify('pgrst','reload schema');

