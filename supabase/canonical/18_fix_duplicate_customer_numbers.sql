-- 18_fix_duplicate_customer_numbers.sql — Corregir números de cliente duplicados (idempotente)
-- Este script corrige números de cliente duplicados entre customers y pending_customers

-- Función para reasignar números de cliente en pending_customers que están duplicados
create or replace function public.fix_duplicate_pending_customer_numbers()
returns void
language plpgsql
as $$
declare
  pending_record record;
  new_customer_number text;
  max_pending_number integer;
  max_customer_number integer;
  next_number integer;
begin
  -- Para cada pending_customer, verificar si su número está duplicado en customers
  for pending_record in 
    select pc.id, pc.customer_number, pc.email, pc.full_name
    from public.pending_customers pc
    where exists (
      select 1 
      from public.customers c 
      where c.customer_number = pc.customer_number
        and pc.customer_number ~ '^\d+$'
    )
    order by pc.created_at
  loop
    -- Buscar el máximo número en pending_customers (excluyendo el actual)
    select coalesce(max(cast(customer_number as integer)), 0)
    into max_pending_number
    from public.pending_customers
    where customer_number ~ '^\d+$'
      and id != pending_record.id;
    
    -- Buscar el máximo número en customers
    select coalesce(max(cast(customer_number as integer)), 0)
    into max_customer_number
    from public.customers
    where customer_number ~ '^\d+$';
    
    -- Usar el máximo entre ambas tablas + 1
    next_number := greatest(max_pending_number, max_customer_number) + 1;
    new_customer_number := lpad(next_number::text, 4, '0');
    
    -- Actualizar el pending_customer con el nuevo número
    update public.pending_customers
    set customer_number = new_customer_number
    where id = pending_record.id;
    
    -- También actualizar el customer temporal asociado si existe
    update public.customers
    set customer_number = new_customer_number
    where pending_customer_email = pending_record.email
      and is_temporary = true
      and customer_number = pending_record.customer_number;
    
    raise notice 'Cliente pendiente % (email: %) actualizado de % a %', 
      pending_record.full_name, 
      pending_record.email,
      pending_record.customer_number,
      new_customer_number;
  end loop;
end;
$$;

-- Ejecutar la corrección
do $$
begin
  perform public.fix_duplicate_pending_customer_numbers();
  raise notice 'Corrección de números duplicados completada';
exception when others then
  raise warning 'Error al corregir números duplicados: %', sqlerrm;
end $$;

select pg_notify('pgrst','reload schema');


