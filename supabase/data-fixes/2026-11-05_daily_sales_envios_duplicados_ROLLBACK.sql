-- ROLLBACK de 2026-11-05_daily_sales_envios_duplicados.sql
-- Reinserta en daily_sales las filas 'envios' borradas, con su id y timestamps originales.
-- Idempotente: no reinserta lo que ya existe (on conflict do nothing).

begin;

insert into public.daily_sales (
  id, sale_date, sale_type, sale_time, customer_name,
  product_quantity, sale_amount, created_by, created_at, updated_at, public_sale_id
)
select
  b.id, b.sale_date, b.sale_type, b.sale_time, b.customer_name,
  b.product_quantity, b.sale_amount, b.created_by, b.created_at, b.updated_at, b.public_sale_id
from fyl_private.daily_sales_envios_dup_backup_20261105 b
on conflict (id) do nothing;

-- Verificacion: debe devolver 185 (o las que correspondan si hubo mas de un rollback).
-- select count(*) from public.daily_sales ds
--   join fyl_private.daily_sales_envios_dup_backup_20261105 b on b.id = ds.id;

commit;

-- Solo cuando ya no haga falta el backup:
-- drop table fyl_private.daily_sales_envios_dup_backup_20261105;
