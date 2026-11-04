-- 334_ROLLBACK_finalize_local_order_to_public_sale.sql
-- Revierte Paso A. No toca public_sales.total_amount ni ítems.
-- Tras dropear la columna, el vínculo pedido→venta vuelve a ser solo notes.

drop function if exists public.rpc_finalize_local_order_to_public_sale(uuid, jsonb, jsonb, text);

drop index if exists public.public_sales_local_order_id_active_uk;
drop index if exists public.idx_public_sales_local_order_id;

alter table public.public_sales
  drop column if exists local_order_id;

select pg_notify('pgrst', 'reload schema');
