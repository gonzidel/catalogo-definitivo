-- Renglones de factura congelados al momento de emisión (para reimpresión exacta)

create table if not exists invoice_items (
  id           bigserial primary key,
  invoice_id   bigint not null references invoices(id) on delete cascade,
  product_name text not null,
  quantity     numeric not null,
  unit_price   numeric(12,2) not null,
  subtotal     numeric(12,2) not null
);

alter table invoice_items enable row level security;

create policy "admin_full_access" on invoice_items
  for all
  using (exists (select 1 from admins where user_id = auth.uid()))
  with check (exists (select 1 from admins where user_id = auth.uid()));
