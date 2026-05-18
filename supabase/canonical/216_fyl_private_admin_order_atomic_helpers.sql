-- 216_fyl_private_admin_order_atomic_helpers.sql
--
-- Helpers internos para rpc_create_admin_order_atomic (NO grants a anon/authenticated).
-- Rollback: 216_ROLLBACK_fyl_private_admin_order_atomic_helpers.sql

create or replace function fyl_private.normalize_size_admin_order(p_size text)
returns text
language plpgsql
immutable
as $$
declare
  t text;
begin
  if p_size is null then
    return '';
  end if;
  t := trim(both from p_size);
  if t = '' then
    return '';
  end if;
  if t ~ '^-?[0-9]+(\.[0-9]+)?$' then
    return floor(t::numeric)::text;
  end if;
  return t;
end;
$$;

create or replace function fyl_private.admin_order_payload_sha256(p_payload jsonb)
returns text
language sql
stable
set search_path = public, extensions, pg_catalog
as $$
  -- Hash sobre p_payload::text: jsonb ya está normalizado en PG (orden de claves, etc.);
  -- mismas claves/valores semánticos → mismo hash. Ver doc/pre-apply-rpc-create-admin-order-atomic-verification-2026-05-15.md §2.
  -- digest vive en schema extensions (pgcrypto en Supabase).
  select encode(
    extensions.digest(convert_to(coalesce(p_payload::text, ''), 'UTF8'), 'sha256'),
    'hex'
  );
$$;

create or replace function fyl_private.admin_order_item_qualifies_deduction(p_item jsonb)
returns boolean
language plpgsql
immutable
as $$
declare
  st text;
  g int;
  v int;
  q int;
  adm boolean;
begin
  if nullif(trim(both from p_item->>'variant_id'), '') is null then
    return false;
  end if;
  if fyl_private.normalize_size_admin_order(p_item->>'size') = '' then
    return false;
  end if;
  st := lower(trim(both from coalesce(p_item->>'status', '')));
  if st = 'missing' then
    return false;
  end if;
  adm := coalesce((p_item->>'admin_confirmed_missing')::boolean, false);
  if adm then
    return false;
  end if;
  q := coalesce((p_item->>'quantity')::int, 0);
  if q <= 0 then
    return false;
  end if;
  g := coalesce((p_item->>'qty_from_general')::int, 0);
  v := coalesce((p_item->>'qty_from_venta')::int, 0);
  return g + v = q and g + v > 0;
end;
$$;

comment on function fyl_private.normalize_size_admin_order(text) is
  'Normaliza talle alineado a scripts/utils/size-normalizer.js (numéricos → floor).';
comment on function fyl_private.admin_order_payload_sha256(jsonb) is
  'SHA-256 hex del texto jsonb (hash idempotencia; mismo payload serializado → mismo hash).';
comment on function fyl_private.admin_order_item_qualifies_deduction(jsonb) is
  'Espejo de itemQualifiesForApplyOrderStockDeduction (order-creator.js).';

revoke all on function fyl_private.normalize_size_admin_order(text) from public;
revoke all on function fyl_private.admin_order_payload_sha256(jsonb) from public;
revoke all on function fyl_private.admin_order_item_qualifies_deduction(jsonb) from public;

grant execute on function fyl_private.normalize_size_admin_order(text) to postgres, supabase_admin;
grant execute on function fyl_private.admin_order_payload_sha256(jsonb) to postgres, supabase_admin;
grant execute on function fyl_private.admin_order_item_qualifies_deduction(jsonb) to postgres, supabase_admin;

select pg_notify('pgrst', 'reload schema');
