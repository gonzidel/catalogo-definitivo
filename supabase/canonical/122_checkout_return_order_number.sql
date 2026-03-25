-- 122_checkout_return_order_number.sql
-- Hace que rpc_checkout_cart devuelva también order_number para mostrar en el front.

create or replace function public.rpc_checkout_cart()
returns json
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_cart_id uuid;
  v_order_id uuid;
  v_order_number text;
  v_total numeric := 0;
  r record;
  v_stock int;
  v_reserved int;
  v_available int;
  v_qty int;
  v_has_existing_order boolean;
  v_total_stock int;
  v_general_id uuid;
  v_venta_id uuid;
  v_general_stock int;
  v_remaining_qty int;
  v_item_price numeric;
begin
  select id
    into v_cart_id
    from public.carts
   where customer_id = auth.uid()
     and status = 'open'
   order by created_at desc
   limit 1;

  if v_cart_id is null then
    raise exception 'No se encontró un carrito activo.';
  end if;

  if not exists (
    select 1 from public.cart_items where cart_id = v_cart_id
  ) then
    raise exception 'El carrito está vacío.';
  end if;

  select id
    into v_order_id
    from public.orders
   where customer_id = auth.uid()
     and status = 'active'
   order by created_at desc
   limit 1;

  if v_order_id is null then
    insert into public.orders (customer_id, status)
      values (auth.uid(), 'active')
      returning id into v_order_id;
  end if;

  for r in
    select
      id,
      variant_id,
      coalesce(quantity, qty, 0) as qty,
      price_snapshot,
      product_name,
      color,
      size,
      imagen
    from public.cart_items
    where cart_id = v_cart_id
  loop
    v_qty := coalesce(r.qty, 0);
    if v_qty <= 0 then
      continue;
    end if;

    if r.variant_id is null then
      raise exception 'El item % no tiene variante asociada.', r.id;
    end if;

    select public.get_total_stock(r.variant_id) into v_total_stock;

    select reserved_qty
      into v_reserved
      from public.product_variants
     where id = r.variant_id
     for update;

    v_available := coalesce(v_total_stock, 0) - coalesce(v_reserved, 0);
    if v_qty > v_available then
      raise exception
        using message = format(
          'Stock insuficiente para %s (color %s talle %s). Disponible: %s, solicitado: %s.',
          coalesce(r.product_name,'producto'),
          coalesce(r.color,'-'),
          coalesce(r.size,'-'),
          v_available,
          v_qty
        );
    end if;

    if v_general_id is null then
      select id into v_general_id from public.warehouses where code = 'general';
      select id into v_venta_id from public.warehouses where code = 'venta-publico';
    end if;

    select coalesce(stock_qty, 0) into v_general_stock
    from public.variant_warehouse_stock
    where variant_id = r.variant_id
      and warehouse_id = v_general_id;

    if v_general_stock > 0 then
      if v_general_stock >= v_qty then
        update public.variant_warehouse_stock
           set stock_qty = stock_qty - v_qty,
               updated_at = now()
         where variant_id = r.variant_id
           and warehouse_id = v_general_id;
        v_remaining_qty := 0;
      else
        update public.variant_warehouse_stock
           set stock_qty = 0,
               updated_at = now()
         where variant_id = r.variant_id
           and warehouse_id = v_general_id;
        v_remaining_qty := v_qty - v_general_stock;
      end if;
    else
      v_remaining_qty := v_qty;
    end if;

    if v_remaining_qty > 0 then
      update public.variant_warehouse_stock
         set stock_qty = stock_qty - v_remaining_qty,
             updated_at = now()
       where variant_id = r.variant_id
         and warehouse_id = v_venta_id;
    end if;

    update public.product_variants
       set reserved_qty = greatest(reserved_qty - v_qty, 0)
     where id = r.variant_id;

    select price into v_item_price from public.product_variants where id = r.variant_id;
    v_item_price := coalesce(nullif(r.price_snapshot, 0), v_item_price, r.price_snapshot, 0);

    insert into public.order_items (
      order_id,
      variant_id,
      product_name,
      color,
      size,
      quantity,
      price_snapshot,
      imagen,
      status
    ) values (
      v_order_id,
      r.variant_id,
      r.product_name,
      r.color,
      r.size,
      v_qty,
      v_item_price,
      r.imagen,
      'reserved'
    );

    v_total := v_total + (coalesce(v_item_price, 0) * v_qty);
  end loop;

  delete from public.cart_items where cart_id = v_cart_id;

  update public.orders
     set total_amount = coalesce(total_amount, 0) + coalesce(v_total, 0)
   where id = v_order_id;

  select order_number into v_order_number
    from public.orders
   where id = v_order_id;

  return json_build_object('order_id', v_order_id, 'order_number', coalesce(v_order_number, ''));
end $$;

select pg_notify('pgrst','reload schema');
