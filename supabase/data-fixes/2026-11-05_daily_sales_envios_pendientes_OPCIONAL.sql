-- 2026-11-05_daily_sales_envios_pendientes_OPCIONAL.sql
--
-- OPCIONAL. Ejecutar solo si el negocio decide que estos 10 pedidos NO deben figurar
-- como "envio" mientras no se cobren en el local. Requiere aprobacion explicita.
--
-- Son pedidos enviados con "Enviar al Local" que siguen local_orders.status='pending'
-- (nadie los cobro: no hay public_sale). Su fila 'envios' hoy suma como si fueran venta.
-- Cuando el local los cobre, se creara la venta 'local' y quedaran correctos.
-- Riesgo: si alguno de ellos en realidad se entrego/cobro por fuera del sistema, esa
-- fila 'envios' era el unico registro. Revisar la lista antes (ver SELECT de abajo).
--
-- Rollback: reinsertar desde fyl_private.daily_sales_envios_pend_backup_20261105
-- con el mismo INSERT ... SELECT del archivo *_ROLLBACK.sql.

-- Lista a revisar (solo lectura):
-- select o.order_number, lo.order_number lo_num, o.total_amount,
--        (o.sent_at at time zone 'America/Argentina/Buenos_Aires')::date sent_ar, c.full_name
--   from public.local_orders lo join public.orders o on o.id = lo.source_order_id
--   left join public.customers c on c.id = o.customer_id
--  where o.status = 'sent' and lo.status = 'pending'
--    and coalesce(o.notes,'') not like '%mirrored_from_local_order%'
--  order by o.sent_at;

begin;

create schema if not exists fyl_private;

create temp table _pend_targets on commit drop as
with cand as (
  select
    o.id as order_id, o.order_number, o.total_amount,
    coalesce(c.full_name, 'Cliente sin nombre') as cname,
    (o.sent_at at time zone 'America/Argentina/Buenos_Aires')::date as d,
    (o.sent_at at time zone 'America/Argentina/Buenos_Aires')::time as t
  from public.local_orders lo
  join public.orders o on o.id = lo.source_order_id
  left join public.customers c on c.id = o.customer_id
  where o.status = 'sent'
    and lo.status = 'pending'
    and coalesce(o.notes, '') not like '%mirrored_from_local_order%'
    and not exists (
      select 1 from public.public_sales ps
       where ps.notes ilike '%Pedido local ' || lo.order_number || '%'
         and ps.voided_at is null
    )
)
select ds.id as daily_sale_id, cand.order_id, cand.order_number
from cand
join public.daily_sales ds
  on ds.sale_type = 'envios'
 and ds.sale_date = cand.d
 and ds.sale_time = cand.t
 and ds.customer_name = cand.cname
 and abs(ds.sale_amount - cand.total_amount) < 0.01
where (
  select count(*) from public.daily_sales d2
   where d2.sale_type = 'envios' and d2.sale_date = cand.d and d2.sale_time = cand.t
     and d2.customer_name = cand.cname and abs(d2.sale_amount - cand.total_amount) < 0.01
) = 1;

do $$
declare v_rows int; v_distinct int;
begin
  select count(*), count(distinct daily_sale_id) into v_rows, v_distinct from _pend_targets;
  if v_rows <> v_distinct or v_rows <> 10 then
    raise exception 'daily_sales_envios_pend: se esperaban 10 filas unicas y hay % (% distintas); abortado', v_rows, v_distinct;
  end if;
end $$;

create table fyl_private.daily_sales_envios_pend_backup_20261105 as
select ds.*, t.order_id, t.order_number, now() as backed_up_at
from public.daily_sales ds
join _pend_targets t on t.daily_sale_id = ds.id;

revoke all on table fyl_private.daily_sales_envios_pend_backup_20261105 from public, anon, authenticated;

do $$
declare v_deleted int;
begin
  delete from public.daily_sales ds using _pend_targets t
   where ds.id = t.daily_sale_id and ds.sale_type = 'envios';
  get diagnostics v_deleted = row_count;
  if v_deleted <> 10 then
    raise exception 'daily_sales_envios_pend: se borraron % (esperadas 10); abortado', v_deleted;
  end if;
end $$;

commit;
