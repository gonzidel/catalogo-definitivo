-- 182_protect_sensitive_product_fields.sql
-- Objetivo:
--   - Bloquear cambios en campos sensibles de products / product_variants
--     para usuarios que NO sean super_admin.
--   - Mantener edición de campos no sensibles para colaboradores con products/edit
--     (la autorización base sigue en RLS existente).
--
-- Campos sensibles protegidos:
--   - cost
--   - price_percentage
--   - logistic_amount
--   - recommended_price (si existe en la tabla)

create or replace function public.enforce_sensitive_product_fields()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_jwt_role text := coalesce(current_setting('request.jwt.claim.role', true), '');
  v_is_super boolean := false;
  v_old jsonb := coalesce(to_jsonb(old), '{}'::jsonb);
  v_new jsonb := to_jsonb(new);
  v_changed_keys text[] := '{}';
  v_key text;
begin
  -- Bypass para service_role / procesos backend y contexto sin JWT.
  if v_jwt_role = 'service_role' or v_uid is null then
    return new;
  end if;

  -- Solo super_admin puede tocar campos sensibles.
  v_is_super := public.is_super_admin(v_uid);
  if v_is_super then
    return new;
  end if;

  foreach v_key in array array['cost', 'price_percentage', 'logistic_amount', 'recommended_price']
  loop
    if (v_old -> v_key) is distinct from (v_new -> v_key) then
      v_changed_keys := array_append(v_changed_keys, v_key);
    end if;
  end loop;

  if coalesce(array_length(v_changed_keys, 1), 0) > 0 then
    raise exception
      using
        errcode = '42501',
        message = format(
          'No autorizado: solo super_admin puede modificar campos sensibles en %s (%s).',
          tg_table_name,
          array_to_string(v_changed_keys, ', ')
        );
  end if;

  return new;
end;
$$;

drop trigger if exists trg_products_protect_sensitive_fields on public.products;
create trigger trg_products_protect_sensitive_fields
before insert or update on public.products
for each row execute function public.enforce_sensitive_product_fields();

drop trigger if exists trg_product_variants_protect_sensitive_fields on public.product_variants;
create trigger trg_product_variants_protect_sensitive_fields
before insert or update on public.product_variants
for each row execute function public.enforce_sensitive_product_fields();

select pg_notify('pgrst', 'reload schema');
