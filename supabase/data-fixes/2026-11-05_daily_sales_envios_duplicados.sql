-- 2026-11-05_daily_sales_envios_duplicados.sql
--
-- CORRECCION DE DATOS (no es migracion de esquema). Requiere aprobacion explicita
-- antes de correr en produccion (proyecto fyl-core, dtfznewwvsadkorxwzft).
--
-- Problema: el boton "Enviar al Local" (rpc_send_order_to_local) dejaba el pedido en
-- orders.status='sent'. El trigger trigger_register_envio_sale inserto una fila
-- daily_sales(sale_type='envios') y, al cobrar en el local, trigger_register_local_sale
-- inserto otra fila daily_sales(sale_type='local'): mismo dinero contado dos veces.
-- El codigo ya fue corregido (rama fix/enviar-al-local-sin-sent). Esto limpia el pasado.
--
-- Que borra (SOLO clase A, filas 'envios' duplicadas, comprobadas una a una):
--   * el pedido web fue copiado a local_orders (source_order_id) y no es espejo de Retiro;
--   * orders.status='sent' y local_orders.status='completed';
--   * existe EXACTAMENTE 1 public_sale activa (voided_at is null) de ese pedido local
--     y esa venta tiene su fila daily_sales 'local' (la plata real queda registrada);
--   * existe EXACTAMENTE 1 fila 'envios' que coincide en fecha, hora, cliente y monto.
--
-- Que NO toca:
--   * ventas 'local', public_sales, orders, local_orders, stock;
--   * pedidos sin venta activa o con matching ambiguo (clase C): ahi la fila 'envios'
--     puede ser el unico registro del dinero. Se reportan, no se borran;
--   * pedidos aun 'pending' en el local (clase B): ver script separado de opcional.
--
-- Seguridad: una sola transaccion. Backup de lo borrado en
-- fyl_private.daily_sales_envios_dup_backup_20261105 (fuera de la Data API: no se
-- otorga acceso a anon/authenticated). Si los conteos no coinciden con los esperados,
-- la transaccion aborta y no cambia nada.
--
-- Rollback: ver 2026-11-05_daily_sales_envios_duplicados_ROLLBACK.sql
-- Verificacion posterior: ver bloque VERIFICACION al final.

begin;

create schema if not exists fyl_private;

create temp table _dup_targets on commit drop as
with cand as (
  select
    o.id as order_id,
    o.order_number,
    o.total_amount,
    lo.id as local_order_id,
    lo.order_number as local_order_number,
    lo.status as lo_status,
    coalesce(c.full_name, 'Cliente sin nombre') as cname,
    (o.sent_at at time zone 'America/Argentina/Buenos_Aires')::date as d,
    (o.sent_at at time zone 'America/Argentina/Buenos_Aires')::time as t
  from public.local_orders lo
  join public.orders o on o.id = lo.source_order_id
  left join public.customers c on c.id = o.customer_id
  where o.status = 'sent'
    and lo.status = 'completed'
    and coalesce(o.notes, '') not like '%mirrored_from_local_order%'
),
checked as (
  select
    cand.*,
    (select count(*)
       from public.public_sales ps
      where ps.notes ilike '%Pedido local ' || cand.local_order_number || '%'
        and ps.voided_at is null) as ventas_activas,
    (select count(*)
       from public.public_sales ps
       join public.daily_sales dsl
         on dsl.public_sale_id = ps.id and dsl.sale_type = 'local'
      where ps.notes ilike '%Pedido local ' || cand.local_order_number || '%'
        and ps.voided_at is null) as ventas_con_fila_local
  from cand
)
select
  ds.id as daily_sale_id,
  ch.order_id,
  ch.order_number,
  ch.local_order_number
from checked ch
join public.daily_sales ds
  on ds.sale_type = 'envios'
 and ds.sale_date = ch.d
 and ds.sale_time = ch.t
 and ds.customer_name = ch.cname
 and abs(ds.sale_amount - ch.total_amount) < 0.01
where ch.ventas_activas = 1
  and ch.ventas_con_fila_local = 1
  -- exactamente una fila 'envios' candidata por pedido
  and (
    select count(*)
      from public.daily_sales d2
     where d2.sale_type = 'envios'
       and d2.sale_date = ch.d
       and d2.sale_time = ch.t
       and d2.customer_name = ch.cname
       and abs(d2.sale_amount - ch.total_amount) < 0.01
  ) = 1;

-- Cada fila de daily_sales debe quedar asignada a un solo pedido.
do $$
declare
  v_rows int;
  v_distinct int;
begin
  select count(*), count(distinct daily_sale_id) into v_rows, v_distinct from _dup_targets;
  if v_rows <> v_distinct then
    raise exception 'daily_sales_envios_dup: una fila de daily_sales coincide con mas de un pedido (% filas, % distintas)', v_rows, v_distinct;
  end if;
  -- Conteo esperado segun la verificacion de solo lectura del 2026-11-05 18:4x.
  if v_rows <> 185 then
    raise exception 'daily_sales_envios_dup: se esperaban 185 filas y hay %; abortado sin cambios', v_rows;
  end if;
end $$;

create table fyl_private.daily_sales_envios_dup_backup_20261105 as
select
  ds.*,
  t.order_id,
  t.order_number,
  t.local_order_number,
  now() as backed_up_at
from public.daily_sales ds
join _dup_targets t on t.daily_sale_id = ds.id;

revoke all on table fyl_private.daily_sales_envios_dup_backup_20261105 from public, anon, authenticated;

do $$
declare
  v_deleted int;
begin
  delete from public.daily_sales ds
  using _dup_targets t
  where ds.id = t.daily_sale_id
    and ds.sale_type = 'envios';
  get diagnostics v_deleted = row_count;
  if v_deleted <> 185 then
    raise exception 'daily_sales_envios_dup: se borraron % filas (esperadas 185); abortado', v_deleted;
  end if;
end $$;

commit;

-- ---------------------------------------------------------------------------
-- VERIFICACION (solo lectura, correr despues del commit)
-- ---------------------------------------------------------------------------
-- 1) Backup completo y sin pedidos con venta 'local' faltante:
--    select count(*), sum(sale_amount) from fyl_private.daily_sales_envios_dup_backup_20261105;
-- 2) Ninguno de los pedidos corregidos conserva fila 'envios':
--    select count(*) from fyl_private.daily_sales_envios_dup_backup_20261105 b
--    join public.daily_sales ds on ds.id = b.id;                      -- esperado 0
-- 3) Las ventas 'local' siguen intactas (no se tocaron):
--    select count(*) from public.daily_sales where sale_type = 'local';  -- igual que antes
