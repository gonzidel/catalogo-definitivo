-- 13_warehouses.sql — Sistema de almacenes múltiples (idempotente)

-- 1) Tabla de almacenes
create table if not exists public.warehouses (
  id uuid primary key default gen_random_uuid(),
  code text unique not null, -- 'general', 'venta-publico'
  name text not null,
  description text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Insertar almacenes base si no existen
insert into public.warehouses (code, name, description)
values 
  ('general', 'Almacén General', 'Almacén principal donde se encuentra todo el stock actual'),
  ('venta-publico', 'Venta al Público', 'Almacén para productos destinados a venta al público')
on conflict (code) do nothing;

-- 2) Tabla de stock por variante y almacén
create table if not exists public.variant_warehouse_stock (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references public.product_variants(id) on delete cascade,
  warehouse_id uuid not null references public.warehouses(id) on delete cascade,
  stock_qty int not null default 0 check (stock_qty >= 0),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(variant_id, warehouse_id)
);

-- 3) Tabla de historial de movimientos
create table if not exists public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references public.product_variants(id) on delete cascade,
  from_warehouse_id uuid references public.warehouses(id) on delete set null,
  to_warehouse_id uuid references public.warehouses(id) on delete set null,
  quantity int not null check (quantity > 0),
  moved_by uuid references auth.users(id) on delete set null,
  notes text,
  created_at timestamptz default now()
);

-- Asegurar que las columnas existan (para tablas ya creadas)
do $$
begin
  -- Agregar variant_id si no existe
  if not exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' 
    and table_name = 'stock_movements' 
    and column_name = 'variant_id'
  ) then
    alter table public.stock_movements 
    add column variant_id uuid not null references public.product_variants(id) on delete cascade;
  end if;
  
  -- Agregar from_warehouse_id si no existe
  if not exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' 
    and table_name = 'stock_movements' 
    and column_name = 'from_warehouse_id'
  ) then
    alter table public.stock_movements 
    add column from_warehouse_id uuid references public.warehouses(id) on delete set null;
  end if;
  
  -- Agregar to_warehouse_id si no existe
  if not exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' 
    and table_name = 'stock_movements' 
    and column_name = 'to_warehouse_id'
  ) then
    alter table public.stock_movements 
    add column to_warehouse_id uuid references public.warehouses(id) on delete set null;
  end if;
  
  -- Agregar qty si no existe (verificar ambos nombres por compatibilidad)
  if not exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' 
    and table_name = 'stock_movements' 
    and column_name = 'qty'
  ) and not exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' 
    and table_name = 'stock_movements' 
    and column_name = 'quantity'
  ) then
    alter table public.stock_movements 
    add column qty int not null default 1 check (qty > 0);
  -- Si existe quantity pero no qty, renombrar quantity a qty
  elsif exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' 
    and table_name = 'stock_movements' 
    and column_name = 'quantity'
  ) and not exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' 
    and table_name = 'stock_movements' 
    and column_name = 'qty'
  ) then
    alter table public.stock_movements 
    rename column quantity to qty;
  end if;
  
  -- Agregar moved_by si no existe
  if not exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' 
    and table_name = 'stock_movements' 
    and column_name = 'moved_by'
  ) then
    alter table public.stock_movements 
    add column moved_by uuid references auth.users(id) on delete set null;
  end if;
  
  -- Agregar notes si no existe
  if not exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' 
    and table_name = 'stock_movements' 
    and column_name = 'notes'
  ) then
    alter table public.stock_movements 
    add column notes text;
  end if;
  
  -- Agregar created_at si no existe
  if not exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' 
    and table_name = 'stock_movements' 
    and column_name = 'created_at'
  ) then
    alter table public.stock_movements 
    add column created_at timestamptz default now();
  end if;
end $$;

-- 4) Triggers updated_at
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'warehouses_set_updated_at') then
    create trigger warehouses_set_updated_at
      before update on public.warehouses
      for each row execute function public.set_updated_at();
  end if;
  
  if not exists (select 1 from pg_trigger where tgname = 'variant_warehouse_stock_set_updated_at') then
    create trigger variant_warehouse_stock_set_updated_at
      before update on public.variant_warehouse_stock
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- 5) Índices
create index if not exists ix_variant_warehouse_stock_variant on public.variant_warehouse_stock(variant_id);
create index if not exists ix_variant_warehouse_stock_warehouse on public.variant_warehouse_stock(warehouse_id);
create index if not exists ix_stock_movements_variant on public.stock_movements(variant_id);
create index if not exists ix_stock_movements_created_at on public.stock_movements(created_at desc);

-- 6) Migración de stock existente a almacén general
do $$
declare
  general_warehouse_id uuid;
  variant_record record;
  migrated_count int := 0;
begin
  -- Obtener ID del almacén general
  select id into general_warehouse_id from public.warehouses where code = 'general';
  
  if general_warehouse_id is null then
    raise exception 'Almacén general no encontrado';
  end if;
  
  -- Migrar stock de product_variants a variant_warehouse_stock
  for variant_record in 
    select id, stock_qty 
    from public.product_variants 
    where stock_qty > 0
      and not exists (
        select 1 from public.variant_warehouse_stock 
        where variant_id = product_variants.id 
          and warehouse_id = general_warehouse_id
      )
  loop
    insert into public.variant_warehouse_stock (variant_id, warehouse_id, stock_qty)
    values (variant_record.id, general_warehouse_id, variant_record.stock_qty)
    on conflict (variant_id, warehouse_id) do nothing;
    
    migrated_count := migrated_count + 1;
  end loop;
  
  raise notice 'Migrados % variantes al almacén general', migrated_count;
end $$;

-- 7) Función para obtener stock total por variante
create or replace function public.get_total_stock(p_variant_id uuid)
returns int
language plpgsql
stable
as $$
declare
  total int;
begin
  select coalesce(sum(stock_qty), 0) into total
  from public.variant_warehouse_stock
  where variant_id = p_variant_id;
  
  return total;
end $$;

-- 8) Función para obtener stock por almacén
create or replace function public.get_variant_stock_by_warehouse(p_variant_id uuid)
returns table (
  warehouse_code text,
  warehouse_name text,
  stock_qty int
)
language plpgsql
stable
as $$
begin
  return query
  select 
    w.code,
    w.name,
    coalesce(vws.stock_qty, 0)::int
  from public.warehouses w
  left join public.variant_warehouse_stock vws 
    on vws.warehouse_id = w.id 
    and vws.variant_id = p_variant_id
  order by w.code;
end $$;

-- 9) Función RPC para mover stock entre almacenes
create or replace function public.rpc_move_stock(
  p_variant_id uuid,
  p_from_warehouse_code text,
  p_to_warehouse_code text,
  p_quantity int,
  p_notes text default null
)
returns json
language plpgsql
security definer
as $$
declare
  v_from_warehouse_id uuid;
  v_to_warehouse_id uuid;
  v_available_stock int;
  v_user_id uuid;
  v_movement_id uuid;
  v_result json;
begin
  -- Validar cantidad
  if p_quantity <= 0 then
    raise exception 'La cantidad debe ser mayor a 0';
  end if;
  
  -- Obtener usuario actual
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;
  
  -- Obtener IDs de almacenes
  select id into v_from_warehouse_id 
  from public.warehouses 
  where code = p_from_warehouse_code;
  
  if v_from_warehouse_id is null then
    raise exception 'Almacén origen no encontrado: %', p_from_warehouse_code;
  end if;
  
  select id into v_to_warehouse_id 
  from public.warehouses 
  where code = p_to_warehouse_code;
  
  if v_to_warehouse_id is null then
    raise exception 'Almacén destino no encontrado: %', p_to_warehouse_code;
  end if;
  
  if v_from_warehouse_id = v_to_warehouse_id then
    raise exception 'El almacén origen y destino no pueden ser el mismo';
  end if;
  
  -- Verificar stock disponible en origen
  select coalesce(stock_qty, 0) into v_available_stock
  from public.variant_warehouse_stock
  where variant_id = p_variant_id
    and warehouse_id = v_from_warehouse_id;
  
  if v_available_stock < p_quantity then
    raise exception 'Stock insuficiente en almacén origen. Disponible: %, Solicitado: %', 
      v_available_stock, p_quantity;
  end if;
  
  -- Bloquear filas para actualización
  perform 1 
  from public.variant_warehouse_stock
  where variant_id = p_variant_id
    and warehouse_id in (v_from_warehouse_id, v_to_warehouse_id)
  for update;
  
  -- Descontar del almacén origen (solo si existe el registro)
  update public.variant_warehouse_stock
     set stock_qty = stock_qty - p_quantity,
         updated_at = now()
   where variant_id = p_variant_id
     and warehouse_id = v_from_warehouse_id;
  
  -- Si no existía el registro, crearlo con 0 (no debería pasar si validamos correctamente)
  insert into public.variant_warehouse_stock (variant_id, warehouse_id, stock_qty)
  select p_variant_id, v_from_warehouse_id, 0
  where not exists (
    select 1 from public.variant_warehouse_stock
    where variant_id = p_variant_id
      and warehouse_id = v_from_warehouse_id
  );
  
  -- Agregar al almacén destino
  insert into public.variant_warehouse_stock (variant_id, warehouse_id, stock_qty)
  values (p_variant_id, v_to_warehouse_id, p_quantity)
  on conflict (variant_id, warehouse_id) 
  do update set 
    stock_qty = variant_warehouse_stock.stock_qty + p_quantity,
    updated_at = now();
  
  -- Registrar movimiento en historial
  -- Usar qty si existe, sino quantity
  insert into public.stock_movements (
    variant_id, 
    from_warehouse_id, 
    to_warehouse_id, 
    qty, 
    moved_by, 
    notes
  )
  values (
    p_variant_id,
    v_from_warehouse_id,
    v_to_warehouse_id,
    p_quantity,
    v_user_id,
    p_notes
  )
  returning id into v_movement_id;
  
  -- Retornar resultado
  select json_build_object(
    'success', true,
    'movement_id', v_movement_id,
    'from_warehouse', p_from_warehouse_code,
    'to_warehouse', p_to_warehouse_code,
    'quantity', p_quantity,
    'from_stock_after', v_available_stock - p_quantity,
    'to_stock_after', (
      select coalesce(stock_qty, 0)
      from public.variant_warehouse_stock
      where variant_id = p_variant_id
        and warehouse_id = v_to_warehouse_id
    )
  ) into v_result;
  
  return v_result;
end $$;

-- 10) RLS Policies
alter table public.warehouses enable row level security;
alter table public.variant_warehouse_stock enable row level security;
alter table public.stock_movements enable row level security;

-- Warehouses: lectura pública
do $$
begin
  if not exists (
    select 1 from pg_policies 
    where schemaname='public' and tablename='warehouses' and policyname='anon_select_warehouses'
  ) then
    create policy anon_select_warehouses on public.warehouses
      for select to anon using (true);
  end if;
  
  if not exists (
    select 1 from pg_policies 
    where schemaname='public' and tablename='warehouses' and policyname='auth_select_warehouses'
  ) then
    create policy auth_select_warehouses on public.warehouses
      for select to authenticated using (true);
  end if;
end $$;

-- Variant warehouse stock: lectura pública, escritura solo admin
do $$
begin
  if not exists (
    select 1 from pg_policies 
    where schemaname='public' and tablename='variant_warehouse_stock' and policyname='anon_select_variant_warehouse_stock'
  ) then
    create policy anon_select_variant_warehouse_stock on public.variant_warehouse_stock
      for select to anon using (true);
  end if;
  
  if not exists (
    select 1 from pg_policies 
    where schemaname='public' and tablename='variant_warehouse_stock' and policyname='auth_select_variant_warehouse_stock'
  ) then
    create policy auth_select_variant_warehouse_stock on public.variant_warehouse_stock
      for select to authenticated using (true);
  end if;
  
  -- Escritura solo para admins (verificar en tabla admins)
  if not exists (
    select 1 from pg_policies 
    where schemaname='public' and tablename='variant_warehouse_stock' and policyname='admin_manage_variant_warehouse_stock'
  ) then
    create policy admin_manage_variant_warehouse_stock on public.variant_warehouse_stock
      for all to authenticated
      using (
        exists (
          select 1 from public.admins 
          where user_id = auth.uid()
        )
      )
      with check (
        exists (
          select 1 from public.admins 
          where user_id = auth.uid()
        )
      );
  end if;
end $$;

-- Stock movements: solo lectura para admin, escritura solo admin
do $$
begin
  if not exists (
    select 1 from pg_policies 
    where schemaname='public' and tablename='stock_movements' and policyname='admin_select_stock_movements'
  ) then
    create policy admin_select_stock_movements on public.stock_movements
      for select to authenticated
      using (
        exists (
          select 1 from public.admins 
          where user_id = auth.uid()
        )
      );
  end if;
  
  if not exists (
    select 1 from pg_policies 
    where schemaname='public' and tablename='stock_movements' and policyname='admin_insert_stock_movements'
  ) then
    create policy admin_insert_stock_movements on public.stock_movements
      for insert to authenticated
      with check (
        exists (
          select 1 from public.admins 
          where user_id = auth.uid()
        )
      );
  end if;
end $$;

-- 11) Actualizar función rpc_reserve_item para usar stock total de almacenes
create or replace function public.rpc_reserve_item(variant uuid, qty int)
returns uuid 
language plpgsql 
security definer 
as $$
declare 
  cid uuid; 
  v_available int; 
  item_id uuid; 
  v_price numeric;
  v_total_stock int;
begin
  if qty <= 0 then 
    raise exception 'qty must be > 0'; 
  end if;
  
  select rpc_get_or_create_cart() into cid;
  
  -- Obtener stock total de todos los almacenes
  select public.get_total_stock(variant) into v_total_stock;
  
  -- Obtener reserved_qty de product_variants
  select coalesce(reserved_qty, 0) into v_available 
  from public.product_variants 
  where id = variant 
  for update;
  
  -- Calcular disponible: stock total - reservado
  v_available := v_total_stock - v_available;
  
  if v_available < qty then 
    raise exception 'No hay disponibilidad suficiente. Disponible: %, Solicitado: %', v_available, qty; 
  end if;
  
  select price into v_price from public.product_variants where id = variant;
  
  -- Actualizar reserved_qty
  update public.product_variants 
  set reserved_qty = reserved_qty + qty 
  where id = variant;
  
  insert into public.cart_items(id, cart_id, variant_id, qty, status, price_snapshot)
    values (gen_random_uuid(), cid, variant, qty, 'reserved', v_price)
    returning id into item_id;
    
  return item_id;
end $$;

-- 12) Actualizar función rpc_checkout_cart para usar stock total de almacenes
create or replace function public.rpc_checkout_cart()
returns json 
language plpgsql 
security definer 
as $$
declare
  v_cart_id uuid;
  v_order_id uuid;
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

  -- Buscar pedido activo del cliente
  select id
    into v_order_id
    from public.orders
   where customer_id = auth.uid()
     and status = 'active'
   order by created_at desc
   limit 1;

  -- Si no existe un pedido activo, crear uno nuevo
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

    -- Obtener stock total de todos los almacenes
    select public.get_total_stock(r.variant_id) into v_total_stock;
    
    -- Obtener reserved_qty
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

    -- Obtener IDs de almacenes (solo la primera vez)
    if v_general_id is null then
      select id into v_general_id from public.warehouses where code = 'general';
      select id into v_venta_id from public.warehouses where code = 'venta-publico';
    end if;
    
    -- Obtener stock del almacén general
    select coalesce(stock_qty, 0) into v_general_stock
    from public.variant_warehouse_stock
    where variant_id = r.variant_id
      and warehouse_id = v_general_id;
    
    -- Descontar del almacén general primero
    if v_general_stock > 0 then
      if v_general_stock >= v_qty then
        -- Todo desde general
        update public.variant_warehouse_stock
           set stock_qty = stock_qty - v_qty,
               updated_at = now()
         where variant_id = r.variant_id
           and warehouse_id = v_general_id;
        v_remaining_qty := 0;
      else
        -- Parcial desde general
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
    
    -- Si aún falta, descontar del almacén de venta al público
    if v_remaining_qty > 0 then
      update public.variant_warehouse_stock
         set stock_qty = stock_qty - v_remaining_qty,
             updated_at = now()
       where variant_id = r.variant_id
         and warehouse_id = v_venta_id;
    end if;

    -- Actualizar reserved_qty
    update public.product_variants
       set reserved_qty = greatest(reserved_qty - v_qty, 0)
     where id = r.variant_id;

    insert into public.order_items (
      order_id,
      variant_id,
      product_name,
      color,
      size,
      quantity,
      price_snapshot,
      imagen
    ) values (
      v_order_id,
      r.variant_id,
      r.product_name,
      r.color,
      r.size,
      v_qty,
      r.price_snapshot,
      r.imagen
    );

    v_total := v_total + (coalesce(r.price_snapshot, 0) * v_qty);
  end loop;

  delete from public.cart_items where cart_id = v_cart_id;

  update public.orders
     set total_amount = coalesce(total_amount, 0) + coalesce(v_total, 0)
   where id = v_order_id;

  return json_build_object('order_id', v_order_id);
end $$;

-- Notificar recarga de esquema
select pg_notify('pgrst','reload schema');

