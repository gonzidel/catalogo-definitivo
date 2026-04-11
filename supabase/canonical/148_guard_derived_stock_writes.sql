-- 148_guard_derived_stock_writes.sql
-- Bloquea escrituras directas de stock_qty en tablas derivadas desde clientes.
-- Las funciones SECURITY DEFINER (owner privilegiado) y triggers de sync siguen permitidos.

create or replace function public.guard_variant_sizes_stock_qty_writes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_privileged boolean := current_user in ('postgres', 'supabase_admin', 'service_role');
begin
  -- Solo proteger escrituras de stock_qty.
  if v_is_privileged then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  if tg_op = 'INSERT' and coalesce(new.stock_qty, 0) <> 0 then
    raise exception using
      message = 'No se permite escribir stock_qty directo en variant_sizes. Usa variant_size_warehouse_stock + triggers canónicos.',
      detail = 'guard=variant_sizes_stock_qty; op=INSERT; variant_id='
        || coalesce(new.variant_id::text, 'null')
        || '; stock_qty=' || coalesce(new.stock_qty, 0)::text,
      hint = 'Canal correcto: variant_size_warehouse_stock.';
  end if;

  if tg_op = 'UPDATE' and new.stock_qty is distinct from old.stock_qty then
    raise exception using
      message = 'No se permite actualizar stock_qty directo en variant_sizes. Usa variant_size_warehouse_stock + triggers canónicos.',
      detail = 'guard=variant_sizes_stock_qty; op=UPDATE; variant_id='
        || coalesce(new.variant_id::text, old.variant_id::text, 'null')
        || '; old_stock_qty=' || coalesce(old.stock_qty, 0)::text
        || '; new_stock_qty=' || coalesce(new.stock_qty, 0)::text,
      hint = 'Canal correcto: variant_size_warehouse_stock.';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_variant_sizes_stock_qty_writes on public.variant_sizes;
create trigger trg_guard_variant_sizes_stock_qty_writes
before insert or update or delete
on public.variant_sizes
for each row
execute function public.guard_variant_sizes_stock_qty_writes();

create or replace function public.guard_variant_warehouse_stock_qty_writes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_variant_id uuid := coalesce(new.variant_id, old.variant_id);
  v_is_privileged boolean := current_user in ('postgres', 'supabase_admin', 'service_role');
  v_has_size_model boolean;
begin
  if v_is_privileged then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  -- Solo proteger mutaciones de stock_qty.
  if tg_op = 'INSERT' then
    if coalesce(new.stock_qty, 0) = 0 then
      return new;
    end if;
  elsif tg_op = 'UPDATE' then
    if not (new.stock_qty is distinct from old.stock_qty) then
      return new;
    end if;
  else
    return old;
  end if;

  select (
    exists (
      select 1
      from public.variant_size_warehouse_stock
      where variant_id = v_variant_id
      limit 1
    )
    or exists (
      select 1
      from public.variant_sizes
      where variant_id = v_variant_id
        and trim(coalesce(size, '')) <> ''
      limit 1
    )
  )
  into v_has_size_model;

  if coalesce(v_has_size_model, false) then
    raise exception using
      message = 'No se permite escribir stock_qty directo en variant_warehouse_stock para variantes con talles. Usa variant_size_warehouse_stock.',
      detail = 'guard=variant_warehouse_stock_qty; op=' || tg_op
        || '; variant_id=' || coalesce(v_variant_id::text, 'null'),
      hint = 'Canal correcto: variant_size_warehouse_stock.';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_variant_warehouse_stock_qty_writes on public.variant_warehouse_stock;
create trigger trg_guard_variant_warehouse_stock_qty_writes
before insert or update or delete
on public.variant_warehouse_stock
for each row
execute function public.guard_variant_warehouse_stock_qty_writes();

select pg_notify('pgrst', 'reload schema');
