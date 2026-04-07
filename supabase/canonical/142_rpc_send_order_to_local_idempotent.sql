-- 142_rpc_send_order_to_local_idempotent.sql
-- Idempotencia: no duplicar pedido local si ya existe uno para source_order_id.
-- Total: preferir orders.total_amount (total del pedido web) con fallback a suma de líneas.
-- Respuesta incluye already_exists cuando se reutiliza un pedido local existente.

create or replace function public.rpc_send_order_to_local(p_order_id uuid)
returns json
language plpgsql
security definer
as $$
declare
  v_order_record record;
  v_local_customer_id uuid;
  v_local_order_id uuid;
  v_order_number text;
  v_total_amount numeric(12,2);
  v_lines_sum numeric(12,2);
  v_customer_result json;
  v_result json;
  v_total_items int;
  v_picked_items int;
begin
  select
    o.id,
    o.customer_id,
    o.total_amount,
    o.notes,
    o.status
  into v_order_record
  from public.orders o
  where o.id = p_order_id;

  if v_order_record is null then
    raise exception 'Pedido no encontrado';
  end if;

  -- Reutilizar pedido local existente (mismo pedido web), p. ej. reintento de red o doble clic
  select lo.id, lo.order_number, lo.customer_id
  into v_local_order_id, v_order_number, v_local_customer_id
  from public.local_orders lo
  where lo.source_order_id = p_order_id
    and lo.status <> 'cancelled'
  order by lo.created_at desc
  limit 1;

  if v_local_order_id is not null then
    update public.orders o
    set
      status = 'sent',
      sent_at = coalesce(o.sent_at, now()),
      updated_at = now()
    where o.id = p_order_id
      and o.status is distinct from 'sent';

    select json_build_object(
      'success', true,
      'local_order_id', v_local_order_id,
      'order_number', v_order_number,
      'customer_id', v_local_customer_id,
      'already_exists', true
    ) into v_result;
    return v_result;
  end if;

  if v_order_record.status = 'sent' then
    raise exception 'El pedido ya fue enviado o marcado como enviado';
  end if;

  select count(*), count(*) filter (where status = 'picked' or status = 'waiting')
  into v_total_items, v_picked_items
  from public.order_items
  where order_id = p_order_id and status != 'cancelled';

  if v_total_items = 0 then
    raise exception 'El pedido no tiene items';
  end if;

  if v_picked_items < v_total_items then
    raise exception 'El pedido no está completamente apartado';
  end if;

  select public.rpc_copy_customer_to_local(v_order_record.customer_id) into v_customer_result;

  if (v_customer_result->>'success')::boolean = false then
    raise exception 'Error al copiar cliente: %', v_customer_result->>'error';
  end if;

  v_local_customer_id := (v_customer_result->>'customer_id')::uuid;

  v_order_number := public.generate_local_order_number();

  select coalesce(sum((quantity * price_snapshot)), 0)
  into v_lines_sum
  from public.order_items
  where order_id = p_order_id and status != 'cancelled';

  v_total_amount := coalesce(v_order_record.total_amount, v_lines_sum);
  if v_total_amount is null then
    v_total_amount := v_lines_sum;
  end if;

  insert into public.local_orders (
    order_number,
    customer_id,
    source_order_id,
    status,
    total_amount,
    notes
  )
  values (
    v_order_number,
    v_local_customer_id,
    p_order_id,
    'pending',
    v_total_amount,
    v_order_record.notes
  )
  returning id into v_local_order_id;

  insert into public.local_order_items (
    local_order_id,
    variant_id,
    product_name,
    color,
    size,
    quantity,
    price_snapshot,
    imagen,
    status
  )
  select
    v_local_order_id,
    oi.variant_id,
    oi.product_name,
    oi.color,
    oi.size,
    oi.quantity,
    oi.price_snapshot,
    oi.imagen,
    'pending'
  from public.order_items oi
  where oi.order_id = p_order_id and oi.status != 'cancelled';

  update public.orders
  set status = 'sent',
      sent_at = now(),
      updated_at = now()
  where id = p_order_id;

  select json_build_object(
    'success', true,
    'local_order_id', v_local_order_id,
    'order_number', v_order_number,
    'customer_id', v_local_customer_id,
    'already_exists', false
  ) into v_result;
  return v_result;
end $$;

comment on function public.rpc_send_order_to_local(uuid) is
  'Copia pedido web a local_orders; idempotente por source_order_id; total_amount desde orders.total_amount con fallback a suma de líneas.';
