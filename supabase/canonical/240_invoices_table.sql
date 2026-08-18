-- Tabla de facturas electrónicas emitidas (CAE de ARCA)
-- Una fila por pedido facturado (unique order_id)

create table if not exists invoices (
  id              bigserial primary key,
  order_id        uuid not null references orders(id),
  punto_venta     smallint not null,
  cbte_tipo       smallint not null,
  cbte_nro        integer not null,
  cbte_fecha      char(8) not null,
  cae             char(14) not null,
  cae_vto         char(8) not null,
  monto_facturado numeric(12,2) not null,
  total_amount    numeric(12,2) not null,
  customer_name   text not null,
  cuit            text,
  doc_tipo        smallint not null,
  doc_nro         bigint not null,
  address         text,
  locality        text,
  created_by      uuid references auth.users(id),
  created_at      timestamptz not null default now(),
  unique (punto_venta, cbte_tipo, cbte_nro),
  unique (order_id)
);

alter table invoices enable row level security;

create policy "admin_full_access" on invoices
  for all
  using (exists (select 1 from admins where user_id = auth.uid()))
  with check (exists (select 1 from admins where user_id = auth.uid()));
