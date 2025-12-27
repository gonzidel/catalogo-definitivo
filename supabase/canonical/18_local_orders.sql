-- 18_local_orders.sql — Sistema de pedidos locales para venta al público (idempotente)

-- 0) Modificar restricción de pending_sales para permitir source_caja = 1 (pedidos locales)
alter table public.pending_sales
  drop constraint if exists pending_sales_source_caja_check;

alter table public.pending_sales
  add constraint pending_sales_source_caja_check
  check (source_caja in (1, 2, 3));

-- 1) Tabla de pedidos locales
create table if not exists public.local_orders (
  id uuid primary key default gen_random_uuid(),
  order_number text unique,
  customer_id uuid not null references public.public_sales_customers(id) on delete cascade,
  source_order_id uuid references public.orders(id) on delete set null, -- Referencia al pedido original si viene de orders
  status text not null default 'pending' check (status in ('pending', 'ready', 'completed', 'cancelled')),
  total_amount numeric(12,2) not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 2) Tabla de items de pedidos locales
create table if not exists public.local_order_items (
  id uuid primary key default gen_random_uuid(),
  local_order_id uuid not null references public.local_orders(id) on delete cascade,
  variant_id uuid references public.product_variants(id),
  product_name text not null,
  color text,
  size text,
  quantity int not null check (quantity > 0),
  price_snapshot numeric,
  imagen text,
  status text not null default 'pending' check (status in ('pending', 'ready', 'cancelled')),
  created_at timestamptz not null default now()
);

-- 3) Triggers updated_at
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'local_orders_set_updated_at') then
    create trigger local_orders_set_updated_at
      before update on public.local_orders
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- 4) Función para generar número de pedido local
create or replace function public.generate_local_order_number()
returns text
language plpgsql
as $$
declare
  last_order_number text;
  current_number int;
  next_number int;
  formatted_number text;
begin
  -- Obtener el último número de pedido local
  select order_number
  into last_order_number
  from public.local_orders
  where order_number is not null
    and order_number ~ '^LOC[0-9]+$' -- Formato: LOC00001, LOC00002, etc.
  order by cast(substring(order_number from 'LOC([0-9]+)') as int) desc
  limit 1;

  if last_order_number is null then
    -- Si no hay pedidos, empezar con LOC00001
    formatted_number := 'LOC00001';
    return formatted_number;
  end if;

  -- Extraer número del último pedido
  current_number := cast(substring(last_order_number from 'LOC([0-9]+)') as int);
  next_number := current_number + 1;

  -- Formatear número con 5 dígitos (00001-99999)
  formatted_number := 'LOC' || lpad(next_number::text, 5, '0');

  return formatted_number;
end $$;

-- 5) RPC: Copiar cliente de customers a public_sales_customers
create or replace function public.rpc_copy_customer_to_local(p_customer_id uuid)
returns json
language plpgsql
security definer
as $$
declare
  v_customer_record record;
  v_local_customer_id uuid;
  v_customer_number text;
  v_qr_code uuid;
  v_result json;
begin
  -- Obtener datos del cliente original
  select 
    c.id,
    c.full_name,
    c.phone,
    c.email,
    c.dni,
    c.city,
    c.province
  into v_customer_record
  from public.customers c
  where c.id = p_customer_id;

  if v_customer_record is null then
    raise exception 'Cliente no encontrado';
  end if;

  -- Verificar si el cliente ya existe en public_sales_customers por DNI o email
  if v_customer_record.dni is not null then
    select id into v_local_customer_id
    from public.public_sales_customers
    where document_number = v_customer_record.dni
    limit 1;
  end if;

  if v_local_customer_id is null and v_customer_record.email is not null then
    select id into v_local_customer_id
    from public.public_sales_customers
    where email = v_customer_record.email
    limit 1;
  end if;

  -- Si ya existe, retornar su ID
  if v_local_customer_id is not null then
    select json_build_object(
      'success', true,
      'customer_id', v_local_customer_id,
      'already_exists', true
    ) into v_result;
    return v_result;
  end if;

  -- Separar nombre y apellido
  declare
    name_parts text[];
    first_name text;
    last_name text;
  begin
    name_parts := string_to_array(trim(v_customer_record.full_name), ' ');
    if array_length(name_parts, 1) > 1 then
      first_name := array_to_string(name_parts[1:array_length(name_parts, 1) - 1], ' ');
      last_name := name_parts[array_length(name_parts, 1)];
    else
      first_name := v_customer_record.full_name;
      last_name := null;
    end if;

    -- Generar número de cliente
    v_customer_number := public.generate_customer_number();
    
    -- Generar QR code
    v_qr_code := gen_random_uuid();

    -- Crear cliente en public_sales_customers
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
      first_name,
      last_name,
      v_customer_record.phone,
      v_customer_record.email,
      v_customer_record.dni,
      v_qr_code
    )
    returning id into v_local_customer_id;

    select json_build_object(
      'success', true,
      'customer_id', v_local_customer_id,
      'customer_number', v_customer_number,
      'qr_code', v_qr_code,
      'already_exists', false
    ) into v_result;
    return v_result;
  end;
end $$;

-- 6) RPC: Enviar pedido desde orders a local_orders
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
  v_customer_result json;
  v_result json;
begin
  -- Obtener datos del pedido
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

  -- Verificar que el pedido esté en estado "apartado" (todos los items picked)
  declare
    v_total_items int;
    v_picked_items int;
  begin
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
  end;

  -- Copiar cliente a public_sales_customers
  select public.rpc_copy_customer_to_local(v_order_record.customer_id) into v_customer_result;
  
  if (v_customer_result->>'success')::boolean = false then
    raise exception 'Error al copiar cliente: %', v_customer_result->>'error';
  end if;

  v_local_customer_id := (v_customer_result->>'customer_id')::uuid;

  -- Generar número de pedido local
  v_order_number := public.generate_local_order_number();

  -- Calcular total desde items
  select coalesce(sum((quantity * price_snapshot)), 0)
  into v_total_amount
  from public.order_items
  where order_id = p_order_id and status != 'cancelled';

  -- Crear pedido local
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

  -- Copiar items del pedido
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

  -- Marcar el pedido original como "sent" para que desaparezca de orders.html
  update public.orders
  set status = 'sent',
      sent_at = now(),
      updated_at = now()
  where id = p_order_id;

  select json_build_object(
    'success', true,
    'local_order_id', v_local_order_id,
    'order_number', v_order_number,
    'customer_id', v_local_customer_id
  ) into v_result;
  return v_result;
end $$;

-- 7) RPC: Obtener pedidos locales
-- Eliminar función existente si cambia el tipo de retorno
drop function if exists public.rpc_get_local_orders(text, uuid);

create or replace function public.rpc_get_local_orders(
  p_status text default null,
  p_source_order_id uuid default null
)
returns table (
  id uuid,
  order_number text,
  customer_id uuid,
  customer_number text,
  customer_name text,
  customer_phone text,
  customer_document_number text,
  source_order_id uuid,
  status text,
  total_amount numeric,
  notes text,
  created_at timestamptz,
  updated_at timestamptz,
  item_count bigint
)
language plpgsql
security definer
as $$
begin
  return query
  select 
    lo.id,
    lo.order_number,
    lo.customer_id,
    psc.customer_number,
    (psc.first_name || ' ' || coalesce(psc.last_name, ''))::text as customer_name,
    psc.phone as customer_phone,
    psc.document_number as customer_document_number,
    lo.source_order_id,
    lo.status,
    lo.total_amount,
    lo.notes,
    lo.created_at,
    lo.updated_at,
    count(loi.id) as item_count
  from public.local_orders lo
  inner join public.public_sales_customers psc on lo.customer_id = psc.id
  left join public.local_order_items loi on lo.id = loi.local_order_id
  where 
    (p_status is null or lo.status = p_status)
    and (p_source_order_id is null or lo.source_order_id = p_source_order_id)
    -- Excluir pedidos completados y cancelados
    and lo.status not in ('completed', 'cancelled')
  group by lo.id, lo.order_number, lo.customer_id, psc.customer_number, psc.first_name, psc.last_name, 
           psc.phone, psc.document_number, lo.source_order_id, lo.status, lo.total_amount, lo.notes, lo.created_at, lo.updated_at
  order by lo.created_at desc;
end $$;

-- 8) RPC: Obtener items de un pedido local
create or replace function public.rpc_get_local_order_items(p_local_order_id uuid)
returns table (
  id uuid,
  variant_id uuid,
  product_name text,
  color text,
  size text,
  quantity int,
  price_snapshot numeric,
  imagen text,
  status text
)
language plpgsql
security definer
as $$
begin
  return query
  select 
    loi.id,
    loi.variant_id,
    loi.product_name,
    loi.color,
    loi.size,
    loi.quantity,
    loi.price_snapshot,
    loi.imagen,
    loi.status
  from public.local_order_items loi
  where loi.local_order_id = p_local_order_id
  order by loi.created_at;
end $$;

-- 9) RPC: Crear pedido local nuevo
create or replace function public.rpc_create_local_order(
  p_customer_id uuid,
  p_items jsonb,
  p_extras jsonb default '{}'::jsonb
)
returns json
language plpgsql
security definer
as $$
declare
  v_local_order_id uuid;
  v_order_number text;
  v_total_amount numeric(12,2) := 0;
  v_item jsonb;
  v_item_total numeric;
  v_shipping numeric := 0;
  v_discount numeric := 0;
  v_extras_amount numeric := 0;
  v_extras_percentage numeric := 0;
  v_result json;
  v_variant_id uuid;
  v_quantity int;
  v_warehouse_id uuid;
  v_current_stock int;
  v_available_stock int;
  v_exists_record boolean;
  v_warehouse_venta_publico_id uuid;
  v_warehouse_general_id uuid;
  v_stock_venta_publico int;
  v_stock_general int;
  v_total_stock int;
begin
  -- Validar que el cliente existe
  if not exists (select 1 from public.public_sales_customers where id = p_customer_id) then
    raise exception 'Cliente no encontrado';
  end if;

  -- Obtener warehouse_id de venta-publico y general
  select id into v_warehouse_venta_publico_id
  from public.warehouses
  where code = 'venta-publico'
  limit 1;

  select id into v_warehouse_general_id
  from public.warehouses
  where code = 'general'
  limit 1;

  if v_warehouse_venta_publico_id is null then
    raise exception 'Warehouse venta-publico no encontrado';
  end if;
  
  if v_warehouse_general_id is null then
    raise exception 'Warehouse general no encontrado';
  end if;

  -- Validar stock y calcular total de items
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    -- Solo validar stock si tiene variant_id
    if (v_item->>'variant_id')::text is not null 
       and (v_item->>'variant_id')::text != 'null' 
       and (v_item->>'variant_id')::text != '' then
      
      v_variant_id := (v_item->>'variant_id')::uuid;
      v_quantity := (v_item->>'quantity')::int;

      -- Obtener stock en ambos warehouses (venta-publico y general)
      select coalesce(stock_qty, 0) into v_stock_venta_publico
      from public.variant_warehouse_stock
      where variant_id = v_variant_id
        and warehouse_id = v_warehouse_venta_publico_id
      for update;

      select coalesce(stock_qty, 0) into v_stock_general
      from public.variant_warehouse_stock
      where variant_id = v_variant_id
        and warehouse_id = v_warehouse_general_id
      for update;

      -- Calcular stock total disponible
      v_total_stock := coalesce(v_stock_venta_publico, 0) + coalesce(v_stock_general, 0);

      -- Validar stock disponible (verificar en ambos warehouses)
      if v_total_stock < v_quantity then
        raise exception 'Stock insuficiente para % (Cantidad: %, Disponible: % - venta-publico: %, general: %)', 
          v_item->>'product_name', v_quantity, v_total_stock, 
          coalesce(v_stock_venta_publico, 0), coalesce(v_stock_general, 0);
      end if;

    end if;

    v_item_total := (v_item->>'quantity')::int * (v_item->>'price_snapshot')::numeric;
    v_total_amount := v_total_amount + v_item_total;
  end loop;

  -- Aplicar extras
  if p_extras ? 'shipping' then
    v_shipping := (p_extras->>'shipping')::numeric;
    v_total_amount := v_total_amount + v_shipping;
  end if;

  if p_extras ? 'discount' then
    v_discount := (p_extras->>'discount')::numeric;
    v_total_amount := v_total_amount - v_discount;
  end if;

  if p_extras ? 'extras_amount' then
    v_extras_amount := (p_extras->>'extras_amount')::numeric;
    v_total_amount := v_total_amount + v_extras_amount;
  end if;

  if p_extras ? 'extras_percentage' then
    v_extras_percentage := (p_extras->>'extras_percentage')::numeric;
    v_total_amount := v_total_amount + (v_total_amount * v_extras_percentage / 100);
  end if;

  -- Asegurar que el total no sea negativo
  v_total_amount := greatest(v_total_amount, 0);

  -- Generar número de pedido
  v_order_number := public.generate_local_order_number();

  -- Crear pedido
  insert into public.local_orders (
    order_number,
    customer_id,
    status,
    total_amount,
    notes
  )
  values (
    v_order_number,
    p_customer_id,
    'pending',
    v_total_amount,
    jsonb_build_object(
      'shipping', v_shipping,
      'discount', v_discount,
      'extras_amount', v_extras_amount,
      'extras_percentage', v_extras_percentage
    )::text
  )
  returning id into v_local_order_id;

  -- Crear items y descontar stock
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    -- Descontar stock si tiene variant_id
    if (v_item->>'variant_id')::text is not null 
       and (v_item->>'variant_id')::text != 'null' 
       and (v_item->>'variant_id')::text != '' then
      
      v_variant_id := (v_item->>'variant_id')::uuid;
      v_quantity := (v_item->>'quantity')::int;

      -- Obtener stock en ambos warehouses para determinar de dónde descontar
      declare
        v_stock_vp int;
        v_stock_gen int;
        v_target_warehouse_id uuid;
      begin
        select coalesce(stock_qty, 0) into v_stock_vp
        from public.variant_warehouse_stock
        where variant_id = v_variant_id
          and warehouse_id = v_warehouse_venta_publico_id
        for update;

        select coalesce(stock_qty, 0) into v_stock_gen
        from public.variant_warehouse_stock
        where variant_id = v_variant_id
          and warehouse_id = v_warehouse_general_id
        for update;

        -- Determinar de dónde descontar (priorizar venta-publico)
        declare
          v_final_stock int;
        begin
          if v_stock_vp >= v_quantity then
            v_target_warehouse_id := v_warehouse_venta_publico_id;
            v_final_stock := v_stock_vp - v_quantity;
          else
            v_target_warehouse_id := v_warehouse_general_id;
            v_final_stock := v_stock_gen - v_quantity;
          end if;

          -- Descontar stock del warehouse determinado
          -- Usar INSERT ... ON CONFLICT para manejar casos donde no existe el registro
          insert into public.variant_warehouse_stock (variant_id, warehouse_id, stock_qty, updated_at)
          values (v_variant_id, v_target_warehouse_id, v_final_stock, now())
          on conflict (variant_id, warehouse_id) 
          do update set
            stock_qty = variant_warehouse_stock.stock_qty - v_quantity,
            updated_at = now();
        end;
      end;
    end if;

    -- Crear item del pedido
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
    values (
      v_local_order_id,
      case when (v_item->>'variant_id')::text = 'null' or (v_item->>'variant_id')::text is null 
           then null 
           else (v_item->>'variant_id')::uuid 
      end,
      v_item->>'product_name',
      v_item->>'color',
      v_item->>'size',
      (v_item->>'quantity')::int,
      (v_item->>'price_snapshot')::numeric,
      v_item->>'imagen',
      'pending'
    );
  end loop;

  select json_build_object(
    'success', true,
    'local_order_id', v_local_order_id,
    'order_number', v_order_number,
    'total_amount', v_total_amount
  ) into v_result;
  return v_result;
end $$;

-- 10) RPC: Cargar pedido local en caja 1 como compra pendiente
create or replace function public.rpc_load_local_order_to_sale(p_local_order_id uuid)
returns json
language plpgsql
security definer
as $$
declare
  v_order_record record;
  v_items jsonb;
  v_sale_data jsonb;
  v_pending_sale_id uuid;
  v_result json;
begin
  -- Obtener pedido y items
  select 
    lo.*,
    psc.first_name,
    psc.last_name,
    psc.phone,
    psc.email,
    psc.document_number
  into v_order_record
  from public.local_orders lo
  inner join public.public_sales_customers psc on lo.customer_id = psc.id
  where lo.id = p_local_order_id;

  if v_order_record is null then
    raise exception 'Pedido local no encontrado';
  end if;

  -- Obtener items como JSON (incluyendo el ID del item para poder liberar stock si se elimina)
  select jsonb_agg(
    jsonb_build_object(
      'id', loi.id,
      'product_name', loi.product_name,
      'color', loi.color,
      'size', loi.size,
      'quantity', loi.quantity,
      'price_snapshot', loi.price_snapshot,
      'variant_id', loi.variant_id,
      'imagen', loi.imagen
    )
  )
  into v_items
  from public.local_order_items loi
  where loi.local_order_id = p_local_order_id;

  -- Construir sale_data similar a pending_sales
  v_sale_data := jsonb_build_object(
    'customer', jsonb_build_object(
      'id', v_order_record.customer_id,
      'first_name', v_order_record.first_name,
      'last_name', v_order_record.last_name,
      'phone', v_order_record.phone,
      'email', v_order_record.email,
      'document_number', v_order_record.document_number
    ),
    'items', coalesce(v_items, '[]'::jsonb),
    'total_amount', v_order_record.total_amount,
    'notes', v_order_record.notes,
    'local_order_id', p_local_order_id
  );

  -- Crear compra pendiente con source_caja = 1 (caja 1, pero viene de pedido local)
  -- El flag 'local_order_id' en sale_data indica que viene de un pedido local
  insert into public.pending_sales (
    source_caja,
    sale_data,
    status
  )
  values (
    1,
    v_sale_data,
    'pending'
  )
  returning id into v_pending_sale_id;

  -- Actualizar estado del pedido local a 'ready'
  update public.local_orders
  set status = 'ready', updated_at = now()
  where id = p_local_order_id;

  select json_build_object(
    'success', true,
    'sale_data', v_sale_data,
    'pending_sale_id', v_pending_sale_id
  ) into v_result;
  return v_result;
end $$;

-- 11) Índices para mejorar rendimiento
create index if not exists idx_local_orders_customer_id on public.local_orders(customer_id);
create index if not exists idx_local_orders_source_order_id on public.local_orders(source_order_id);
create index if not exists idx_local_orders_status on public.local_orders(status);
create index if not exists idx_local_order_items_local_order_id on public.local_order_items(local_order_id);

-- 12) RLS (Row Level Security)
alter table public.local_orders enable row level security;
alter table public.local_order_items enable row level security;

-- Políticas para admins
drop policy if exists local_orders_admin_all on public.local_orders;
create policy local_orders_admin_all on public.local_orders
  for all
  to authenticated
  using (
    exists (
      select 1 from public.admins
      where user_id = auth.uid()
    )
  );

drop policy if exists local_order_items_admin_all on public.local_order_items;
create policy local_order_items_admin_all on public.local_order_items
  for all
  to authenticated
  using (
    exists (
      select 1 from public.admins
      where user_id = auth.uid()
    )
  );

-- Recargar esquema
select pg_notify('pgrst','reload schema');

