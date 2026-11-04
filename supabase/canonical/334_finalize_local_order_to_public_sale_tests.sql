-- 334_finalize_local_order_to_public_sale_tests.sql
-- Solo lectura / aserciones de fuente. No cobra, no inserta ventas, no toca stock.
-- Paso B (fixtures mutantes) es otro script y NO se corre en producción.

-- A) Columna + UNIQUE parcial
select
  exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'public_sales'
      and column_name = 'local_order_id'
  ) as has_local_order_id,
  exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and indexname = 'public_sales_local_order_id_active_uk'
  ) as has_active_unique;

-- B) RPC existe, SECURITY DEFINER, grants
select
  p.prosecdef as security_definer,
  obj_description(p.oid, 'pg_proc') like 'canonical:334%' as comment_334,
  has_function_privilege('authenticated', p.oid, 'execute') as grant_authenticated,
  not has_function_privilege('anon', p.oid, 'execute') as revoke_anon,
  (p.prosrc ~ 'rpc_update_local_order') as calls_update,
  (p.prosrc ~ 'rpc_create_public_sale') as calls_create,
  (p.prosrc ~ 'rpc_close_mirrored_retiro_from_local_order') as calls_close_mirror,
  (p.prosrc ~ 'from_local_order') as keeps_from_local_order,
  (p.prosrc !~ 'computeSalePromoGrouping') as no_caja_promos,
  (p.prosrc ~ 'FOR UPDATE') as locks_row
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'rpc_finalize_local_order_to_public_sale'
  and pg_get_function_identity_arguments(p.oid)
    = 'p_local_order_id uuid, p_items jsonb, p_notes jsonb, p_payment_method text';

-- C) Caja / create_public_sale intactos (Paso A no los reescribe)
select
  (
    select count(*)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'rpc_create_public_sale'
  ) = 3 as create_public_sale_still_3_overloads,
  exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'rpc_create_pending_sale'
  ) as pending_sale_rpc_present;

-- D) Sin duplicados activos (pre/post backfill)
select count(*) as active_duplicate_local_orders
from (
  select local_order_id
  from public.public_sales
  where local_order_id is not null
    and voided_at is null
  group by local_order_id
  having count(*) > 1
) d;

-- E) FYLA10223: vínculo metadata, montos intactos
select
  ps.sale_number,
  ps.total_amount,
  ps.local_order_id,
  lo.order_number,
  lo.total_amount as local_total,
  (ps.total_amount = 176800) as sale_amount_untouched,
  (lo.order_number = 'LOC00769') as linked_loc00769
from public.public_sales ps
left join public.local_orders lo on lo.id = ps.local_order_id
where ps.sale_number = 'fylA10223' or ps.sale_number = '#fylA10223';
