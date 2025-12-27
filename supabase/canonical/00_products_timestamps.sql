-- 00_products_timestamps.sql — agrega timestamps a products (idempotente)

-- Columnas creadas si no existen
alter table public.products
  add column if not exists created_at timestamptz default now(),
  add column if not exists updated_at timestamptz default now();

-- Trigger updated_at (reutiliza la función canónica)
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'products_set_updated_at') then
    create trigger products_set_updated_at
      before update on public.products
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- Recarga del esquema REST (opcional)
select pg_notify('pgrst','reload schema');

