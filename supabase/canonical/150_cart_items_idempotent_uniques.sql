-- 150_cart_items_idempotent_uniques.sql
-- Refuerzo anti-duplicados para escrituras idempotentes del carrito.

do $$
begin
  -- Consolidar duplicados históricos para líneas con variant_id.
  with ranked_variant as (
    select
      id,
      row_number() over (
        partition by cart_id, variant_id, coalesce(size, '')
        order by updated_at desc nulls last, id desc
      ) as rn
    from public.cart_items
    where variant_id is not null
  ),
  doomed_variant as (
    select id from ranked_variant where rn > 1
  )
  delete from public.cart_items ci
  using doomed_variant d
  where ci.id = d.id;

  -- Consolidar duplicados históricos para líneas sin variant_id (extras).
  with ranked_extra as (
    select
      id,
      row_number() over (
        partition by cart_id, coalesce(product_name, ''), coalesce(color, ''), coalesce(size, '')
        order by updated_at desc nulls last, id desc
      ) as rn
    from public.cart_items
    where variant_id is null
  ),
  doomed_extra as (
    select id from ranked_extra where rn > 1
  )
  delete from public.cart_items ci
  using doomed_extra d
  where ci.id = d.id;
end $$;

-- Unicidad para productos normales con variante.
create unique index if not exists ux_cart_items_cart_variant_size
on public.cart_items (cart_id, variant_id, size)
where variant_id is not null;

-- Unicidad para extras sin variant_id.
create unique index if not exists ux_cart_items_cart_extra_identity
on public.cart_items (cart_id, product_name, color, size)
where variant_id is null;
