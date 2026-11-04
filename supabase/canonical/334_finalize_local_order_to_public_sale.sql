-- 334_finalize_local_order_to_public_sale.sql
--
-- Paso A (FYLA10223): vínculo pedido→venta + cierre atómico.
-- NO conecta botones. No modifica rpc_create_public_sale, Caja 1/2/3,
-- daily_sales, Facturante ni retiro común.
--
-- Live 2026-09-04 (solo lectura, notes "Pedido local LOC…"):
--   632 ventas ligadas, 624 activas, 624 local_orders distintos, 0 duplicados.
--   UNIQUE se puede crear. Backfill es solo local_order_id (no montos).
--
-- Rollback: 334_ROLLBACK_finalize_local_order_to_public_sale.sql
-- Tests:    334_finalize_local_order_to_public_sale_tests.sql

-- ---------------------------------------------------------------------------
-- 1) Vínculo explícito
-- ---------------------------------------------------------------------------
alter table public.public_sales
  add column if not exists local_order_id uuid
    references public.local_orders(id) on delete set null;

comment on column public.public_sales.local_order_id is
  'canonical:334 | Pedido local que originó esta venta. NULL = mostrador / pending / retiro no espejo.';

create index if not exists idx_public_sales_local_order_id
  on public.public_sales (local_order_id)
  where local_order_id is not null;

-- Backfill metadata-only (no cambia total_amount / items / status).
-- Incluye #fylA10223: solo rellena local_order_id. No recobra ni edita el incidente.
update public.public_sales ps
set local_order_id = lo.id
from public.local_orders lo
where ps.local_order_id is null
  and ps.notes ilike '%Pedido local%'
  and (
    lo.order_number = substring(ps.notes from 'Pedido local (LOC[0-9]+)')
    or lo.id::text = substring(ps.notes from 'Pedido local ([0-9a-fA-F-]{36})')
  );

do $$
declare
  v_dups int;
begin
  select count(*) into v_dups
  from (
    select local_order_id
    from public.public_sales
    where local_order_id is not null
      and voided_at is null
    group by local_order_id
    having count(*) > 1
  ) s;
  if v_dups > 0 then
    raise exception
      '334: % local_order_id activos duplicados; no se crea UNIQUE',
      v_dups;
  end if;
end $$;

create unique index if not exists public_sales_local_order_id_active_uk
  on public.public_sales (local_order_id)
  where local_order_id is not null
    and voided_at is null;

-- ---------------------------------------------------------------------------
-- 2) Cierre atómico. Sin caller en frontend todavía.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_finalize_local_order_to_public_sale(
  p_local_order_id uuid,
  p_items jsonb,
  p_notes jsonb default null,
  p_payment_method text default 'Efectivo'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_uid uuid := auth.uid();
  v_lo public.local_orders%rowtype;
  v_existing public.public_sales%rowtype;
  v_update json;
  v_sale json;
  v_sale_id uuid;
  v_sale_items jsonb := '[]'::jsonb;
  v_row record;
  v_notes jsonb := '{}'::jsonb;
  v_lines_sum numeric(15,2) := 0;
  v_total numeric(15,2) := 0;
  v_shipping numeric := 0;
  v_discount numeric := 0;
  v_extras_amount numeric := 0;
  v_extras_percentage numeric := 0;
  v_pct_amt numeric(15,2) := 0;
  v_raw numeric;
  v_is_return boolean;
  v_size text;
  v_close jsonb;
begin
  if v_uid is null then
    raise exception 'rpc_finalize_local_order_to_public_sale: no autenticado'
      using errcode = '42501';
  end if;
  if not exists (select 1 from public.admins a where a.user_id = v_uid) then
    raise exception 'rpc_finalize_local_order_to_public_sale: solo administradores'
      using errcode = '42501';
  end if;
  if p_local_order_id is null then
    raise exception 'rpc_finalize_local_order_to_public_sale: p_local_order_id es obligatorio'
      using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'rpc_finalize_local_order_to_public_sale: p_items vacío'
      using errcode = '22023';
  end if;

  select * into v_lo
  from public.local_orders
  where id = p_local_order_id
  for update;

  if not found then
    raise exception 'rpc_finalize_local_order_to_public_sale: pedido no encontrado'
      using errcode = 'P0002';
  end if;

  select * into v_existing
  from public.public_sales
  where local_order_id = p_local_order_id
    and voided_at is null
  limit 1;

  if v_lo.status = 'completed' and v_existing.id is not null then
    return jsonb_build_object(
      'success', true,
      'sale_id', v_existing.id,
      'sale_number', v_existing.sale_number,
      'total_amount', v_existing.total_amount,
      'credit_used', v_existing.credit_used,
      'item_count', v_existing.item_count,
      'local_order_id', p_local_order_id,
      'idempotent_replay', true
    );
  end if;

  if v_lo.status = 'completed' then
    raise exception 'rpc_finalize_local_order_to_public_sale: el pedido ya está completed'
      using errcode = 'P0001';
  end if;
  if v_lo.status = 'cancelled' then
    raise exception 'rpc_finalize_local_order_to_public_sale: el pedido está cancelled'
      using errcode = 'P0001';
  end if;
  if v_existing.id is not null then
    raise exception 'rpc_finalize_local_order_to_public_sale: el pedido ya tiene una venta'
      using errcode = '23505';
  end if;

  -- Notes antes del update para que rpc_update_local_order recálcule el total F3.
  if p_notes is not null then
    update public.local_orders
    set notes = p_notes::text,
        updated_at = now()
    where id = p_local_order_id;
  end if;

  v_update := public.rpc_update_local_order(p_local_order_id, p_items);
  v_total := coalesce((v_update->>'total_amount')::numeric, 0);

  select * into v_lo
  from public.local_orders
  where id = p_local_order_id;

  begin
    v_notes := case
      when v_lo.notes is null or btrim(v_lo.notes) = '' then '{}'::jsonb
      else v_lo.notes::jsonb
    end;
  exception when others then
    v_notes := '{}'::jsonb;
  end;

  v_shipping := coalesce((v_notes->>'shipping')::numeric, 0);
  v_discount := coalesce((v_notes->>'discount')::numeric, 0);
  v_extras_amount := coalesce((v_notes->>'extras_amount')::numeric, 0);
  v_extras_percentage := coalesce((v_notes->>'extras_percentage')::numeric, 0);

  for v_row in
    select
      loi.variant_id,
      loi.product_name,
      loi.size,
      loi.quantity,
      loi.price_snapshot
    from public.local_order_items loi
    where loi.local_order_id = p_local_order_id
    order by loi.created_at, loi.id
  loop
    v_raw := coalesce(v_row.price_snapshot, 0);
    v_lines_sum := v_lines_sum + (coalesce(v_row.quantity, 0) * v_raw);

    if v_row.variant_id is not null then
      v_is_return := v_raw < 0;
      v_size := nullif(btrim(coalesce(v_row.size, '')), '');
      v_sale_items := v_sale_items || jsonb_build_array(
        jsonb_strip_nulls(
          jsonb_build_object(
            'variant_id', v_row.variant_id,
            'qty', v_row.quantity,
            'price', abs(v_raw),
            'is_return', v_is_return,
            'from_local_order', (not v_is_return),
            'size', v_size,
            'source', case
              when not v_is_return then jsonb_build_object(
                'venta_publico', v_row.quantity,
                'general', 0
              )
              else null
            end
          )
        )
      );
    else
      v_sale_items := v_sale_items || jsonb_build_array(
        jsonb_build_object(
          'product_name', coalesce(v_row.product_name, 'Producto'),
          'qty', v_row.quantity,
          'price', v_raw,
          'is_return', false,
          'is_special_extra', true
        )
      );
    end if;
  end loop;

  -- Misma composición que F3: envío/descuento solo entran al total, no como líneas.
  if v_extras_amount > 0 then
    v_sale_items := v_sale_items || jsonb_build_array(
      jsonb_build_object(
        'product_name', 'Extra (monto fijo)',
        'qty', 1,
        'price', v_extras_amount,
        'is_return', false,
        'is_special_extra', true
      )
    );
  end if;
  if v_extras_percentage > 0 then
    v_pct_amt := (v_lines_sum + v_shipping - v_discount + v_extras_amount)
      * (v_extras_percentage / 100);
    v_sale_items := v_sale_items || jsonb_build_array(
      jsonb_build_object(
        'product_name', 'Extra ' || trim(to_char(v_extras_percentage, 'FM999999999990.###')) || '%',
        'qty', 1,
        'price', v_pct_amt,
        'is_return', false,
        'is_special_extra', true
      )
    );
  end if;

  -- p_apply_credit true + p_total = reglas F3 (sin restar crédito en el total).
  -- Issue separado: crédito de pedido no se descuenta del total visible.
  v_sale := public.rpc_create_public_sale(
    v_sale_items,
    v_lo.customer_id,
    'Pedido local ' || coalesce(v_lo.order_number, p_local_order_id::text),
    true,
    v_total
  );

  v_sale_id := coalesce((v_sale->>'sale_id')::uuid, (v_sale->>'id')::uuid);
  if v_sale_id is null then
    raise exception 'rpc_finalize_local_order_to_public_sale: rpc_create_public_sale no devolvió sale_id';
  end if;

  update public.public_sales
  set local_order_id = p_local_order_id
  where id = v_sale_id;

  update public.local_orders
  set status = 'completed',
      updated_at = now()
  where id = p_local_order_id;

  v_close := public.rpc_close_mirrored_retiro_from_local_order(
    p_local_order_id,
    coalesce(nullif(btrim(p_payment_method), ''), 'Efectivo')
  );
  if coalesce(v_close->>'ok', 'false') <> 'true' then
    raise exception
      'rpc_finalize_local_order_to_public_sale: fallo al cerrar espejo: %',
      coalesce(v_close::text, 'null');
  end if;

  return jsonb_build_object(
    'success', true,
    'sale_id', v_sale_id,
    'sale_number', v_sale->>'sale_number',
    'total_amount', coalesce((v_sale->>'total_amount')::numeric, v_total),
    'credit_used', coalesce((v_sale->>'credit_used')::numeric, 0),
    'item_count', coalesce((v_sale->>'item_count')::int, 0),
    'local_order_id', p_local_order_id,
    'idempotent_replay', false
  );
end;
$$;

comment on function public.rpc_finalize_local_order_to_public_sale(uuid, jsonb, jsonb, text) is
  'canonical:334 | Cierre atómico local_order → public_sale. Total SQL (F3). No usar desde Caja mostrador.';

revoke all on function public.rpc_finalize_local_order_to_public_sale(uuid, jsonb, jsonb, text)
  from public, anon;
grant execute on function public.rpc_finalize_local_order_to_public_sale(uuid, jsonb, jsonb, text)
  to authenticated, service_role;

select pg_notify('pgrst', 'reload schema');
