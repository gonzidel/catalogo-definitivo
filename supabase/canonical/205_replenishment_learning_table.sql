-- 205_replenishment_learning_table.sql
-- Persistencia de aprendizaje para ajuste automático de reposición.

create table if not exists public.replenishment_learning (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  factor_ajuste numeric not null,
  tipo_ajuste text not null check (tipo_ajuste in ('aumento', 'reduccion', 'neutro')),
  motivo text,
  created_at timestamptz not null default now(),
  activo boolean not null default true
);

create index if not exists idx_replenishment_learning_product_created
  on public.replenishment_learning(product_id, created_at desc);

create index if not exists idx_replenishment_learning_activo
  on public.replenishment_learning(product_id)
  where activo = true;

select pg_notify('pgrst','reload schema');

