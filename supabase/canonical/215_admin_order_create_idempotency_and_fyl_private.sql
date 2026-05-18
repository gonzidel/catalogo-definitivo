-- 215_admin_order_create_idempotency_and_fyl_private.sql
--
-- Staging-first: tabla de idempotencia para rpc_create_admin_order_atomic (v1)
-- + schema fyl_private (helpers no expuestos a PostgREST por defecto).
--
-- NO reemplaza createNewOrder ni order-creator.js.
-- NO modifica rpc_apply_order_stock_deduction (166) ni rpc_admin_manual_inject_and_deduct (179).
--
-- Rollback: ver 215_ROLLBACK_admin_order_create_idempotency_and_fyl_private.sql

-- 1) Extensión para digest SHA-256 (payload_hash). Idempotente.
create extension if not exists pgcrypto;

-- 2) Schema interno FYL (no incluir en exposición API PostgREST).
create schema if not exists fyl_private;
comment on schema fyl_private is
  'Funciones internas FYL (sin GRANT a roles de app). rpc_create_admin_order_atomic vive en public.';

grant usage on schema fyl_private to postgres, supabase_admin;

-- 3) Tabla dedupe (contrato v1: pending → success en la misma TX que el pedido).
create table if not exists public.admin_order_create_idempotency (
  idempotency_key uuid primary key,
  admin_user_id   uuid not null,
  payload_hash    text not null,
  status          text not null
    constraint admin_order_create_idempotency_status_chk
      check (status in ('pending', 'success')),
  order_id        uuid references public.orders (id) on delete set null,
  response_jsonb  jsonb,
  created_at      timestamptz not null default now(),
  completed_at    timestamptz,
  constraint admin_order_create_idempotency_success_requires_order
    check (status <> 'success' or order_id is not null)
);

create index if not exists admin_order_create_idempotency_admin_created_idx
  on public.admin_order_create_idempotency (admin_user_id, created_at desc);

comment on table public.admin_order_create_idempotency is
  'Idempotencia fuerte alta pedido admin (rpc_create_admin_order_atomic). Filas pending desaparecen en rollback.';

-- Sin RLS: acceso bloqueado por REVOKE; solo el owner/definer escribe vía RPC.
revoke all on public.admin_order_create_idempotency from public;
revoke all on public.admin_order_create_idempotency from anon, authenticated;

select pg_notify('pgrst', 'reload schema');
