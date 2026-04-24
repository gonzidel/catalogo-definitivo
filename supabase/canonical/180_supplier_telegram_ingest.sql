-- 180_supplier_telegram_ingest.sql
--
-- Módulo paralelo "Proveedores": ingest desde Telegram (n8n + OpenAI).
-- Sin FKs al core FYL (pedidos, stock, carrito, clientes del catálogo).
-- Evolución futura: tabla public.suppliers (catálogo FYL, 15_suppliers.sql) es distinta;
--   aquí supplier_orders.supplier_name es texto libre; más adelante supplier_id normalizado.

-- ---------------------------------------------------------------------------
-- 1) Tablas
-- ---------------------------------------------------------------------------

create table if not exists public.supplier_message_ingest (
  id uuid primary key default gen_random_uuid(),
  telegram_message_id bigint not null,
  telegram_chat_id bigint not null,
  message_type text not null,
  raw_text text,
  transcript_text text,
  caption_text text,
  file_path text,
  mime_type text,
  storage_bucket text,
  storage_object_path text,
  openai_input_text text,
  telegram_update_raw jsonb,
  openai_model text,
  openai_response_raw jsonb,
  parse_error text,
  parse_confidence numeric(5,4),
  needs_review boolean not null default false,
  has_actionable_order boolean not null default false,
  inferred_supplier_name text,
  parsed_status text not null default 'received'
    check (parsed_status in (
      'received',
      'parsed',
      'needs_review',
      'failed',
      'no_order_content'
    )),
  is_processed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint supplier_message_ingest_telegram_unique
    unique (telegram_chat_id, telegram_message_id)
);

comment on table public.supplier_message_ingest is
  'Ingest de mensajes Telegram para pedidos a proveedores (sistema paralelo al catálogo FYL).';
comment on column public.supplier_message_ingest.is_processed is
  'true cuando el pipeline terminó (éxito o fallo/no-pedido); evita duplicar pedidos en reintentos.';
comment on column public.supplier_message_ingest.storage_bucket is
  'Bucket Supabase Storage (referencia estable; no usar solo URLs firmadas).';
comment on column public.supplier_message_ingest.storage_object_path is
  'Ruta del objeto en el bucket; verdad operativa para recuperar audio/imagen.';
comment on column public.supplier_message_ingest.inferred_supplier_name is
  'Denormalizado por n8n tras parseo para listados admin sin join obligatorio.';

create index if not exists ix_supplier_message_ingest_created_at
  on public.supplier_message_ingest (created_at desc);
create index if not exists ix_supplier_message_ingest_needs_review
  on public.supplier_message_ingest (needs_review)
  where needs_review = true;
create index if not exists ix_supplier_message_ingest_parsed_status
  on public.supplier_message_ingest (parsed_status);
create index if not exists ix_supplier_message_ingest_is_processed
  on public.supplier_message_ingest (is_processed);

create table if not exists public.supplier_orders (
  id uuid primary key default gen_random_uuid(),
  source_message_id uuid not null
    references public.supplier_message_ingest (id) on delete cascade,
  supplier_name text,
  order_date date,
  status text not null default 'open',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint supplier_orders_one_per_message unique (source_message_id)
);

comment on table public.supplier_orders is
  'Cabecera de pedido interpretado a proveedor (módulo paralelo).';
comment on column public.supplier_orders.supplier_name is
  'Texto libre; futura normalización vía supplier_id + tabla dedicada de proveedores de compras.';

create index if not exists ix_supplier_orders_created_at
  on public.supplier_orders (created_at desc);

create table if not exists public.supplier_order_lines (
  id uuid primary key default gen_random_uuid(),
  supplier_order_id uuid not null
    references public.supplier_orders (id) on delete cascade,
  raw_line_text text,
  article_code text,
  color text,
  size text,
  quantity numeric,
  unit text,
  confidence numeric(5,4),
  review_status text not null default 'ok'
    check (review_status in ('ok', 'needs_review')),
  created_at timestamptz not null default now()
);

create index if not exists ix_supplier_order_lines_order
  on public.supplier_order_lines (supplier_order_id);

alter table public.supplier_orders
  add column if not exists updated_at timestamptz not null default now();

-- ---------------------------------------------------------------------------
-- 2) Triggers updated_at
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'supplier_message_ingest_set_updated_at') then
    create trigger supplier_message_ingest_set_updated_at
      before update on public.supplier_message_ingest
      for each row execute function public.set_updated_at();
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'supplier_orders_set_updated_at') then
    create trigger supplier_orders_set_updated_at
      before update on public.supplier_orders
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- supplier_order_lines: sin updated_at en esquema MVP

-- ---------------------------------------------------------------------------
-- 3) RLS — solo admins autenticados (JWT). Service role (n8n) bypass RLS.
-- ---------------------------------------------------------------------------

-- Misma semántica que compras-proveedores.html: colaboradores con permiso `proveedores`.
-- Si 181_purchase_suppliers_module.sql ya se aplicó, esta definición queda idéntica (create or replace).
create or replace function public.purchase_module_admin_auth(check_user_id uuid default auth.uid())
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_admin_id uuid;
begin
  if check_user_id is null then
    return false;
  end if;

  if public.is_super_admin(check_user_id) then
    return true;
  end if;

  select a.id into v_admin_id
  from public.admins a
  where a.user_id = check_user_id
  limit 1;

  if v_admin_id is null then
    return false;
  end if;

  return exists (
    select 1
    from public.admin_permissions p
    where p.admin_id = v_admin_id
      and p.permission_key = 'proveedores'
      and (
        coalesce(p.can_view, false)
        or coalesce(p.can_edit, false)
        or coalesce(p.can_delete, false)
      )
  );
end;
$$;

grant execute on function public.purchase_module_admin_auth(uuid) to authenticated;
grant execute on function public.purchase_module_admin_auth(uuid) to service_role;

alter table public.supplier_message_ingest enable row level security;
alter table public.supplier_orders enable row level security;
alter table public.supplier_order_lines enable row level security;

drop policy if exists supplier_message_ingest_admin_select on public.supplier_message_ingest;
drop policy if exists supplier_orders_admin_select on public.supplier_orders;
drop policy if exists supplier_order_lines_admin_select on public.supplier_order_lines;

drop policy if exists supplier_message_ingest_module_select on public.supplier_message_ingest;
drop policy if exists supplier_orders_module_select on public.supplier_orders;
drop policy if exists supplier_order_lines_module_select on public.supplier_order_lines;

create policy supplier_message_ingest_module_select
  on public.supplier_message_ingest
  for select to authenticated
  using (public.purchase_module_admin_auth(auth.uid()));

create policy supplier_orders_module_select
  on public.supplier_orders
  for select to authenticated
  using (public.purchase_module_admin_auth(auth.uid()));

create policy supplier_order_lines_module_select
  on public.supplier_order_lines
  for select to authenticated
  using (public.purchase_module_admin_auth(auth.uid()));

grant select on public.supplier_message_ingest to authenticated;
grant select on public.supplier_orders to authenticated;
grant select on public.supplier_order_lines to authenticated;

grant all on public.supplier_message_ingest to service_role;
grant all on public.supplier_orders to service_role;
grant all on public.supplier_order_lines to service_role;

-- ---------------------------------------------------------------------------
-- 4) Storage bucket supplier-ingest (privado)
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('supplier-ingest', 'supplier-ingest', false)
on conflict (id) do update set public = excluded.public;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'supplier_ingest_objects_admin_select'
  ) then
    create policy supplier_ingest_objects_admin_select
      on storage.objects
      for select to authenticated
      using (
        bucket_id = 'supplier-ingest'
        and exists (select 1 from public.admins a where a.user_id = auth.uid())
      );
  end if;
end $$;

select pg_notify('pgrst', 'reload schema');
