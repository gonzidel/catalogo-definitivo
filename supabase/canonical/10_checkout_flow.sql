-- 10_checkout_flow.sql - Tablas de pedidos y checkout de carrito

-- Tabla de pedidos
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text unique, -- Número único de pedido (A00001, A00002, etc.)
  customer_id uuid not null references public.customers(id) on delete cascade,
  status text not null default 'active',
  total_amount numeric(12,2) not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Tabla de ítems del pedido
create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  variant_id uuid references public.product_variants(id),
  product_name text,
  color text,
  size text,
  quantity int not null check (quantity > 0),
  price_snapshot numeric,
  imagen text,
  status text not null default 'reserved',
  checked_by uuid,
  checked_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.order_items
  add column if not exists status text default 'reserved',
  add column if not exists checked_by uuid,
  add column if not exists checked_at timestamptz;

update public.order_items
   set status = coalesce(status, 'reserved')
 where status is null;

-- Agregar columna order_number si no existe (para tablas existentes)
do $$ 
begin
  if not exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' 
    and table_name = 'orders' 
    and column_name = 'order_number'
  ) then
    alter table public.orders add column order_number text;
    -- Crear índice único para order_number
    create unique index if not exists orders_order_number_unique 
    on public.orders(order_number) 
    where order_number is not null;
  end if;
end $$;

-- Configuración de privacidad para números de pedido
-- Estas constantes ocultan el volumen real de pedidos
-- BASE_NUMBER: número inicial (ej: 50000 = empezar en A50000 en lugar de A00001)
-- INCREMENT: incremento entre pedidos (ej: 10 = A50000, A50010, A50020)
-- Esto hace que parezca que ya hay muchos pedidos sin revelar el volumen real

-- Función para obtener la configuración de privacidad
create or replace function public.get_order_number_config()
returns table (base_number int, increment_step int)
language plpgsql
as $$
begin
  -- Configuración de privacidad para números de pedido
  -- base_number: número inicial (50000 = empezar en A50000, parece que hay 50,000 pedidos previos)
  -- increment_step: incremento entre pedidos (1 = secuencial normal, 10 = saltos de 10, etc.)
  -- 
  -- Para cambiar estos valores, edita las siguientes líneas:
  -- - base_number más alto = más privacidad (ej: 75000, 90000)
  -- - increment_step más alto = más privacidad pero menos secuencial (ej: 10, 100)
  -- 
  -- Configuración recomendada: 50000 base, 1 incremento (balance entre privacidad y usabilidad)
  return query select 50000 as base_number, 1 as increment_step;
end;
$$;

-- Función para generar el siguiente número de pedido
-- Formato: A50000, A50001, ..., A99999, B00000, B00001, etc.
-- Con configuración de privacidad para ocultar el volumen real
create or replace function public.generate_order_number()
returns text
language plpgsql
as $$
declare
  last_order_number text;
  current_letter char(1);
  current_number int;
  next_letter char(1);
  next_number int;
  formatted_number text;
  config_base int;
  config_increment int;
begin
  -- Obtener configuración de privacidad
  select base_number, increment_step
  into config_base, config_increment
  from public.get_order_number_config();
  
  -- Obtener el último número de pedido
  select order_number
  into last_order_number
  from (
    select order_number
    from public.orders
    where order_number is not null
      and order_number ~ '^[A-Z][0-9]{5}$' -- Formato: Letra + 5 dígitos
    order by 
      ascii(substring(order_number, 1, 1)) desc, -- Ordenar por letra descendente (Z -> A)
      cast(substring(order_number, 2) as int) desc -- Luego por número descendente (99999 -> 00000)
    limit 1
  ) as last_order;
  
  if last_order_number is null then
    -- Si no hay pedidos, empezar con el número base configurado
    formatted_number := 'A' || lpad(config_base::text, 5, '0');
    return formatted_number;
  end if;
  
  -- Extraer letra y número del último pedido
  current_letter := substring(last_order_number, 1, 1);
  current_number := cast(substring(last_order_number, 2) as int);
  
  -- Incrementar número según el incremento configurado
  next_number := current_number + config_increment;
  
  -- Si llegamos a 99999, avanzar a la siguiente letra
  if next_number > 99999 then
    -- Cambiar a la siguiente letra (A -> B, B -> C, etc.)
    if current_letter = 'Z' then
      -- Si llegamos a Z99999, lanzar error
      raise exception 'Se alcanzó el límite de pedidos (Z99999). Contacte al administrador.';
    else
      next_letter := chr(ascii(current_letter) + 1);
      -- En la nueva letra, empezar desde el número base
      next_number := config_base;
    end if;
  else
    next_letter := current_letter;
  end if;
  
  -- Formatear número con 5 dígitos (00000-99999)
  formatted_number := next_letter || lpad(next_number::text, 5, '0');
  
  return formatted_number;
end;
$$;

-- Función para asignar número de pedido automáticamente
create or replace function public.assign_order_number()
returns trigger
language plpgsql
as $$
begin
  -- Solo asignar número si no existe
  if new.order_number is null or new.order_number = '' then
    new.order_number := public.generate_order_number();
  end if;
  
  return new;
end;
$$;

-- Trigger para asignar número de pedido antes de insertar
do $$ 
begin
  if not exists (
    select 1 from pg_trigger 
    where tgname = 'assign_order_number_trigger'
  ) then
    create trigger assign_order_number_trigger
    before insert on public.orders
    for each row
    execute function public.assign_order_number();
  end if;
end $$;

-- Triggers updated_at
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'orders_set_updated_at') then
    create trigger orders_set_updated_at
      before update on public.orders
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- RLS y policies
alter table public.orders enable row level security;
alter table public.order_items enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'orders'
      and policyname = 'orders_self_select'
  ) then
    create policy orders_self_select
      on public.orders for select to authenticated
      using (customer_id = auth.uid());
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'orders'
      and policyname = 'orders_admin_manage'
  ) then
    create policy orders_admin_manage
      on public.orders for all to authenticated
      using (exists (select 1 from public.admins a where a.user_id = auth.uid()))
      with check (exists (select 1 from public.admins a where a.user_id = auth.uid()));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'order_items'
      and policyname = 'order_items_self_select'
  ) then
    create policy order_items_self_select
      on public.order_items for select to authenticated
      using (
        exists (
          select 1
            from public.orders o
           where o.id = order_id
             and o.customer_id = auth.uid()
        )
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'order_items'
      and policyname = 'order_items_admin_manage'
  ) then
    create policy order_items_admin_manage
      on public.order_items for all to authenticated
      using (exists (select 1 from public.admins a where a.user_id = auth.uid()))
      with check (exists (select 1 from public.admins a where a.user_id = auth.uid()));
  end if;
end $$;

-- Función auxiliar para verificar si un pedido tiene todos los items apartados
create or replace function public.has_all_items_picked(p_order_id uuid)
returns boolean
language plpgsql
as $$
declare
  v_total_items int;
  v_picked_items int;
begin
  -- Contar total de items
  select count(*) into v_total_items
  from public.order_items
  where order_id = p_order_id;

  -- Si no hay items, retornar false
  if v_total_items = 0 then
    return false;
  end if;

  -- Contar items apartados (picked) o en espera (waiting)
  -- waiting se trata como picked para verificación de completitud
  select count(*) into v_picked_items
  from public.order_items
  where order_id = p_order_id
    and status in ('picked', 'waiting');

  -- Retornar true si todos los items están apartados o en espera
  return v_picked_items = v_total_items;
end;
$$;

-- Checkout de carrito: crea pedido, descuenta stock y limpia carrito
-- Permite agregar items a pedidos existentes (incluso si tienen items apartados)
drop function if exists public.rpc_checkout_cart();
create or replace function public.rpc_checkout_cart()
returns json language plpgsql security definer as $$
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

  -- Buscar pedido activo del cliente (incluso si tiene items apartados)
  -- Esto permite agregar nuevos items a pedidos que ya están parcialmente apartados
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

    select stock_qty, reserved_qty
      into v_stock, v_reserved
      from public.product_variants
     where id = r.variant_id
     for update;

    if v_stock is null then
      raise exception 'Variante no encontrada para el item %.', r.id;
    end if;

    v_available := coalesce(v_stock, 0) - coalesce(v_reserved, 0);
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

    update public.product_variants
       set stock_qty = stock_qty - v_qty,
           reserved_qty = greatest(reserved_qty - v_qty, 0)
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
end;
$$;

-- Función para actualizar el estado de un item del pedido
-- Cuando se marca un item como "picked", verifica si todos los items están apartados
drop function if exists public.rpc_update_order_item_status(uuid, text, uuid);
create or replace function public.rpc_update_order_item_status(
  p_item_id uuid,
  p_status text,
  p_checked_by uuid
)
returns json
language plpgsql
security definer
as $$
declare
  v_order_id uuid;
  v_all_picked boolean;
begin
  -- Verificar que el usuario es admin
  if not exists (
    select 1 from public.admins
    where user_id = auth.uid()
  ) then
    raise exception 'Solo administradores pueden actualizar el estado de items';
  end if;

  -- Obtener el order_id del item
  select order_id into v_order_id
  from public.order_items
  where id = p_item_id;

  if v_order_id is null then
    raise exception 'Item no encontrado';
  end if;

  -- Validar el status
  if p_status not in ('reserved', 'picked', 'missing', 'waiting') then
    raise exception 'Status inválido: %', p_status;
  end if;

  -- Actualizar el estado del item
  update public.order_items
     set status = p_status,
         checked_by = case when p_status = 'reserved' then null else p_checked_by end,
         checked_at = case when p_status = 'reserved' then null else now() end
   where id = p_item_id;

  if not found then
    raise exception 'No se pudo actualizar el item';
  end if;

  -- Verificar si todos los items están apartados
  select public.has_all_items_picked(v_order_id) into v_all_picked;

  -- Retornar información sobre el pedido
  return json_build_object(
    'order_id', v_order_id,
    'all_items_picked', v_all_picked
  );
end;
$$;

drop function if exists public.rpc_close_order(uuid, text);
drop function if exists public.rpc_close_order(uuid);
create or replace function public.rpc_close_order(p_order_id uuid, p_payment_method text default null)
returns void language plpgsql security definer as $$
declare
  v_customer_id uuid;
  v_is_admin boolean;
begin
  -- Verificar si el usuario es admin
  select exists (
    select 1 from public.admins
    where user_id = auth.uid()
  ) into v_is_admin;

  -- Obtener el customer_id del pedido
  select customer_id into v_customer_id
  from public.orders
  where id = p_order_id;

  if v_customer_id is null then
    raise exception 'Pedido no encontrado';
  end if;

  -- Verificar permisos:
  -- 1. Si es admin, puede cerrar cualquier pedido
  -- 2. Si es cliente, solo puede cerrar sus propios pedidos
  if not v_is_admin and v_customer_id != auth.uid() then
    raise exception 'No tienes permiso para cerrar este pedido';
  end if;

  -- Actualizar el estado del pedido y el método de pago
  update public.orders
     set status = 'closed',
         payment_method = p_payment_method,
         updated_at = now()
   where id = p_order_id;

  if not found then
    raise exception 'No se pudo cerrar el pedido.';
  end if;
end;
$$;

-- Función para marcar un pedido como terminado/enviado
drop function if exists public.rpc_mark_order_as_sent(uuid);
create or replace function public.rpc_mark_order_as_sent(p_order_id uuid)
returns void language plpgsql security definer as $$
begin
  -- Verificar que el usuario es admin
  if not exists (
    select 1 from public.admins
    where user_id = auth.uid()
  ) then
    raise exception 'Solo administradores pueden marcar pedidos como terminados';
  end if;

  -- Verificar que el pedido existe y está cerrado
  if not exists (
    select 1 from public.orders
    where id = p_order_id
      and status = 'closed'
  ) then
    raise exception 'El pedido no existe o no está cerrado';
  end if;

  -- Actualizar el estado del pedido a 'sent' (terminado/enviado)
  update public.orders
     set status = 'sent',
         updated_at = now()
   where id = p_order_id;

  if not found then
    raise exception 'No se pudo marcar el pedido como terminado.';
  end if;
end;
$$;

-- Función para obtener emails de usuarios (solo para administradores)
drop function if exists public.rpc_get_user_emails(uuid[]);
create or replace function public.rpc_get_user_emails(p_user_ids uuid[])
returns table (user_id uuid, email text)
language plpgsql
security definer
as $$
begin
  -- Verificar que el usuario es admin
  if not exists (
    select 1 from public.admins
    where user_id = auth.uid()
  ) then
    raise exception 'Solo administradores pueden obtener emails de usuarios';
  end if;

  -- Retornar emails de los usuarios solicitados
  return query
  select 
    au.id as user_id,
    au.email::text as email
  from auth.users au
  where au.id = any(p_user_ids);
end;
$$;

-- Tabla de notificaciones para el admin
create table if not exists public.admin_notifications (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references public.orders(id) on delete cascade,
  order_number text,
  item_id uuid references public.order_items(id) on delete cascade,
  product_name text,
  color text,
  size text,
  quantity int,
  customer_name text,
  customer_number text,
  notification_type text not null default 'item_cancelled',
  message text,
  read boolean default false,
  created_at timestamptz not null default now()
);

-- Habilitar RLS para notificaciones
alter table public.admin_notifications enable row level security;

-- Política: solo admins pueden ver todas las notificaciones
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'admin_notifications'
      and policyname = 'admin_notifications_admin_all'
  ) then
    create policy admin_notifications_admin_all
      on public.admin_notifications
      for all to authenticated
      using (exists (select 1 from public.admins a where a.user_id = auth.uid()))
      with check (exists (select 1 from public.admins a where a.user_id = auth.uid()));
  end if;
end $$;

-- Índice para mejorar las consultas de notificaciones no leídas
create index if not exists ix_admin_notifications_read_created 
on public.admin_notifications(read, created_at desc)
where read = false;

-- Función para cancelar un producto individual del pedido
drop function if exists public.rpc_cancel_order_item(uuid);
create or replace function public.rpc_cancel_order_item(p_item_id uuid)
returns json
language plpgsql
security definer
as $$
declare
  v_item record;
  v_order record;
  v_customer record;
  v_item_status text;
  v_variant_id uuid;
  v_quantity int;
  v_was_picked boolean := false;
begin
  -- Obtener información del item
  select 
    oi.id,
    oi.order_id,
    oi.variant_id,
    oi.quantity,
    oi.product_name,
    oi.color,
    oi.size,
    oi.price_snapshot,
    oi.status,
    o.id as order_id_full,
    o.order_number,
    o.customer_id,
    c.full_name as customer_name,
    c.customer_number
  into v_item
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  left join public.customers c on c.id = o.customer_id
  where oi.id = p_item_id;

  if v_item.id is null then
    raise exception 'Item no encontrado';
  end if;

  -- Verificar que el cliente es el dueño del pedido
  if v_item.customer_id != auth.uid() then
    -- Verificar si es admin (admins también pueden cancelar)
    if not exists (
      select 1 from public.admins
      where user_id = auth.uid()
    ) then
      raise exception 'No tienes permiso para cancelar este item';
    end if;
  end if;

  -- Guardar el estado actual para verificar si estaba apartado
  v_item_status := v_item.status;
  v_variant_id := v_item.variant_id;
  v_quantity := v_item.quantity;
  v_was_picked := (v_item_status = 'picked');

  -- Si el item estaba apartado (picked), crear notificación para el admin
  if v_was_picked then
    insert into public.admin_notifications (
      order_id,
      order_number,
      item_id,
      product_name,
      color,
      size,
      quantity,
      customer_name,
      customer_number,
      notification_type,
      message
    ) values (
      v_item.order_id_full,
      v_item.order_number,
      p_item_id,
      v_item.product_name,
      v_item.color,
      v_item.size,
      v_quantity,
      v_item.customer_name,
      v_item.customer_number,
      'item_cancelled',
      format(
        'El cliente %s (Nº %s) canceló el producto "%s" (Color: %s, Talle: %s, Cantidad: %s) del pedido #%s que ya estaba apartado.',
        coalesce(v_item.customer_name, 'Cliente'),
        coalesce(v_item.customer_number, '-'),
        coalesce(v_item.product_name, 'Producto'),
        coalesce(v_item.color, '-'),
        coalesce(v_item.size, '-'),
        v_quantity,
        coalesce(v_item.order_number, 'Sin número')
      )
    );
  end if;

  -- Manejar stock según el estado del producto cancelado
  if v_was_picked and v_variant_id is not null then
    -- Si estaba apartado (picked), el producto vuelve al stock inmediatamente
    -- Restamos de reserved_qty y SUMAMOS a stock_qty (devuelve al stock físico)
    update public.product_variants
       set reserved_qty = greatest(reserved_qty - v_quantity, 0),
           stock_qty = stock_qty + v_quantity
     where id = v_variant_id;
  elsif not v_was_picked and v_variant_id is not null then
    -- Si estaba solo en "reserved" (no apartado), solo liberar reserved_qty
    -- NO aumenta stock_qty porque nunca se descontó del stock físico
    -- (el producto nunca fue apartado físicamente)
    update public.product_variants
       set reserved_qty = greatest(reserved_qty - v_quantity, 0)
     where id = v_variant_id;
  end if;

  -- Actualizar el total del pedido restando el precio del item cancelado
  update public.orders
     set total_amount = greatest(
       coalesce(total_amount, 0) - (coalesce(v_item.price_snapshot, 0) * v_quantity),
       0
     ),
     updated_at = now()
   where id = v_item.order_id_full;

  -- Marcar el item como cancelado (o eliminarlo si prefieres)
  -- Opción 1: Marcar como cancelado (mantiene el registro)
  update public.order_items
     set status = 'cancelled',
         updated_at = now()
   where id = p_item_id;

  -- Opción 2: Eliminar el item (descomentar si prefieres eliminar en lugar de marcar)
  -- delete from public.order_items where id = p_item_id;

  -- Retornar información sobre la cancelación
  return json_build_object(
    'item_id', p_item_id,
    'order_id', v_item.order_id_full,
    'was_picked', v_was_picked,
    'notification_created', v_was_picked
  );
end;
$$;

-- Habilitar Realtime para orders, order_items y admin_notifications (actualizaciones en tiempo real)
-- Esto permite que el panel de admin reciba actualizaciones automáticas
do $$
begin
  -- Agregar orders a la publicación de Realtime
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and tablename = 'orders'
      and schemaname = 'public'
  ) then
    alter publication supabase_realtime add table public.orders;
  end if;

  -- Agregar order_items a la publicación de Realtime
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and tablename = 'order_items'
      and schemaname = 'public'
  ) then
    alter publication supabase_realtime add table public.order_items;
  end if;

  -- Agregar admin_notifications a la publicación de Realtime
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and tablename = 'admin_notifications'
      and schemaname = 'public'
  ) then
    alter publication supabase_realtime add table public.admin_notifications;
  end if;
end $$;

-- Función para asignar números de pedido a pedidos existentes que no tienen número
-- Usa la misma configuración de privacidad
create or replace function public.assign_order_numbers_to_existing()
returns void
language plpgsql
as $$
declare
  order_record record;
  current_letter char(1) := 'A';
  current_number int;
  next_letter char(1);
  next_number int;
  formatted_number text;
  order_count int;
  config_base int;
  config_increment int;
  last_order_number text;
begin
  -- Obtener configuración de privacidad
  select base_number, increment_step
  into config_base, config_increment
  from public.get_order_number_config();
  
  -- Contar cuántos pedidos existen sin número
  select count(*) into order_count
  from public.orders 
  where order_number is null or order_number = '';
  
  if order_count = 0 then
    return; -- No hay pedidos sin número
  end if;
  
  -- Obtener el último número de pedido existente
  select order_number
  into last_order_number
  from (
    select order_number
    from public.orders
    where order_number is not null
      and order_number ~ '^[A-Z][0-9]{5}$'
    order by 
      ascii(substring(order_number, 1, 1)) desc,
      cast(substring(order_number, 2) as int) desc
    limit 1
  ) as last_order;
  
  if last_order_number is not null then
    -- Extraer letra y número del último pedido
    current_letter := substring(last_order_number, 1, 1);
    current_number := cast(substring(last_order_number, 2) as int);
  else
    -- Si no hay pedidos con número, empezar con el número base
    current_letter := 'A';
    current_number := config_base - config_increment; -- Restar incremento para que el primer pedido tenga el número base
  end if;
  
  -- Asignar números a pedidos existentes que no tienen número
  -- Ordenados por fecha de creación para mantener la secuencia
  for order_record in 
    select id, created_at 
    from public.orders 
    where order_number is null or order_number = ''
    order by created_at
  loop
    -- Incrementar número según el incremento configurado
    next_number := current_number + config_increment;
    
    -- Si llegamos a 99999, avanzar a la siguiente letra
    if next_number > 99999 then
      if current_letter = 'Z' then
        raise exception 'Se alcanzó el límite de pedidos al asignar números existentes.';
      else
        next_letter := chr(ascii(current_letter) + 1);
        next_number := config_base; -- Empezar desde el número base en la nueva letra
        current_letter := next_letter;
      end if;
    else
      next_letter := current_letter;
    end if;
    
    -- Formatear número con 5 dígitos
    formatted_number := next_letter || lpad(next_number::text, 5, '0');
    
    -- Asignar el número
    update public.orders
    set order_number = formatted_number
    where id = order_record.id
      and (order_number is null or order_number = '');
    
    -- Actualizar contadores para el siguiente pedido
    current_number := next_number;
    current_letter := next_letter;
  end loop;
end;
$$;

-- Ejecutar una vez para asignar números a pedidos existentes
-- Esto asigna números secuenciales a pedidos que no tienen número
do $$
begin
  perform public.assign_order_numbers_to_existing();
  raise notice 'Números de pedido asignados a pedidos existentes';
exception when others then
  raise warning 'Error al asignar números de pedido: %', sqlerrm;
end $$;

select pg_notify('pgrst','reload schema');

