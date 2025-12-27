-- 14_public_sales.sql — Sistema de ventas al público con clientes y créditos (idempotente)

-- 1) Tabla de clientes de venta al público
create table if not exists public.public_sales_customers (
  id uuid primary key default gen_random_uuid(),
  customer_number text unique not null,
  first_name text not null,
  last_name text,
  phone text,
  email text,
  document_number text,
  qr_code uuid unique not null default gen_random_uuid(),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- 2) Tabla de créditos de clientes
create table if not exists public.public_sales_customer_credits (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.public_sales_customers(id) on delete cascade,
  amount numeric not null,
  expires_at timestamptz not null,
  created_at timestamptz default now(),
  notes text,
  check (expires_at > created_at)
);

-- 3) Tabla de ventas al público
create table if not exists public.public_sales (
  id uuid primary key default gen_random_uuid(),
  sale_number text unique not null,
  sold_by uuid references auth.users(id) on delete set null,
  customer_id uuid references public.public_sales_customers(id) on delete set null,
  total_amount numeric not null,
  item_count int not null default 0,
  credit_used numeric default 0,
  created_at timestamptz default now(),
  notes text
);

-- 4) Tabla de items de venta
create table if not exists public.public_sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.public_sales(id) on delete cascade,
  variant_id uuid not null references public.product_variants(id) on delete restrict,
  qty int not null check (qty > 0),
  price_snapshot numeric not null,
  is_return boolean default false,
  created_at timestamptz default now()
);

-- 5) Triggers updated_at
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'public_sales_customers_set_updated_at') then
    create trigger public_sales_customers_set_updated_at
      before update on public.public_sales_customers
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- 6) Función para generar número de cliente aleatorio
create or replace function public.generate_customer_number()
returns text language plpgsql as $$
declare
  chars text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  result text := '';
  i int;
  char_pos int;
begin
  -- Generar número aleatorio de 9 caracteres
  for i in 1..9 loop
    char_pos := floor(random() * length(chars) + 1)::int;
    result := result || substr(chars, char_pos, 1);
  end loop;
  
  -- Verificar que no exista
  while exists (select 1 from public.public_sales_customers where customer_number = result) loop
    result := '';
    for i in 1..9 loop
      char_pos := floor(random() * length(chars) + 1)::int;
      result := result || substr(chars, char_pos, 1);
    end loop;
  end loop;
  
  return result;
end $$;

-- 7) Función para generar número de venta progresivo
create or replace function public.generate_sale_number()
returns text language plpgsql as $$
declare
  last_number int;
  new_number text;
begin
  -- Obtener último número de venta
  select coalesce(
    max(
      case 
        when sale_number ~ '^#fylA[0-9]+$' 
        then (substring(sale_number from '#fylA([0-9]+)')::int)
        else 0
      end
    ), 0
  ) into last_number
  from public.public_sales
  where sale_number ~ '^#fylA[0-9]+$';
  
  -- Generar nuevo número
  new_number := '#fylA' || lpad((last_number + 1)::text, 5, '0');
  
  return new_number;
end $$;

-- 8) RPC: Crear cliente
create or replace function public.rpc_create_public_customer(
  p_first_name text,
  p_last_name text default null,
  p_phone text default null,
  p_email text default null,
  p_document_number text default null
)
returns json language plpgsql security definer as $$
declare
  v_customer_id uuid;
  v_customer_number text;
  v_qr_code uuid;
begin
  -- Validar nombre
  if p_first_name is null or trim(p_first_name) = '' then
    raise exception 'El nombre es obligatorio';
  end if;

  -- Generar número de cliente
  v_customer_number := public.generate_customer_number();
  
  -- Generar QR code (UUID)
  v_qr_code := gen_random_uuid();

  -- Crear cliente
  insert into public.public_sales_customers (
    customer_number,
    first_name,
    last_name,
    phone,
    email,
    document_number,
    qr_code
  )
  values (
    v_customer_number,
    trim(p_first_name),
    trim(p_last_name),
    trim(p_phone),
    trim(p_email),
    trim(p_document_number),
    v_qr_code
  )
  returning id, customer_number, qr_code into v_customer_id, v_customer_number, v_qr_code;

  return json_build_object(
    'success', true,
    'customer_id', v_customer_id,
    'customer_number', v_customer_number,
    'qr_code', v_qr_code
  );
end $$;

-- 9) RPC: Buscar cliente
create or replace function public.rpc_search_public_customer(p_search_term text)
returns json language plpgsql security definer as $$
declare
  v_result json;
begin
  select json_agg(
    json_build_object(
      'id', id,
      'customer_number', customer_number,
      'first_name', first_name,
      'last_name', last_name,
      'phone', phone,
      'email', email,
      'document_number', document_number,
      'qr_code', qr_code
    )
  ) into v_result
  from public.public_sales_customers
  where 
    lower(first_name || ' ' || coalesce(last_name, '')) like '%' || lower(trim(p_search_term)) || '%'
    or lower(coalesce(last_name, '')) like '%' || lower(trim(p_search_term)) || '%'
    or document_number = trim(p_search_term)
    or customer_number = upper(trim(p_search_term))
    or qr_code::text = trim(p_search_term)
  limit 20;

  return coalesce(v_result, '[]'::json);
end $$;

-- 10) RPC: Obtener créditos del cliente
create or replace function public.rpc_get_customer_credits(p_customer_id uuid)
returns json language plpgsql security definer as $$
declare
  v_result json;
begin
  select json_agg(
    json_build_object(
      'id', id,
      'amount', amount,
      'expires_at', expires_at,
      'days_remaining', greatest(0, extract(epoch from (expires_at - now())) / 86400)::int,
      'created_at', created_at,
      'notes', notes
    )
    order by expires_at asc
  ) into v_result
  from public.public_sales_customer_credits
  where customer_id = p_customer_id
    and expires_at > now()
    and amount > 0;

  return coalesce(v_result, '[]'::json);
end $$;

-- 11) RPC: Obtener crédito total disponible del cliente
create or replace function public.rpc_get_customer_total_credit(p_customer_id uuid)
returns numeric language plpgsql security definer as $$
declare
  v_total numeric;
begin
  select coalesce(sum(amount), 0) into v_total
  from public.public_sales_customer_credits
  where customer_id = p_customer_id
    and expires_at > now()
    and amount > 0;

  return coalesce(v_total, 0);
end $$;

-- 12) RPC: Agregar crédito al cliente
create or replace function public.rpc_add_customer_credit(
  p_customer_id uuid,
  p_amount numeric,
  p_notes text default null
)
returns json language plpgsql security definer as $$
declare
  v_credit_id uuid;
  v_expires_at timestamptz;
begin
  if p_amount <= 0 then
    raise exception 'El monto del crédito debe ser mayor a 0';
  end if;

  -- Calcular fecha de expiración (6 meses)
  v_expires_at := now() + interval '6 months';

  insert into public.public_sales_customer_credits (
    customer_id,
    amount,
    expires_at,
    notes
  )
  values (
    p_customer_id,
    p_amount,
    v_expires_at,
    p_notes
  )
  returning id into v_credit_id;

  return json_build_object(
    'success', true,
    'credit_id', v_credit_id,
    'amount', p_amount,
    'expires_at', v_expires_at
  );
end $$;

-- 13) RPC: Crear venta al público
create or replace function public.rpc_create_public_sale(
  p_items jsonb,
  p_customer_id uuid default null,
  p_notes text default null,
  p_apply_credit boolean default true
)
returns json language plpgsql security definer as $$
declare
  v_user_id uuid;
  v_sale_id uuid;
  v_sale_number text;
  v_total_amount numeric := 0;
  v_item_count int := 0;
  v_credit_used numeric := 0;
  v_total_credit numeric := 0;
  v_item jsonb;
  v_variant_id uuid;
  v_qty int;
  v_price numeric;
  v_is_return boolean;
  v_stock_data jsonb;
  v_warehouse_code text;
  v_available_stock int;
  v_credit_remaining numeric;
  v_general_stock int;
  v_venta_publico_stock int;
  v_remaining_credit numeric;
  v_credit_record record;
  v_qty_venta_publico int;
  v_qty_general int;
begin
  -- Obtener usuario actual
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  -- Validar que sea admin
  if not exists (select 1 from public.admins where user_id = v_user_id) then
    raise exception 'No tienes permiso para realizar ventas';
  end if;

  -- Generar número de venta
  v_sale_number := public.generate_sale_number();

  -- Calcular crédito disponible si hay cliente
  if p_customer_id is not null and p_apply_credit then
    select public.rpc_get_customer_total_credit(p_customer_id) into v_total_credit;
  end if;

  -- Procesar items y calcular total
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_variant_id := (v_item->>'variant_id')::uuid;
    v_qty := (v_item->>'qty')::int;
    v_price := (v_item->>'price')::numeric;
    v_is_return := coalesce((v_item->>'is_return')::boolean, false);
    declare
      v_from_local_order boolean := coalesce((v_item->>'from_local_order')::boolean, false);
    begin
      if not v_is_return then
        -- Si el item viene de un pedido local, el stock ya fue descontado en orders
        -- No necesitamos validar ni descontar stock nuevamente
        if not v_from_local_order then
        -- Validar stock disponible
      select json_agg(
        json_build_object(
          'warehouse_code', warehouse_code,
          'stock', stock
        )
      ) into v_stock_data
      from (
        select 
          w.code as warehouse_code,
          coalesce(vws.stock_qty, 0) as stock
        from public.warehouses w
        left join public.variant_warehouse_stock vws 
          on vws.warehouse_id = w.id 
          and vws.variant_id = v_variant_id
        where w.code in ('general', 'venta-publico')
        order by w.code
      ) stock_info;

      -- Obtener stock de cada almacén
      v_general_stock := 0;
      v_venta_publico_stock := 0;

      select coalesce((elem->>'stock')::int, 0) into v_general_stock
      from jsonb_array_elements(v_stock_data) elem
      where (elem->>'warehouse_code') = 'general'
      limit 1;

      select coalesce((elem->>'stock')::int, 0) into v_venta_publico_stock
      from jsonb_array_elements(v_stock_data) elem
      where (elem->>'warehouse_code') = 'venta-publico'
      limit 1;

      if v_general_stock = 0 and v_venta_publico_stock = 0 then
        raise exception 'No hay stock disponible para la variante %', v_variant_id;
      end if;

      if v_qty > (v_general_stock + v_venta_publico_stock) then
        raise exception 'Stock insuficiente. Disponible: %, Solicitado: %', 
          (v_general_stock + v_venta_publico_stock), v_qty;
      end if;

      -- Obtener fuente del stock desde el item (si está disponible)
      v_qty_venta_publico := 0;
      v_qty_general := 0;
      
      if v_item->'source' is not null then
        -- Usar la fuente especificada en el item
        v_qty_venta_publico := coalesce((v_item->'source'->>'venta_publico')::int, 0);
        v_qty_general := coalesce((v_item->'source'->>'general')::int, 0);
        
        -- Validar que la suma coincida con la cantidad total
        if (v_qty_venta_publico + v_qty_general) != v_qty then
          -- Si no coincide, usar lógica automática
          v_qty_venta_publico := 0;
          v_qty_general := 0;
        end if;
      end if;
      
      -- Si no se especificó fuente, usar lógica automática (priorizar venta-publico)
      if v_qty_venta_publico = 0 and v_qty_general = 0 then
        if v_venta_publico_stock > 0 then
          -- Hay stock en venta-publico, descontar de ahí primero
          if v_qty <= v_venta_publico_stock then
            v_qty_venta_publico := v_qty;
            v_qty_general := 0;
          else
            v_qty_venta_publico := v_venta_publico_stock;
            v_qty_general := v_qty - v_venta_publico_stock;
          end if;
        else
          -- Solo hay stock en general
          v_qty_venta_publico := 0;
          v_qty_general := v_qty;
        end if;
      end if;
      
      -- Validar que hay suficiente stock en cada almacén
      if v_qty_venta_publico > v_venta_publico_stock then
        raise exception 'Stock insuficiente en venta-publico. Disponible: %, Solicitado: %', 
          v_venta_publico_stock, v_qty_venta_publico;
      end if;
      
      if v_qty_general > v_general_stock then
        raise exception 'Stock insuficiente en general. Disponible: %, Solicitado: %', 
          v_general_stock, v_qty_general;
      end if;

      -- Descontar del almacén correspondiente según la fuente especificada
      if v_qty_venta_publico > 0 then
        update public.variant_warehouse_stock
        set stock_qty = stock_qty - v_qty_venta_publico,
            updated_at = now()
        where variant_id = v_variant_id
          and warehouse_id = (select id from public.warehouses where code = 'venta-publico');
      end if;
      
      if v_qty_general > 0 then
        update public.variant_warehouse_stock
        set stock_qty = stock_qty - v_qty_general,
            updated_at = now()
        where variant_id = v_variant_id
          and warehouse_id = (select id from public.warehouses where code = 'general');
      end if;
        end if; -- Cerrar bloque "if not v_from_local_order"
      else
        -- Es devolución, sumar stock a venta-publico
        insert into public.variant_warehouse_stock (variant_id, warehouse_id, stock_qty)
        select 
          v_variant_id,
          (select id from public.warehouses where code = 'venta-publico'),
          v_qty
        on conflict (variant_id, warehouse_id)
        do update set
          stock_qty = variant_warehouse_stock.stock_qty + v_qty,
          updated_at = now();
      end if; -- Cerrar bloque "if not v_is_return"

    -- Calcular total: sumar ventas, restar devoluciones
    if v_is_return then
      v_total_amount := v_total_amount - (v_price * v_qty);
    else
      v_total_amount := v_total_amount + (v_price * v_qty);
    end if;
    v_item_count := v_item_count + 1;
    end; -- Cerrar bloque "declare"
  end loop;

  -- Aplicar crédito si existe y se solicita
  if v_total_credit > 0 and p_apply_credit and v_total_amount > 0 then
    -- Calcular cuánto crédito usar (solo si el total es positivo)
    if v_total_credit >= v_total_amount then
      -- Crédito cubre toda la compra
      v_credit_used := v_total_amount;
      v_total_amount := 0;
    else
      -- Crédito parcial
      v_credit_used := v_total_credit;
      v_total_amount := v_total_amount - v_credit_used;
    end if;

    -- Descontar créditos usados (FIFO - primero los que expiran antes)
    v_remaining_credit := v_credit_used;
    for v_credit_record in 
      select id, amount
      from public.public_sales_customer_credits
      where customer_id = p_customer_id
        and expires_at > now()
        and amount > 0
      order by expires_at asc
    loop
      if v_remaining_credit <= 0 then
        exit;
      end if;

      if v_credit_record.amount <= v_remaining_credit then
        -- Este crédito se agota completamente
        update public.public_sales_customer_credits
        set amount = 0
        where id = v_credit_record.id;
        v_remaining_credit := v_remaining_credit - v_credit_record.amount;
      else
        -- Este crédito se usa parcialmente
        update public.public_sales_customer_credits
        set amount = amount - v_remaining_credit
        where id = v_credit_record.id;
        v_remaining_credit := 0;
      end if;
    end loop;
  end if;

  -- Crear registro de venta
  insert into public.public_sales (
    sale_number,
    sold_by,
    customer_id,
    total_amount,
    item_count,
    credit_used,
    notes
  )
  values (
    v_sale_number,
    v_user_id,
    p_customer_id,
    v_total_amount,
    v_item_count,
    v_credit_used,
    p_notes
  )
  returning id into v_sale_id;

  -- Crear items de venta
  for v_item in select * from jsonb_array_elements(p_items) loop
    insert into public.public_sale_items (
      sale_id,
      variant_id,
      qty,
      price_snapshot,
      is_return
    )
    values (
      v_sale_id,
      (v_item->>'variant_id')::uuid,
      (v_item->>'qty')::int,
      (v_item->>'price')::numeric,
      coalesce((v_item->>'is_return')::boolean, false)
    );
  end loop;

  return json_build_object(
    'success', true,
    'sale_id', v_sale_id,
    'sale_number', v_sale_number,
    'total_amount', v_total_amount,
    'credit_used', v_credit_used,
    'item_count', v_item_count
  );
end $$;

-- 14) RPC: Agregar crédito por devolución negativa (opcional)
create or replace function public.rpc_add_return_credit(
  p_customer_id uuid,
  p_amount numeric,
  p_notes text default null
)
returns json language plpgsql security definer as $$
begin
  -- Los créditos de devolución también tienen 6 meses de validez
  return public.rpc_add_customer_credit(p_customer_id, p_amount, p_notes);
end $$;

-- 15) RPC: Obtener historial de ventas
create or replace function public.rpc_get_public_sales_history(
  p_limit int default 10,
  p_offset int default 0,
  p_date_filter date default null,
  p_customer_search text default null
)
returns json language plpgsql security definer as $$
declare
  v_result json;
begin
  select json_agg(
    json_build_object(
      'id', ps.id,
      'sale_number', ps.sale_number,
      'created_at', ps.created_at,
      'customer_name', 
        case 
          when psc.first_name is not null 
          then psc.first_name || ' ' || coalesce(psc.last_name, '')
          else null
        end,
      'total_amount', ps.total_amount,
      'item_count', ps.item_count,
      'credit_used', ps.credit_used
    )
    order by ps.created_at desc
  ) into v_result
  from (
    select ps.id, ps.sale_number, ps.created_at, ps.total_amount, ps.item_count, ps.credit_used, ps.customer_id
    from public.public_sales ps
    left join public.public_sales_customers psc on psc.id = ps.customer_id
    where 
      (p_date_filter is null or date(ps.created_at) = p_date_filter)
      and (
        p_customer_search is null 
        or p_customer_search = ''
        or (
          psc.first_name ilike '%' || p_customer_search || '%'
          or psc.last_name ilike '%' || p_customer_search || '%'
          or (psc.first_name || ' ' || coalesce(psc.last_name, '')) ilike '%' || p_customer_search || '%'
        )
      )
    order by ps.created_at desc
    limit p_limit
    offset p_offset
  ) ps
  left join public.public_sales_customers psc on psc.id = ps.customer_id;

  return coalesce(v_result, '[]'::json);
end $$;

-- 16) RPC: Obtener detalles de una venta
create or replace function public.rpc_get_public_sale_details(p_sale_id uuid)
returns json language plpgsql security definer as $$
declare
  v_result json;
begin
  select json_build_object(
    'sale', json_build_object(
      'id', ps.id,
      'sale_number', ps.sale_number,
      'created_at', ps.created_at,
      'customer_name',
        case 
          when psc.first_name is not null 
          then psc.first_name || ' ' || coalesce(psc.last_name, '')
          else null
        end,
      'total_amount', ps.total_amount,
      'item_count', ps.item_count,
      'credit_used', ps.credit_used,
      'notes', ps.notes
    ),
    'items', (
      select json_agg(
        json_build_object(
          'id', psi.id,
          'sku', pv.sku,
          'product_name', p.name,
          'color', pv.color,
          'size', pv.size,
          'qty', psi.qty,
          'price', psi.price_snapshot,
          'is_return', psi.is_return
        )
      )
      from public.public_sale_items psi
      join public.product_variants pv on pv.id = psi.variant_id
      join public.products p on p.id = pv.product_id
      where psi.sale_id = p_sale_id
    )
  ) into v_result
  from public.public_sales ps
  left join public.public_sales_customers psc on psc.id = ps.customer_id
  where ps.id = p_sale_id;

  return v_result;
end $$;

-- 17) RPC: Obtener historial de compras del cliente
create or replace function public.rpc_get_customer_sales_history(p_customer_id uuid)
returns json language plpgsql security definer as $$
declare
  v_result json;
begin
  -- Usar subconsulta ordenada, luego agregar
  with ordered_sales as (
    select 
      id,
      sale_number,
      created_at,
      total_amount,
      item_count,
      credit_used
    from public.public_sales
    where customer_id = p_customer_id
    order by created_at desc
  )
  select json_agg(
    json_build_object(
      'id', id,
      'sale_number', sale_number,
      'created_at', created_at,
      'total_amount', total_amount,
      'item_count', item_count,
      'credit_used', credit_used
    )
  ) into v_result
  from ordered_sales;

  return coalesce(v_result, '[]'::json);
end $$;

-- 18) RPC: Obtener datos públicos del cliente (por QR)
create or replace function public.rpc_get_customer_public_data(p_qr_code uuid)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_result json;
  v_customer_id uuid;
  v_customer_data jsonb;
  v_sales_history json;
  v_credits json;
begin
  -- Obtener ID del cliente (bypass RLS con security definer)
  select id into v_customer_id
  from public.public_sales_customers
  where qr_code = p_qr_code::uuid;

  if v_customer_id is null then
    raise exception 'Cliente no encontrado con el código QR proporcionado';
  end if;

  -- Obtener datos del cliente
  select json_build_object(
    'id', id,
    'customer_number', customer_number,
    'first_name', first_name,
    'last_name', last_name
  ) into v_customer_data
  from public.public_sales_customers
  where id = v_customer_id;

  -- Obtener historial de ventas
  select public.rpc_get_customer_sales_history(v_customer_id) into v_sales_history;

  -- Obtener créditos
  select public.rpc_get_customer_credits(v_customer_id) into v_credits;

  -- Construir respuesta
  select json_build_object(
    'customer', v_customer_data,
    'sales_history', coalesce(v_sales_history, '[]'::json),
    'credits', coalesce(v_credits, '[]'::json)
  ) into v_result;

  return v_result;
end $$;

-- 19) RPC: Limpiar créditos expirados
create or replace function public.rpc_cleanup_expired_credits()
returns int language plpgsql security definer as $$
declare
  v_deleted_count int;
begin
  delete from public.public_sales_customer_credits
  where expires_at <= now();

  get diagnostics v_deleted_count = row_count;
  return v_deleted_count;
end $$;

-- 20) RLS Policies
alter table public.public_sales_customers enable row level security;
alter table public.public_sales_customer_credits enable row level security;
alter table public.public_sales enable row level security;
alter table public.public_sale_items enable row level security;

-- Políticas para clientes (solo admins)
drop policy if exists public_sales_customers_admin_all on public.public_sales_customers;
create policy public_sales_customers_admin_all on public.public_sales_customers
  for all to authenticated
  using (exists (select 1 from public.admins where user_id = auth.uid()));

-- Políticas para créditos (solo admins)
drop policy if exists public_sales_customer_credits_admin_all on public.public_sales_customer_credits;
create policy public_sales_customer_credits_admin_all on public.public_sales_customer_credits
  for all to authenticated
  using (exists (select 1 from public.admins where user_id = auth.uid()));

-- Políticas para ventas (solo admins)
drop policy if exists public_sales_admin_all on public.public_sales;
create policy public_sales_admin_all on public.public_sales
  for all to authenticated
  using (exists (select 1 from public.admins where user_id = auth.uid()));

-- Políticas para items de venta (solo admins)
drop policy if exists public_sale_items_admin_all on public.public_sale_items;
create policy public_sale_items_admin_all on public.public_sale_items
  for all to authenticated
  using (exists (select 1 from public.admins where user_id = auth.uid()));

-- Política pública para acceso por QR code (sin autenticación requerida)
-- Esta política permite que la función RPC acceda a los datos del cliente por QR code
drop policy if exists public_sales_customers_public_qr_access on public.public_sales_customers;
create policy public_sales_customers_public_qr_access on public.public_sales_customers
  for select to anon, authenticated
  using (true); -- La función RPC con security definer manejará la seguridad

drop policy if exists public_sales_customer_credits_public_access on public.public_sales_customer_credits;
create policy public_sales_customer_credits_public_access on public.public_sales_customer_credits
  for select to anon, authenticated
  using (true); -- La función RPC con security definer manejará la seguridad

drop policy if exists public_sales_public_access on public.public_sales;
create policy public_sales_public_access on public.public_sales
  for select to anon, authenticated
  using (true); -- La función RPC con security definer manejará la seguridad

drop policy if exists public_sale_items_public_access on public.public_sale_items;
create policy public_sale_items_public_access on public.public_sale_items
  for select to anon, authenticated
  using (true); -- La función RPC con security definer manejará la seguridad

-- 21) Índices para mejor rendimiento
create index if not exists idx_public_sales_customers_qr_code on public.public_sales_customers(qr_code);
create index if not exists idx_public_sales_customers_customer_number on public.public_sales_customers(customer_number);
create index if not exists idx_public_sales_customer_credits_customer_id on public.public_sales_customer_credits(customer_id);
create index if not exists idx_public_sales_customer_credits_expires_at on public.public_sales_customer_credits(expires_at);
create index if not exists idx_public_sales_customer_id on public.public_sales(customer_id);
create index if not exists idx_public_sales_created_at on public.public_sales(created_at);
create index if not exists idx_public_sale_items_sale_id on public.public_sale_items(sale_id);

-- 22) Script de migración: Recalcular totales de ventas existentes
-- Este script corrige los totales de ventas que fueron creadas antes de la corrección
-- que resta las devoluciones del total
do $$
declare
  v_sale record;
  v_correct_total numeric;
begin
  -- Recalcular total de cada venta
  for v_sale in 
    select ps.id, ps.total_amount
    from public.public_sales ps
  loop
    -- Calcular el total correcto: sumar ventas, restar devoluciones
    select coalesce(sum(
      case 
        when psi.is_return then -(psi.price_snapshot * psi.qty)
        else (psi.price_snapshot * psi.qty)
      end
    ), 0) into v_correct_total
    from public.public_sale_items psi
    where psi.sale_id = v_sale.id;
    
    -- Actualizar el total si es diferente
    if v_correct_total != v_sale.total_amount then
      update public.public_sales
      set total_amount = v_correct_total
      where id = v_sale.id;
      
      raise notice 'Venta %: Total corregido de % a %', v_sale.id, v_sale.total_amount, v_correct_total;
    end if;
  end loop;
end $$;

-- ============================================
-- SISTEMA DE MÚLTIPLES CAJAS
-- ============================================

-- Tabla para almacenar compras pendientes enviadas desde caja 2 y 3
create table if not exists public.pending_sales (
  id uuid primary key default gen_random_uuid(),
  source_caja int not null check (source_caja in (2, 3)),
  sale_data jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'completed')),
  created_at timestamptz default now(),
  processed_at timestamptz,
  processed_by uuid references auth.users(id) on delete set null
);

-- Índices para mejorar rendimiento
create index if not exists idx_pending_sales_status on public.pending_sales(status);
create index if not exists idx_pending_sales_source_caja on public.pending_sales(source_caja);
create index if not exists idx_pending_sales_created_at on public.pending_sales(created_at);

-- RPC: Crear compra pendiente
create or replace function public.rpc_create_pending_sale(
  p_source_caja int,
  p_sale_data jsonb
)
returns uuid
language plpgsql
security definer
as $$
declare
  v_pending_id uuid;
begin
  -- Validar que source_caja sea 2 o 3
  if p_source_caja not in (2, 3) then
    raise exception 'source_caja debe ser 2 o 3';
  end if;

  -- Insertar compra pendiente
  insert into public.pending_sales (source_caja, sale_data, status)
  values (p_source_caja, p_sale_data, 'pending')
  returning id into v_pending_id;

  return v_pending_id;
end $$;

-- RPC: Obtener compras pendientes
create or replace function public.rpc_get_pending_sales()
returns table (
  id uuid,
  source_caja int,
  sale_data jsonb,
  status text,
  created_at timestamptz,
  processed_at timestamptz,
  processed_by uuid
)
language plpgsql
security definer
as $$
begin
  return query
  select 
    ps.id,
    ps.source_caja,
    ps.sale_data,
    ps.status,
    ps.created_at,
    ps.processed_at,
    ps.processed_by
  from public.pending_sales ps
  where ps.status = 'pending'
    -- Excluir pedidos locales (source_caja = 1 con local_order_id en sale_data)
    and not (ps.source_caja = 1 and ps.sale_data ? 'local_order_id')
  order by ps.created_at asc;
end $$;

-- RPC: Marcar compra pendiente como procesando
create or replace function public.rpc_mark_pending_sale_processing(
  p_pending_sale_id uuid
)
returns boolean
language plpgsql
security definer
as $$
declare
  v_current_status text;
begin
  -- Obtener estado actual
  select status into v_current_status
  from public.pending_sales
  where id = p_pending_sale_id;

  -- Verificar que existe y está pendiente
  if v_current_status is null then
    raise exception 'Compra pendiente no encontrada';
  end if;

  if v_current_status != 'pending' then
    raise exception 'La compra ya está siendo procesada o fue completada';
  end if;

  -- Actualizar estado
  update public.pending_sales
  set status = 'processing'
  where id = p_pending_sale_id;

  return true;
end $$;

-- RPC: Completar compra pendiente
create or replace function public.rpc_complete_pending_sale(
  p_pending_sale_id uuid,
  p_sale_id uuid
)
returns boolean
language plpgsql
security definer
as $$
declare
  v_current_status text;
  v_current_user uuid;
begin
  -- Obtener usuario actual
  v_current_user := auth.uid();

  -- Obtener estado actual
  select status into v_current_status
  from public.pending_sales
  where id = p_pending_sale_id;

  -- Verificar que existe
  if v_current_status is null then
    raise exception 'Compra pendiente no encontrada';
  end if;

  -- Actualizar estado a completada
  update public.pending_sales
  set 
    status = 'completed',
    processed_at = now(),
    processed_by = v_current_user,
    sale_data = jsonb_set(
      sale_data,
      '{final_sale_id}',
      to_jsonb(p_sale_id::text)
    )
  where id = p_pending_sale_id;

  return true;
end $$;

