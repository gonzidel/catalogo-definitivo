-- 330_sellable_stock_canonical_readonly_tests.sql
-- Tests read-only post-330. No INSERT/UPDATE/DELETE. No refresh de snapshot.
-- Ejecutar en el editor SQL o via MCP execute_sql.

-- A) Normalización
select
  public.fn_norm_size('35') as n_35,
  public.fn_norm_size(' 35 ') as n_35_spaces,
  public.fn_norm_size('35.0') as n_35_0,
  public.fn_norm_size('S') as n_s,
  public.fn_norm_size('M') as n_m,
  public.fn_norm_size('XL') as n_xl,
  public.fn_norm_size('Unico') as n_unico,
  public.fn_norm_size('unico') as n_unico_lower,
  public.fn_norm_size('39/40') as n_range,
  public.fn_norm_size('125x3.5cm') as n_measure,
  public.fn_norm_size('L.') as n_l_dot,
  public.fn_norm_size('2XL') as n_2xl;

-- B) Las funciones no leen OISS/carts/reserved/awaiting
select
  p.proname,
  (p.prosrc ~* 'order_item_stock_sources|cart_items|reserved_qty|awaiting_apartado') as reads_holds
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('fn_sellable_qty', 'fn_sellable_stock_batch');

-- C) Casos 1–11 sobre datos reales (análogos vivos; ver nota en 51)
-- Caso 1: físico 5, sin OISS → sellable 5
select 'c1' as caso,
       public.fn_sellable_qty('00f951bd-730f-452e-a384-b6429dc5be2b', '40') as sellable,
       5 as expected;

-- Caso 6: cart reserved no reduce
select 'c6' as caso,
       public.fn_sellable_qty('926b1596-b853-45a8-81d5-ae1679082a31', '40') as sellable,
       33 as expected;

-- Caso 7: reserved_qty inflado no reduce
select 'c7' as caso,
       public.fn_sellable_qty('33f7271f-6b4b-4afc-8181-4d463210eb59', 'L') as sellable,
       2 as expected;

-- Caso 8/9: split warehouses (12 Lila 35 = 1+1)
-- se resuelve por artículo en la query de artículos reales.

-- D) Vista: producto entra solo si algún talle tiene sellable > 0
-- y no referencia reserved_by_size
select
  pg_get_viewdef('public.catalog_public_available_view'::regclass, true)
    not like '%reserved_by_size%' as dropped_reserved_cte,
  pg_get_viewdef('public.catalog_public_available_view'::regclass, true)
    not like '%order_item_stock_sources%' as dropped_oiss,
  pg_get_viewdef('public.catalog_public_available_view'::regclass, true)
    not like '%cart_items%' as dropped_carts;

-- E) Checkout no modificado (fingerprint a comparar pre/post)
select
  md5(pg_get_functiondef('public.rpc_checkout_cart()'::regprocedure)) as checkout_0arg_md5,
  md5(pg_get_functiondef('public.rpc_checkout_cart(uuid, jsonb)'::regprocedure)) as checkout_wrapper_md5;
