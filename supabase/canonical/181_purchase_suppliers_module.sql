-- 181_purchase_suppliers_module.sql
--
-- Módulo de compras a proveedores (independiente del catálogo public.suppliers).
-- Incluye: temporadas, fichas, reglas versionadas, pedidos/líneas, recepciones,
-- RPC resolve + compute (validación estricta) + register_receipt, vistas arqueo.

-- ---------------------------------------------------------------------------
-- 0) Extensión unaccent (matching robusto de aliases)
-- ---------------------------------------------------------------------------

-- unaccent: en Supabase suele vivir en schema extensions
create extension if not exists unaccent with schema extensions;

-- ---------------------------------------------------------------------------
-- 1) Tablas base
-- ---------------------------------------------------------------------------

create table if not exists public.purchase_seasons (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  date_start date,
  date_end date,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.purchase_seasons is
  'Temporadas comerciales para arqueo e inversión por período (módulo compras proveedores).';

create table if not exists public.purchase_suppliers (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  display_name text not null,
  aliases text[] not null default '{}',
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint purchase_suppliers_slug_unique unique (slug)
);

create index if not exists ix_purchase_suppliers_active on public.purchase_suppliers (active) where active = true;

comment on table public.purchase_suppliers is
  'Proveedor de compras (no confundir con public.suppliers del catálogo FYL).';

create table if not exists public.purchase_supplier_rule_versions (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.purchase_suppliers (id) on delete cascade,
  version int not null,
  valid_from timestamptz not null default now(),
  is_active boolean not null default false,
  rules jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint purchase_rule_versions_supplier_version unique (supplier_id, version)
);

create unique index if not exists purchase_rule_versions_one_active_per_supplier
  on public.purchase_supplier_rule_versions (supplier_id)
  where is_active = true;

comment on table public.purchase_supplier_rule_versions is
  'Reglas JSON versionadas; ver docs/PURCHASE_RULES_SCHEMA.md. Validación en purchase_compute_lines.';

-- Ingest: vínculo opcional al proveedor de compras resuelto
alter table public.supplier_message_ingest
  add column if not exists purchase_supplier_id uuid references public.purchase_suppliers (id);

create index if not exists ix_supplier_message_ingest_purchase_supplier
  on public.supplier_message_ingest (purchase_supplier_id)
  where purchase_supplier_id is not null;

create table if not exists public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  ingest_id uuid references public.supplier_message_ingest (id) on delete set null,
  supplier_id uuid references public.purchase_suppliers (id) on delete restrict,
  season_id uuid references public.purchase_seasons (id) on delete set null,
  status text not null default 'open'
    check (status in ('open', 'closed', 'cancelled')),
  ordered_at timestamptz not null default now(),
  notes text,
  needs_review boolean not null default false,
  needs_review_source text,
  review_reason text,
  total_gross numeric(14,2),
  total_discount numeric(14,2),
  total_net numeric(14,2),
  total_estimated_pairs numeric(14,4),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ix_purchase_orders_supplier_ordered on public.purchase_orders (supplier_id, ordered_at desc);
create index if not exists ix_purchase_orders_season on public.purchase_orders (season_id);

create table if not exists public.purchase_order_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.purchase_orders (id) on delete cascade,
  line_index int not null default 0,
  raw_line_text text,
  article_code text,
  color text,
  size text,
  unit_text text,
  normalized_unit_code text,
  qty_ordered numeric(14,4) not null,
  unit_price numeric(14,4),
  currency text default 'ARS',
  price_basis_hint text,
  price_basis_resolved text,
  estimated_pairs numeric(14,4),
  gross_amount numeric(14,2),
  discount_pct_applied numeric(7,4),
  discount_amount numeric(14,2),
  net_amount numeric(14,2),
  rules_version_id uuid references public.purchase_supplier_rule_versions (id),
  calculation_snapshot jsonb,
  needs_review boolean not null default false,
  needs_review_source text,
  review_reason text,
  parse_confidence numeric(5,4),
  created_at timestamptz not null default now(),
  constraint purchase_order_lines_line_unique unique (order_id, line_index)
);

create index if not exists ix_purchase_order_lines_order on public.purchase_order_lines (order_id);

create table if not exists public.purchase_receipts (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.purchase_orders (id) on delete cascade,
  received_at timestamptz not null default now(),
  note text,
  source text not null default 'manual_admin',
  created_at timestamptz not null default now()
);

create index if not exists ix_purchase_receipts_order on public.purchase_receipts (order_id);

create table if not exists public.purchase_receipt_lines (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.purchase_receipts (id) on delete cascade,
  order_line_id uuid not null references public.purchase_order_lines (id) on delete restrict,
  qty_received numeric(14,4) not null,
  pairs_received numeric(14,4) not null default 0,
  breakdown jsonb,
  created_at timestamptz not null default now()
);

create index if not exists ix_purchase_receipt_lines_line on public.purchase_receipt_lines (order_line_id);

-- ---------------------------------------------------------------------------
-- 2) Triggers updated_at
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'purchase_seasons_set_updated_at') then
    create trigger purchase_seasons_set_updated_at
      before update on public.purchase_seasons
      for each row execute function public.set_updated_at();
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'purchase_suppliers_set_updated_at') then
    create trigger purchase_suppliers_set_updated_at
      before update on public.purchase_suppliers
      for each row execute function public.set_updated_at();
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'purchase_orders_set_updated_at') then
    create trigger purchase_orders_set_updated_at
      before update on public.purchase_orders
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3) Función normalización texto (unaccent + lower + espacios)
-- ---------------------------------------------------------------------------

create or replace function public.purchase_normalize_hint(p_text text)
returns text
language sql
immutable
as $$
  select nullif(
    trim(
      regexp_replace(
        lower(extensions.unaccent(coalesce(p_text, ''))),
        '\s+',
        ' ',
        'g'
      )
    ),
    ''
  );
$$;

-- ---------------------------------------------------------------------------
-- 4) RPC: purchase_resolve_supplier
-- ---------------------------------------------------------------------------

create or replace function public.purchase_resolve_supplier(p_hint text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_norm text;
  v_norm_alt text;
  v_count int;
  v_id uuid;
begin
  v_norm := public.purchase_normalize_hint(p_hint);
  if v_norm is null then
    return jsonb_build_object('ok', false, 'reason', 'empty_hint');
  end if;

  -- Caso típico de ASR: "para dona" => "paradona". Probamos sin prefijo "para".
  v_norm_alt := nullif(trim(regexp_replace(v_norm, '^para\s*', '', 'g')), '');

  -- 1) Match exacto (slug/display_name/aliases) con hint normalizado original.
  select count(*)::int into v_count
  from public.purchase_suppliers ps
  where ps.active
    and (
      public.purchase_normalize_hint(ps.slug) = v_norm
      or public.purchase_normalize_hint(ps.display_name) = v_norm
      or exists (
        select 1
        from unnest(ps.aliases) a(alias_val)
        where public.purchase_normalize_hint(alias_val) = v_norm
      )
    );

  -- 2) Match exacto alternativo sin prefijo "para", solo si no hubo match.
  if v_count = 0 and v_norm_alt is not null and v_norm_alt <> v_norm then
    select count(*)::int into v_count
    from public.purchase_suppliers ps
    where ps.active
      and (
        public.purchase_normalize_hint(ps.slug) = v_norm_alt
        or public.purchase_normalize_hint(ps.display_name) = v_norm_alt
        or exists (
          select 1
          from unnest(ps.aliases) a(alias_val)
          where public.purchase_normalize_hint(alias_val) = v_norm_alt
        )
      );
    if v_count > 0 then
      v_norm := v_norm_alt;
    end if;
  end if;

  -- 3) Fallback: contains bidireccional (e.g. "paradona" contiene "dona").
  if v_count = 0 then
    select count(*)::int into v_count
    from public.purchase_suppliers ps
    where ps.active
      and (
        public.purchase_normalize_hint(ps.slug) like '%' || v_norm || '%'
        or v_norm like '%' || public.purchase_normalize_hint(ps.slug) || '%'
        or public.purchase_normalize_hint(ps.display_name) like '%' || v_norm || '%'
        or v_norm like '%' || public.purchase_normalize_hint(ps.display_name) || '%'
        or exists (
          select 1
          from unnest(ps.aliases) a(alias_val)
          where public.purchase_normalize_hint(alias_val) like '%' || v_norm || '%'
             or v_norm like '%' || public.purchase_normalize_hint(alias_val) || '%'
        )
      );
  end if;

  if v_count = 0 then
    return jsonb_build_object('ok', false, 'reason', 'not_found', 'normalized_hint', v_norm);
  end if;

  if v_count > 1 then
    return jsonb_build_object('ok', false, 'reason', 'ambiguous', 'normalized_hint', v_norm, 'match_count', v_count);
  end if;

  select ps.id into v_id
  from public.purchase_suppliers ps
  where ps.active
    and (
      public.purchase_normalize_hint(ps.slug) = v_norm
      or public.purchase_normalize_hint(ps.display_name) = v_norm
      or exists (
        select 1
        from unnest(ps.aliases) a(alias_val)
        where public.purchase_normalize_hint(alias_val) = v_norm
      )
    )
  limit 1;

  if v_id is null then
    select ps.id into v_id
    from public.purchase_suppliers ps
    where ps.active
      and (
        public.purchase_normalize_hint(ps.slug) like '%' || v_norm || '%'
        or v_norm like '%' || public.purchase_normalize_hint(ps.slug) || '%'
        or public.purchase_normalize_hint(ps.display_name) like '%' || v_norm || '%'
        or v_norm like '%' || public.purchase_normalize_hint(ps.display_name) || '%'
        or exists (
          select 1
          from unnest(ps.aliases) a(alias_val)
          where public.purchase_normalize_hint(alias_val) like '%' || v_norm || '%'
             or v_norm like '%' || public.purchase_normalize_hint(alias_val) || '%'
        )
      )
    limit 1;
  end if;

  return jsonb_build_object('ok', true, 'supplier_id', v_id, 'normalized_hint', v_norm);
end;
$$;

comment on function public.purchase_resolve_supplier(text) is
  'Resuelve supplier_hint normalizado contra slug, display_name y aliases[].';

grant execute on function public.purchase_resolve_supplier(text) to service_role;
grant execute on function public.purchase_resolve_supplier(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5) RPC: purchase_compute_lines (validación estricta; sin defaults silenciosos)
-- ---------------------------------------------------------------------------

create or replace function public.purchase_compute_lines(
  p_supplier_id uuid,
  p_rules_version_id uuid,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_rules jsonb;
  v_currency text;
  v_discount_pct numeric;
  v_units jsonb;
  v_item jsonb;
  v_idx int := 0;
  v_unit_text text;
  v_qty numeric;
  v_unit_price numeric;
  v_price_hint text;
  v_article text;
  v_color text;
  v_size text;
  v_raw text;
  v_conf numeric;
  v_needs_ai boolean;
  v_code text;
  v_unit_def jsonb;
  v_pairs_per_unit numeric;
  v_default_basis text;
  v_allowed jsonb;
  v_resolved_basis text;
  v_est_pairs numeric;
  v_gross numeric;
  v_disc_amt numeric;
  v_net numeric;
  v_lines jsonb := '[]'::jsonb;
  v_line jsonb;
  v_errs jsonb := '[]'::jsonb;
    v_norm_input text;
    v_k text;
  v_labels jsonb;
  v_lab text;
  v_found boolean;
begin
  if p_supplier_id is null or p_rules_version_id is null then
    return jsonb_build_object('ok', false, 'errors', jsonb_build_array(jsonb_build_object(
      'code', 'invalid_input', 'message', 'supplier_id y rules_version_id son obligatorios'
    )));
  end if;

  select r.rules into v_rules
  from public.purchase_supplier_rule_versions r
  where r.id = p_rules_version_id
    and r.supplier_id = p_supplier_id
    and r.is_active = true;

  if v_rules is null then
    return jsonb_build_object('ok', false, 'errors', jsonb_build_array(jsonb_build_object(
      'code', 'rules_not_found', 'message', 'Versión de reglas no activa o no pertenece al proveedor'
    )));
  end if;

  v_units := v_rules -> 'units';
  if v_units is null or jsonb_typeof(v_units) <> 'object' then
    return jsonb_build_object('ok', false, 'errors', jsonb_build_array(jsonb_build_object(
      'code', 'rules_missing_units', 'message', 'rules.units es obligatorio y debe ser objeto'
    )));
  end if;

  v_currency := coalesce(v_rules ->> 'currency', 'ARS');
  v_discount_pct := coalesce((v_rules ->> 'default_discount_pct')::numeric, 0);
  if v_discount_pct < 0 or v_discount_pct > 100 then
    return jsonb_build_object('ok', false, 'errors', jsonb_build_array(jsonb_build_object(
      'code', 'invalid_discount', 'message', 'default_discount_pct debe estar entre 0 y 100'
    )));
  end if;

  if jsonb_typeof(p_items) <> 'array' then
    return jsonb_build_object('ok', false, 'errors', jsonb_build_array(jsonb_build_object(
      'code', 'items_not_array', 'message', 'p_items debe ser array JSON'
    )));
  end if;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_idx := v_idx + 1;
    v_unit_text := v_item ->> 'unit_text';
    v_qty := (v_item ->> 'quantity')::numeric;
    v_unit_price := nullif((v_item ->> 'unit_price')::numeric, null);
    v_price_hint := nullif(lower(trim(coalesce(v_item ->> 'price_basis_hint', 'unknown'))), '');
    if v_price_hint is null or v_price_hint = '' then
      v_price_hint := 'unknown';
    end if;
    v_article := v_item ->> 'article_code';
    v_color := v_item ->> 'color';
    v_size := v_item ->> 'size';
    v_raw := v_item ->> 'raw_line_text';
    v_conf := nullif((v_item ->> 'confidence')::numeric, null);
    v_needs_ai := coalesce((v_item ->> 'needs_review')::boolean, false);

    if v_unit_text is null or trim(v_unit_text) = '' then
      v_errs := v_errs || jsonb_build_array(jsonb_build_object(
        'line_index', v_idx, 'code', 'missing_unit_text', 'message', 'unit_text obligatorio'
      ));
      continue;
    end if;

    if v_qty is null or v_qty <= 0 then
      v_errs := v_errs || jsonb_build_array(jsonb_build_object(
        'line_index', v_idx, 'code', 'invalid_quantity', 'message', 'quantity debe ser > 0'
      ));
      continue;
    end if;

    v_norm_input := public.purchase_normalize_hint(v_unit_text);
    v_found := false;
    v_code := null;

    <<key_loop>>
    for v_k in select jsonb_object_keys(v_units)
    loop
      v_unit_def := v_units -> v_k;
      v_pairs_per_unit := nullif((v_unit_def ->> 'pairs_per_unit')::numeric, null);
      if v_pairs_per_unit is null or v_pairs_per_unit <= 0 then
        continue;
      end if;

      if public.purchase_normalize_hint(v_k) = v_norm_input then
        v_found := true;
        v_code := v_k;
        exit key_loop;
      end if;

      v_labels := v_unit_def -> 'match';
      if v_labels is not null and jsonb_typeof(v_labels) = 'array' then
        for v_lab in select jsonb_array_elements_text(v_labels)
        loop
          if public.purchase_normalize_hint(v_lab) = v_norm_input then
            v_found := true;
            v_code := v_k;
            exit key_loop;
          end if;
        end loop;
      end if;
    end loop key_loop;

    if not v_found or v_code is null then
      v_errs := v_errs || jsonb_build_array(jsonb_build_object(
        'line_index', v_idx, 'code', 'unit_not_in_rules', 'message', format('Unidad no reconocida en rules.units: %s', v_unit_text)
      ));
      continue;
    end if;

    v_unit_def := v_units -> v_code;
    v_pairs_per_unit := (v_unit_def ->> 'pairs_per_unit')::numeric;
    v_default_basis := nullif(trim(lower(v_unit_def ->> 'default_price_basis')), '');
    if v_default_basis is null or v_default_basis not in ('per_par', 'per_tarea', 'per_unit') then
      v_errs := v_errs || jsonb_build_array(jsonb_build_object(
        'line_index', v_idx, 'code', 'missing_default_price_basis', 'message', format('Unidad %s sin default_price_basis válido', v_code)
      ));
      continue;
    end if;

    v_allowed := coalesce(v_unit_def -> 'allowed_price_bases', '[]'::jsonb);
    if jsonb_array_length(v_allowed) = 0 then
      v_allowed := jsonb_build_array(to_jsonb(v_default_basis));
    end if;

    if v_price_hint = 'unknown' then
      v_resolved_basis := v_default_basis;
    elsif exists (
      select 1 from jsonb_array_elements_text(v_allowed) b(val) where val = v_price_hint
    ) then
      v_resolved_basis := v_price_hint;
    else
      v_errs := v_errs || jsonb_build_array(jsonb_build_object(
        'line_index', v_idx, 'code', 'price_basis_incompatible', 'message', format('price_basis_hint %s no permitido para unidad %s', v_price_hint, v_code)
      ));
      continue;
    end if;

    if v_resolved_basis = 'per_par' and v_unit_price is not null then
      v_est_pairs := v_qty * v_pairs_per_unit;
      v_gross := round(v_est_pairs * v_unit_price, 2);
    elsif v_resolved_basis in ('per_tarea', 'per_unit') and v_unit_price is not null then
      v_est_pairs := v_qty * v_pairs_per_unit;
      v_gross := round(v_qty * v_unit_price, 2);
    elsif v_unit_price is null then
      v_est_pairs := v_qty * v_pairs_per_unit;
      v_gross := null;
    else
      v_errs := v_errs || jsonb_build_array(jsonb_build_object(
        'line_index', v_idx, 'code', 'price_basis_unhandled', 'message', format('Combinación precio/base no soportada: %s', v_resolved_basis)
      ));
      continue;
    end if;

    v_disc_amt := case when v_gross is not null then round(v_gross * (v_discount_pct / 100.0), 2) else null end;
    v_net := case when v_gross is not null then round(v_gross - coalesce(v_disc_amt, 0), 2) else null end;

    v_line := jsonb_build_object(
      'line_index', v_idx,
      'raw_line_text', v_raw,
      'article_code', v_article,
      'color', v_color,
      'size', v_size,
      'unit_text', v_unit_text,
      'normalized_unit_code', v_code,
      'qty_ordered', v_qty,
      'unit_price', v_unit_price,
      'currency', v_currency,
      'price_basis_hint', v_price_hint,
      'price_basis_resolved', v_resolved_basis,
      'estimated_pairs', v_est_pairs,
      'gross_amount', v_gross,
      'discount_pct_applied', v_discount_pct,
      'discount_amount', v_disc_amt,
      'net_amount', v_net,
      'rules_version_id', p_rules_version_id,
      'calculation_snapshot', jsonb_build_object(
        'unit_def', v_unit_def,
        'pairs_per_unit', v_pairs_per_unit
      ),
      'needs_review', v_needs_ai or (v_gross is null),
      'needs_review_source', case when v_needs_ai then 'openai' when v_gross is null then 'rpc' else null end,
      'review_reason', case when v_gross is null then 'missing_unit_price_for_amounts' else null end,
      'parse_confidence', v_conf
    );
    v_lines := v_lines || jsonb_build_array(v_line);
  end loop;

  if jsonb_array_length(v_errs) > 0 then
    return jsonb_build_object('ok', false, 'needs_review', true, 'errors', v_errs, 'lines', v_lines);
  end if;

  return jsonb_build_object(
    'ok', true,
    'needs_review', false,
    'lines', v_lines,
    'currency', v_currency,
    'default_discount_pct', v_discount_pct,
    'totals', jsonb_build_object(
      'total_gross', coalesce((select round(sum((l ->> 'gross_amount')::numeric), 2) from jsonb_array_elements(v_lines) as t(l)), 0),
      'total_discount', coalesce((select round(sum((l ->> 'discount_amount')::numeric), 2) from jsonb_array_elements(v_lines) as t(l)), 0),
      'total_net', coalesce((select round(sum((l ->> 'net_amount')::numeric), 2) from jsonb_array_elements(v_lines) as t(l)), 0),
      'total_estimated_pairs', coalesce((select round(sum((l ->> 'estimated_pairs')::numeric), 4) from jsonb_array_elements(v_lines) as t(l)), 0)
    )
  );
end;
$$;

comment on function public.purchase_compute_lines(uuid, uuid, jsonb) is
  'Calcula líneas de compra desde items extraídos + rules JSON. Sin defaults silenciosos: errores en errors[].';

grant execute on function public.purchase_compute_lines(uuid, uuid, jsonb) to service_role;
grant execute on function public.purchase_compute_lines(uuid, uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 6) RPC: purchase_register_receipt
-- ---------------------------------------------------------------------------

create or replace function public.purchase_register_receipt(
  p_order_id uuid,
  p_received_at timestamptz,
  p_note text,
  p_source text,
  p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rid uuid;
  v_line jsonb;
  v_oid uuid;
  v_qty numeric;
  v_pairs numeric;
  v_pending numeric;
  v_sum numeric;
begin
  if p_order_id is null then
    return jsonb_build_object('ok', false, 'message', 'order_id obligatorio');
  end if;

  if not exists (select 1 from public.purchase_orders o where o.id = p_order_id) then
    return jsonb_build_object('ok', false, 'message', 'Pedido no existe');
  end if;

  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    return jsonb_build_object('ok', false, 'message', 'p_lines debe ser array no vacío');
  end if;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_oid := nullif(v_line ->> 'order_line_id', '')::uuid;
    v_qty := (v_line ->> 'qty_received')::numeric;
    v_pairs := coalesce((v_line ->> 'pairs_received')::numeric, 0);

    if v_oid is null or v_qty is null or v_qty <= 0 then
      return jsonb_build_object('ok', false, 'message', 'Cada línea requiere order_line_id y qty_received > 0');
    end if;

    if not exists (
      select 1 from public.purchase_order_lines pl
      join public.purchase_orders po on po.id = pl.order_id
      where pl.id = v_oid and po.id = p_order_id
    ) then
      return jsonb_build_object('ok', false, 'message', 'order_line_id no pertenece al pedido');
    end if;

    select coalesce(sum(rl.qty_received), 0) into v_sum
    from public.purchase_receipt_lines rl
    join public.purchase_receipts r on r.id = rl.receipt_id
    where rl.order_line_id = v_oid and r.order_id = p_order_id;

    select pl.qty_ordered into v_pending
    from public.purchase_order_lines pl where pl.id = v_oid;

    if v_sum + v_qty > v_pending + 0.0001 then
      return jsonb_build_object('ok', false, 'message', format('qty_received excede pendiente para línea %s', v_oid));
    end if;
  end loop;

  insert into public.purchase_receipts (order_id, received_at, note, source)
  values (
    p_order_id,
    coalesce(p_received_at, now()),
    p_note,
    coalesce(nullif(trim(p_source), ''), 'manual_admin')
  )
  returning id into v_rid;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_oid := nullif(v_line ->> 'order_line_id', '')::uuid;
    v_qty := (v_line ->> 'qty_received')::numeric;
    v_pairs := coalesce((v_line ->> 'pairs_received')::numeric, 0);
    insert into public.purchase_receipt_lines (receipt_id, order_line_id, qty_received, pairs_received, breakdown)
    values (v_rid, v_oid, v_qty, v_pairs, v_line -> 'breakdown');
  end loop;

  return jsonb_build_object('ok', true, 'receipt_id', v_rid);
end;
$$;

grant execute on function public.purchase_register_receipt(uuid, timestamptz, text, text, jsonb) to service_role;
grant execute on function public.purchase_register_receipt(uuid, timestamptz, text, text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 6b) RPC: nueva versión de reglas (desactiva anteriores)
-- ---------------------------------------------------------------------------

create or replace function public.purchase_create_rule_version(
  p_supplier_id uuid,
  p_rules jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next int;
  v_id uuid;
begin
  if p_supplier_id is null or p_rules is null or jsonb_typeof(p_rules) <> 'object' then
    raise exception 'supplier_id y rules json objeto son obligatorios';
  end if;

  update public.purchase_supplier_rule_versions
  set is_active = false
  where supplier_id = p_supplier_id;

  select coalesce(max(version), 0) + 1 into v_next
  from public.purchase_supplier_rule_versions
  where supplier_id = p_supplier_id;

  insert into public.purchase_supplier_rule_versions (supplier_id, version, is_active, rules)
  values (p_supplier_id, v_next, true, p_rules)
  returning id into v_id;

  return v_id;
end;
$$;

grant execute on function public.purchase_create_rule_version(uuid, jsonb) to service_role;
grant execute on function public.purchase_create_rule_version(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 7) Vistas
-- ---------------------------------------------------------------------------

create or replace view public.purchase_order_line_fulfillment as
select
  pl.id as order_line_id,
  pl.order_id,
  pl.qty_ordered,
  pl.estimated_pairs,
  coalesce(sum(rl.qty_received), 0)::numeric(14,4) as qty_received_sum,
  coalesce(sum(rl.pairs_received), 0)::numeric(14,4) as pairs_received_sum,
  greatest(pl.qty_ordered - coalesce(sum(rl.qty_received), 0), 0)::numeric(14,4) as qty_pending
from public.purchase_order_lines pl
left join public.purchase_receipt_lines rl on rl.order_line_id = pl.id
group by pl.id, pl.order_id, pl.qty_ordered, pl.estimated_pairs;

create or replace view public.purchase_spend_by_season as
select
  o.season_id,
  s.label as season_label,
  o.supplier_id,
  ps.display_name as supplier_name,
  count(*)::bigint as order_count,
  coalesce(sum(o.total_net), 0)::numeric(16,2) as sum_net,
  coalesce(sum(o.total_gross), 0)::numeric(16,2) as sum_gross,
  coalesce(sum(o.total_discount), 0)::numeric(16,2) as sum_discount,
  coalesce(sum(o.total_estimated_pairs), 0)::numeric(16,4) as sum_estimated_pairs
from public.purchase_orders o
left join public.purchase_seasons s on s.id = o.season_id
left join public.purchase_suppliers ps on ps.id = o.supplier_id
where o.status <> 'cancelled'
group by o.season_id, s.label, o.supplier_id, ps.display_name;

-- ---------------------------------------------------------------------------
-- 8) RLS (admins autenticados) + service_role grants
-- ---------------------------------------------------------------------------

-- Alineado con el gate del admin web: permiso granular `proveedores` (y super_admin),
-- no solo "existe fila en public.admins".
create or replace function public.purchase_module_admin_auth(check_user_id uuid default auth.uid())
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_admin_id uuid;
begin
  if check_user_id is null then
    return false;
  end if;

  if public.is_super_admin(check_user_id) then
    return true;
  end if;

  select a.id into v_admin_id
  from public.admins a
  where a.user_id = check_user_id
  limit 1;

  if v_admin_id is null then
    return false;
  end if;

  return exists (
    select 1
    from public.admin_permissions p
    where p.admin_id = v_admin_id
      and p.permission_key = 'proveedores'
      and (
        coalesce(p.can_view, false)
        or coalesce(p.can_edit, false)
        or coalesce(p.can_delete, false)
      )
  );
end;
$$;

alter table public.purchase_seasons enable row level security;
alter table public.purchase_suppliers enable row level security;
alter table public.purchase_supplier_rule_versions enable row level security;
alter table public.purchase_orders enable row level security;
alter table public.purchase_order_lines enable row level security;
alter table public.purchase_receipts enable row level security;
alter table public.purchase_receipt_lines enable row level security;

-- Políticas idempotentes (reemplazan nombres legacy *_admin_all).
drop policy if exists purchase_seasons_admin_all on public.purchase_seasons;
drop policy if exists purchase_suppliers_admin_all on public.purchase_suppliers;
drop policy if exists purchase_rule_versions_admin_all on public.purchase_supplier_rule_versions;
drop policy if exists purchase_orders_admin_all on public.purchase_orders;
drop policy if exists purchase_order_lines_admin_all on public.purchase_order_lines;
drop policy if exists purchase_receipts_admin_all on public.purchase_receipts;
drop policy if exists purchase_receipt_lines_admin_all on public.purchase_receipt_lines;

drop policy if exists purchase_seasons_module_all on public.purchase_seasons;
drop policy if exists purchase_suppliers_module_all on public.purchase_suppliers;
drop policy if exists purchase_rule_versions_module_all on public.purchase_supplier_rule_versions;
drop policy if exists purchase_orders_module_all on public.purchase_orders;
drop policy if exists purchase_order_lines_module_all on public.purchase_order_lines;
drop policy if exists purchase_receipts_module_all on public.purchase_receipts;
drop policy if exists purchase_receipt_lines_module_all on public.purchase_receipt_lines;

create policy purchase_seasons_module_all on public.purchase_seasons
  for all to authenticated
  using (public.purchase_module_admin_auth(auth.uid()))
  with check (public.purchase_module_admin_auth(auth.uid()));

create policy purchase_suppliers_module_all on public.purchase_suppliers
  for all to authenticated
  using (public.purchase_module_admin_auth(auth.uid()))
  with check (public.purchase_module_admin_auth(auth.uid()));

create policy purchase_rule_versions_module_all on public.purchase_supplier_rule_versions
  for all to authenticated
  using (public.purchase_module_admin_auth(auth.uid()))
  with check (public.purchase_module_admin_auth(auth.uid()));

create policy purchase_orders_module_all on public.purchase_orders
  for all to authenticated
  using (public.purchase_module_admin_auth(auth.uid()))
  with check (public.purchase_module_admin_auth(auth.uid()));

create policy purchase_order_lines_module_all on public.purchase_order_lines
  for all to authenticated
  using (public.purchase_module_admin_auth(auth.uid()))
  with check (public.purchase_module_admin_auth(auth.uid()));

create policy purchase_receipts_module_all on public.purchase_receipts
  for all to authenticated
  using (public.purchase_module_admin_auth(auth.uid()))
  with check (public.purchase_module_admin_auth(auth.uid()));

create policy purchase_receipt_lines_module_all on public.purchase_receipt_lines
  for all to authenticated
  using (public.purchase_module_admin_auth(auth.uid()))
  with check (public.purchase_module_admin_auth(auth.uid()));

grant select, insert, update, delete on public.purchase_seasons to authenticated;
grant select, insert, update, delete on public.purchase_suppliers to authenticated;
grant select, insert, update, delete on public.purchase_supplier_rule_versions to authenticated;
grant select, insert, update, delete on public.purchase_orders to authenticated;
grant select, insert, update, delete on public.purchase_order_lines to authenticated;
grant select, insert, update, delete on public.purchase_receipts to authenticated;
grant select, insert, update, delete on public.purchase_receipt_lines to authenticated;

grant all on public.purchase_seasons to service_role;
grant all on public.purchase_suppliers to service_role;
grant all on public.purchase_supplier_rule_versions to service_role;
grant all on public.purchase_orders to service_role;
grant all on public.purchase_order_lines to service_role;
grant all on public.purchase_receipts to service_role;
grant all on public.purchase_receipt_lines to service_role;

grant select on public.purchase_order_line_fulfillment to authenticated;
grant select on public.purchase_order_line_fulfillment to service_role;
grant select on public.purchase_spend_by_season to authenticated;
grant select on public.purchase_spend_by_season to service_role;

-- ---------------------------------------------------------------------------
-- 9) Seed ejemplo "Cara Regina" (idempotente por slug)
-- ---------------------------------------------------------------------------

insert into public.purchase_suppliers (slug, display_name, aliases, active, notes)
values (
  'cara-regina',
  'Cara Regina',
  array['Cara Regina', 'cara regina', 'CR', 'Regina']::text[],
  true,
  'Ejemplo plan compras: 20% dto, 1 tarea = 24 pares.'
)
on conflict (slug) do nothing;

insert into public.purchase_seasons (label, date_start, date_end, active)
select 'Demo 2026', '2026-01-01', '2026-12-31', true
where not exists (
  select 1 from public.purchase_seasons s where s.label = 'Demo 2026'
);

do $$
declare
  v_sid uuid;
  v_rules jsonb := jsonb_build_object(
    'currency', 'ARS',
    'default_discount_pct', 20,
    'units', jsonb_build_object(
      'par', jsonb_build_object(
        'pairs_per_unit', 1,
        'default_price_basis', 'per_par',
        'match', jsonb_build_array('par', 'pares', 'prs')
      ),
      'tarea', jsonb_build_object(
        'pairs_per_unit', 24,
        'default_price_basis', 'per_tarea',
        'allowed_price_bases', jsonb_build_array('per_tarea', 'per_par'),
        'match', jsonb_build_array('tarea', 'tareas', 'tar')
      )
    ),
    'size_mix_per_unit', jsonb_build_object(
      'tarea', jsonb_build_object('36', 3, '37', 4, '38', 5, '39', 5, '40', 4, '41', 3)
    )
  );
begin
  select id into v_sid from public.purchase_suppliers where slug = 'cara-regina' limit 1;
  if v_sid is not null and not exists (
    select 1 from public.purchase_supplier_rule_versions rv where rv.supplier_id = v_sid
  ) then
    insert into public.purchase_supplier_rule_versions (supplier_id, version, is_active, rules)
    values (v_sid, 1, true, v_rules);
  end if;
end $$;

select pg_notify('pgrst', 'reload schema');
