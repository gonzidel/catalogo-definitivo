-- 21_payment_methods.sql - Tabla de métodos de pago y columna en orders

-- Crear tabla de métodos de pago
create table if not exists public.payment_methods (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Crear índice único en name
create unique index if not exists payment_methods_name_unique 
  on public.payment_methods(name);

-- Agregar columna payment_method a orders
alter table public.orders
  add column if not exists payment_method text;

-- Insertar métodos de pago por defecto (si no existen)
insert into public.payment_methods (name)
values ('Contra Reembolso')
on conflict (name) do nothing;

insert into public.payment_methods (name)
values ('Pagado')
on conflict (name) do nothing;

-- Habilitar RLS en payment_methods
alter table public.payment_methods enable row level security;

-- Política para que todos los usuarios autenticados puedan leer métodos de pago
create policy "Los usuarios autenticados pueden leer métodos de pago"
  on public.payment_methods
  for select
  using (auth.role() = 'authenticated');

-- Política para que solo admins puedan crear métodos de pago
create policy "Solo admins pueden crear métodos de pago"
  on public.payment_methods
  for insert
  with check (
    exists (
      select 1 from public.admins
      where user_id = auth.uid()
    )
  );

-- Política para que solo admins puedan actualizar métodos de pago
create policy "Solo admins pueden actualizar métodos de pago"
  on public.payment_methods
  for update
  using (
    exists (
      select 1 from public.admins
      where user_id = auth.uid()
    )
  );

-- Política para que solo admins puedan eliminar métodos de pago
create policy "Solo admins pueden eliminar métodos de pago"
  on public.payment_methods
  for delete
  using (
    exists (
      select 1 from public.admins
      where user_id = auth.uid()
    )
  );

-- Comentarios
comment on table public.payment_methods is 'Métodos de pago disponibles para los pedidos';
comment on column public.payment_methods.name is 'Nombre del método de pago (ej: "Contra Reembolso", "Pagado")';
comment on column public.orders.payment_method is 'Método de pago seleccionado para el pedido';

-- Notificar recarga del esquema
select pg_notify('pgrst','reload schema');
