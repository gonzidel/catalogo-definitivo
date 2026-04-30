-- 183_rpc_get_variant_size_reserved.sql
-- Reserva agregada por variant_id + talle para consumo de UI (catalogo/PDP/carrito).
-- Evita restar product_variants.reserved_qty (nivel variante) a cada talle.

create or replace function public.rpc_get_variant_size_reserved(
  p_variant_ids uuid[]
)
returns table (
  variant_id uuid,
  size text,
  reserved_qty int
)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if p_variant_ids is null or coalesce(array_length(p_variant_ids, 1), 0) = 0 then
    return;
  end if;

  return query
  with order_reserved as (
    select
      oi.variant_id,
      nullif(trim(coalesce(oi.size::text, '')), '') as size_norm,
      sum(coalesce(oiss.qty, 0))::int as qty
    from public.order_item_stock_sources oiss
    join public.order_items oi on oi.id = oiss.order_item_id
    join public.orders o on o.id = oi.order_id
    where oi.variant_id = any(p_variant_ids)
      and o.status not in ('sent', 'expired', 'devolución')
      and coalesce(oiss.qty, 0) > 0
    group by oi.variant_id, nullif(trim(coalesce(oi.size::text, '')), '')
  ),
  cart_reserved as (
    select
      ci.variant_id,
      nullif(trim(coalesce(ci.size::text, '')), '') as size_norm,
      sum(coalesce(ci.qty, 0))::int as qty
    from public.cart_items ci
    join public.carts c on c.id = ci.cart_id
    where ci.variant_id = any(p_variant_ids)
      and c.status = 'open'
      and ci.status = 'reserved'
      and coalesce(ci.qty, 0) > 0
    group by ci.variant_id, nullif(trim(coalesce(ci.size::text, '')), '')
  )
  select
    coalesce(o.variant_id, c.variant_id) as variant_id,
    coalesce(o.size_norm, c.size_norm) as size,
    (coalesce(o.qty, 0) + coalesce(c.qty, 0))::int as reserved_qty
  from order_reserved o
  full outer join cart_reserved c
    on c.variant_id = o.variant_id
   and c.size_norm is not distinct from o.size_norm
  where (coalesce(o.qty, 0) + coalesce(c.qty, 0)) > 0
    and coalesce(o.size_norm, c.size_norm) is not null
  order by 1, 2;
end;
$$;

revoke all on function public.rpc_get_variant_size_reserved(uuid[]) from public, anon, authenticated;
grant execute on function public.rpc_get_variant_size_reserved(uuid[]) to anon, authenticated, service_role;

comment on function public.rpc_get_variant_size_reserved(uuid[]) is
'Reserva agregada por variante+talle (orders activos + carts open reserved). Uso UI para disponible por talle.';

select pg_notify('pgrst', 'reload schema');
