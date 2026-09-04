-- 313_local_orders_retiro_mirror_fix.sql
--
-- Fix espejo public-sales → Retiro/Apartados (311):
-- - `source_order_id` en local_orders = pedido Kanban origen ("Desde Pedidos"), NO el espejo Retiro.
-- - Nueva columna `retiro_mirror_order_id` = orders.id espejado en Apartados.
-- - Índice único "un pedido abierto por cliente" excluye local_deferred_pickup (retiro/caja).
-- - Backfill de pending sin espejo + RPC batch admin.
--
-- Evidencia prod 2026-09-01: 49 local_orders pending, 1 solo espejo (A56330/LOC00773);
-- 28 pending tenían source_order_id → pedido sent (origen) y el mirror hacía skip.
--
-- Rollback: restaurar índice 251, dropear columna retiro_mirror_order_id, restaurar RPCs desde 311.

-- 1) Columna dedicada al espejo Retiro
alter table public.local_orders
  add column if not exists retiro_mirror_order_id uuid references public.orders(id) on delete set null;

create index if not exists idx_local_orders_retiro_mirror_order_id
  on public.local_orders (retiro_mirror_order_id)
  where retiro_mirror_order_id is not null;

comment on column public.local_orders.retiro_mirror_order_id is
  'Pedido espejo en Kanban Retiro (Apartados). Distinto de source_order_id (origen desde Pedidos). canonical:313';

-- 2) Backfill desde orders ya espejados (notes.local_order_id)
update public.local_orders lo
set retiro_mirror_order_id = o.id,
    updated_at = now()
from public.orders o
where lo.retiro_mirror_order_id is null
  and coalesce(o.notes::jsonb->>'mirrored_from_local_order', 'false') = 'true'
  and o.notes::jsonb->>'local_order_id' = lo.id::text
  and o.status in ('active', 'closing_soon', 'closed', 'sent', 'devolución', 'devolucion', 'expired');

-- 3) Reparar 311: source_order_id no debe apuntar al espejo Retiro
update public.local_orders lo
set retiro_mirror_order_id = coalesce(lo.retiro_mirror_order_id, lo.source_order_id),
    source_order_id = null,
    updated_at = now()
from public.orders o
where lo.source_order_id = o.id
  and coalesce(o.notes::jsonb->>'mirrored_from_local_order', 'false') = 'true'
  and o.notes::jsonb->>'local_order_id' = lo.id::text;

-- 4) Permitir espejo Retiro aunque el cliente tenga pedido dashboard abierto
drop index if exists public.orders_one_open_per_customer_idx;

create unique index orders_one_open_per_customer_idx
  on public.orders (customer_id)
  where (
    status in ('active', 'closing_soon', 'closed')
    and coalesce(local_deferred_pickup, false) = false
  );

comment on index public.orders_one_open_per_customer_idx is
  'Un pedido abierto (no retiro/caja) por customer_id. local_deferred_pickup excluido — canonical:313.';

-- 5) Espejo local_orders → orders (Retiro / Apartados)
create or replace function public.rpc_mirror_local_order_to_retiro(
  p_local_order_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_uid uuid := auth.uid();
  v_is_admin boolean;
  v_lo record;
  v_customer_id uuid;
  v_order_id uuid;
  v_order_number text;
  v_notes jsonb;
  v_item record;
  v_transport_id uuid;
  v_norm_size text;
begin
  if v_uid is null then
    raise exception 'rpc_mirror_local_order_to_retiro: no autenticado';
  end if;

  select exists (select 1 from public.admins a where a.user_id = v_uid)
  into v_is_admin;
  if not v_is_admin then
    raise exception 'rpc_mirror_local_order_to_retiro: solo administradores';
  end if;

  if p_local_order_id is null then
    return jsonb_build_object('ok', false, 'reason', 'missing_local_order_id');
  end if;

  select
    lo.id,
    lo.order_number,
    lo.customer_id,
    lo.source_order_id,
    lo.retiro_mirror_order_id,
    lo.status,
    lo.total_amount,
    lo.notes
  into v_lo
  from public.local_orders lo
  where lo.id = p_local_order_id
  for update of lo;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'local_order_not_found');
  end if;

  if v_lo.retiro_mirror_order_id is not null then
    return jsonb_build_object(
      'ok', true,
      'replay', true,
      'order_id', v_lo.retiro_mirror_order_id,
      'reason', 'already_mirrored'
    );
  end if;

  select o.id into v_order_id
  from public.orders o
  where coalesce(o.notes::jsonb->>'mirrored_from_local_order', 'false') = 'true'
    and o.notes::jsonb->>'local_order_id' = v_lo.id::text
    and o.status in ('active', 'closing_soon', 'closed')
  order by o.created_at desc
  limit 1;

  if v_order_id is not null then
    update public.local_orders
    set retiro_mirror_order_id = v_order_id,
        updated_at = now()
    where id = v_lo.id;

    return jsonb_build_object(
      'ok', true,
      'replay', true,
      'order_id', v_order_id,
      'reason', 'linked_existing_mirror'
    );
  end if;

  if v_lo.status in ('completed', 'cancelled') then
    return jsonb_build_object('ok', false, 'reason', 'local_order_not_open', 'status', v_lo.status);
  end if;

  v_customer_id := fyl_private.resolve_customer_for_public_sales(v_lo.customer_id);
  if v_customer_id is null then
    return jsonb_build_object('ok', false, 'reason', 'customer_unresolved');
  end if;

  begin
    v_notes := coalesce(v_lo.notes::jsonb, '{}'::jsonb);
  exception when others then
    v_notes := '{}'::jsonb;
  end;

  v_notes := v_notes || jsonb_build_object(
    'kanban_scope', 'local_pickup',
    'local_order_id', v_lo.id,
    'local_order_number', v_lo.order_number,
    'mirrored_from_local_order', true,
    'retiro_origin', 'public_sales'
  );

  if v_lo.source_order_id is not null then
    v_notes := v_notes || jsonb_build_object(
      'origin_order_id', v_lo.source_order_id
    );
  end if;

  select t.id into v_transport_id
  from public.transports t
  where lower(trim(coalesce(t.name, ''))) in ('retira local', 'retiro de local', 'retiro local')
  order by case when lower(trim(t.name)) = 'retira local' then 0 else 1 end
  limit 1;

  if v_transport_id is not null then
    update public.customers
    set transport_id = coalesce(transport_id, v_transport_id)
    where id = v_customer_id
      and transport_id is null;
  end if;

  insert into public.orders (
    customer_id,
    status,
    total_amount,
    notes,
    source,
    created_by_user_id,
    local_deferred_pickup
  ) values (
    v_customer_id,
    'active',
    coalesce(v_lo.total_amount, 0),
    v_notes::text,
    'admin',
    v_uid,
    true
  )
  returning id, order_number into v_order_id, v_order_number;

  for v_item in
    select *
    from public.local_order_items loi
    where loi.local_order_id = v_lo.id
    order by loi.created_at asc
  loop
    v_norm_size := nullif(trim(coalesce(v_item.size, '')), '');
    if v_norm_size is not null and v_norm_size ~ '^\d+(\.\d+)?$' then
      v_norm_size := split_part(v_norm_size, '.', 1);
    end if;

    insert into public.order_items (
      order_id,
      variant_id,
      product_name,
      color,
      size,
      quantity,
      price_snapshot,
      imagen,
      status,
      admin_confirmed_missing
    ) values (
      v_order_id,
      v_item.variant_id,
      coalesce(nullif(trim(v_item.product_name), ''), 'Producto'),
      nullif(trim(coalesce(v_item.color, '')), ''),
      v_norm_size,
      greatest(1, coalesce(v_item.quantity, 1)),
      v_item.price_snapshot,
      v_item.imagen,
      'picked',
      false
    );
  end loop;

  update public.local_orders
  set retiro_mirror_order_id = v_order_id,
      updated_at = now()
  where id = v_lo.id;

  return jsonb_build_object(
    'ok', true,
    'order_id', v_order_id,
    'order_number', v_order_number,
    'customer_id', v_customer_id,
    'local_order_id', v_lo.id,
    'local_order_number', v_lo.order_number
  );
exception
  when unique_violation then
    return jsonb_build_object(
      'ok', false,
      'reason', 'unique_violation',
      'customer_id', v_customer_id
    );
end;
$$;

comment on function public.rpc_mirror_local_order_to_retiro(uuid) is
  'canonical:313 | Espejo local_orders → Retiro/Apartados. Usa retiro_mirror_order_id; no pisa source_order_id.';

revoke all on function public.rpc_mirror_local_order_to_retiro(uuid) from public, anon;
grant execute on function public.rpc_mirror_local_order_to_retiro(uuid) to authenticated, service_role;

-- 6) Cierre del espejo al completar/cancelar pedido local
create or replace function public.rpc_close_mirrored_retiro_from_local_order(
  p_local_order_id uuid,
  p_payment_method text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_uid uuid := auth.uid();
  v_is_admin boolean;
  v_order_id uuid;
  v_status text;
begin
  if v_uid is null then
    raise exception 'rpc_close_mirrored_retiro_from_local_order: no autenticado';
  end if;
  select exists (select 1 from public.admins a where a.user_id = v_uid) into v_is_admin;
  if not v_is_admin then
    raise exception 'rpc_close_mirrored_retiro_from_local_order: solo administradores';
  end if;

  select lo.retiro_mirror_order_id into v_order_id
  from public.local_orders lo
  where lo.id = p_local_order_id;

  if v_order_id is null then
    return jsonb_build_object('ok', true, 'skipped', true, 'reason', 'no_mirror');
  end if;

  select o.status into v_status from public.orders o where o.id = v_order_id;
  if v_status is null then
    return jsonb_build_object('ok', true, 'skipped', true, 'reason', 'order_missing');
  end if;
  if v_status in ('sent', 'devolución', 'devolucion', 'expired') then
    return jsonb_build_object('ok', true, 'skipped', true, 'reason', 'already_final', 'status', v_status);
  end if;

  begin
    perform public.rpc_close_order(
      p_order_id := v_order_id,
      p_payment_method := coalesce(nullif(trim(p_payment_method), ''), 'Efectivo')
    );
  exception when undefined_function then
    update public.orders
    set status = 'closed',
        closed_at = coalesce(closed_at, now()),
        updated_at = now()
    where id = v_order_id;
  end;

  return jsonb_build_object('ok', true, 'order_id', v_order_id);
end;
$$;

revoke all on function public.rpc_close_mirrored_retiro_from_local_order(uuid, text) from public, anon;
grant execute on function public.rpc_close_mirrored_retiro_from_local_order(uuid, text) to authenticated, service_role;

-- 7) Backfill batch: todos los pending sin espejo Retiro
create or replace function public.rpc_backfill_pending_local_orders_to_retiro(
  p_limit int default 100
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_uid uuid := auth.uid();
  v_is_admin boolean;
  v_lo_id uuid;
  v_mirror jsonb;
  v_ok int := 0;
  v_fail int := 0;
  v_skip int := 0;
  v_results jsonb := '[]'::jsonb;
  v_cap int := greatest(1, least(coalesce(p_limit, 100), 500));
  v_processed int := 0;
begin
  if v_uid is null then
    raise exception 'rpc_backfill_pending_local_orders_to_retiro: no autenticado';
  end if;
  select exists (select 1 from public.admins a where a.user_id = v_uid) into v_is_admin;
  if not v_is_admin then
    raise exception 'rpc_backfill_pending_local_orders_to_retiro: solo administradores';
  end if;

  for v_lo_id in
    select lo.id
    from public.local_orders lo
    where lo.status = 'pending'
      and lo.retiro_mirror_order_id is null
      and not exists (
        select 1
        from public.orders o
        where coalesce(o.notes::jsonb->>'mirrored_from_local_order', 'false') = 'true'
          and o.notes::jsonb->>'local_order_id' = lo.id::text
          and o.status in ('active', 'closing_soon', 'closed')
      )
    order by lo.created_at asc
    limit v_cap
  loop
    v_processed := v_processed + 1;
    begin
      v_mirror := public.rpc_mirror_local_order_to_retiro(v_lo_id);
    exception when others then
      v_mirror := jsonb_build_object('ok', false, 'reason', 'exception', 'error', SQLERRM);
    end;

    if coalesce(v_mirror->>'ok', 'false') = 'true' then
      if coalesce(v_mirror->>'replay', 'false') = 'true' then
        v_skip := v_skip + 1;
      else
        v_ok := v_ok + 1;
      end if;
    else
      v_fail := v_fail + 1;
    end if;

    v_results := v_results || jsonb_build_array(
      jsonb_build_object(
        'local_order_id', v_lo_id,
        'mirror', v_mirror
      )
    );
  end loop;

  return jsonb_build_object(
    'ok', true,
    'processed', v_processed,
    'mirrored', v_ok,
    'replay', v_skip,
    'failed', v_fail,
    'results', v_results
  );
end;
$$;

comment on function public.rpc_backfill_pending_local_orders_to_retiro(int) is
  'canonical:313 | Espeja en batch local_orders pending sin retiro_mirror_order_id (admin).';

revoke all on function public.rpc_backfill_pending_local_orders_to_retiro(int) from public, anon;
grant execute on function public.rpc_backfill_pending_local_orders_to_retiro(int) to authenticated, service_role;
