-- 342_fix_remove_order_item_no_blind_restore.sql
--
-- CAUSA RAIZ CONFIRMADA del incidente real (pedido A56971 / Yamila Aguirre,
-- 2026-09-12): rpc_checkout_cart (331) es correcto y usa FOR UPDATE, pero
-- confio en un dato de variant_size_warehouse_stock que ya estaba inflado
-- por un credito fantasma previo.
--
-- Rastreo exacto (stock_history, variante FYL-91-NEG talle 38, deposito general):
--   2026-09-05 13:38  order_deduction -1                 -> stock=0
--   2026-09-07 11:55  adjustment +1  "rpc_remove_order_item_restore_stock:
--                      fallback picked order_item=52651f13-..."  -> stock=1 (FANTASMA)
--   2026-09-10 10:13  order_deduction -1 (otro pedido)    -> stock=0
--   2026-09-11 15:33  adjustment +2  carga manual admin/products -> stock=2
--   2026-09-12 16:43  checkout de Yamila consume 1        -> termina "missing"
--
-- El evento del 07/sep es la rama "Fallback: sin fuentes y no missing" de
-- rpc_remove_order_item_restore_stock (140, vigente sin cambios desde entonces):
-- cuando se quita un order_item picked/reserved/waiting SIN fila en
-- order_item_stock_sources, la funcion asumia que la unidad fisica existia y
-- sumaba +qty al deposito general sin ninguna evidencia real. Esa suposicion
-- es la que crea el "credito fantasma" que despues el catalogo online ofrece
-- como disponible a una clienta real.
--
-- Cambio (342): esa rama fallback DEJA DE MUTAR variant_size_warehouse_stock.
-- En su lugar registra el evento en stock_history (quantity_changed=0,
-- change_type='no_restore_no_sources_review') para que el equipo lo revise y
-- reingrese el talle manualmente solo si confirma que la unidad existe.
--
-- No cambia la rama "por order_item_stock_sources" (evidencia real, se sigue
-- restaurando exacto). No cambia el release de reserved_qty (sigue liberando
-- al borrar el item, es contable y no afecta lo que ve el catalogo online).
--
-- Efecto esperado: en checkouts/remociones futuras, un item picked/reserved/
-- waiting sin fuentes trazadas ya NO genera una unidad fantasma vendible.
-- Contrapartida aceptada: si esa unidad SI era real, el talle queda en 0 en
-- vez de recuperarse solo, hasta que alguien lo revise y lo reingrese a mano
-- (perdida de venta potencial, no overselling a un cliente).
--
-- Riesgo: MEDIO (cambia comportamiento de una RPC de produccion usada por el
-- panel admin al quitar items de pedidos). Sin cambios en checkout, carrito,
-- ni RLS.
-- Rollback: 342_ROLLBACK_fix_remove_order_item_no_blind_restore.sql (restaura
-- el fallback anterior, version 140 vigente hasta ahora).

CREATE OR REPLACE FUNCTION public.rpc_remove_order_item_restore_stock(p_order_item_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_uid uuid;
  v_item public.order_items%rowtype;
  v_order_id uuid;
  v_st text;
  v_size_norm text;
  v_qty int;
  v_price numeric;
  v_line_total numeric;
  v_general_id uuid;
  v_product_id uuid;
  v_status text;
  v_src record;
  v_row record;
  v_before int;
  v_after int;
  v_found boolean;
  v_has_sources boolean;
  v_order_deleted boolean := false;
  v_match_id uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'No autenticado';
  end if;
  if not exists (select 1 from public.admins where user_id = v_uid) then
    raise exception 'Solo administradores pueden quitar ítems con esta función';
  end if;

  select * into v_item from public.order_items where id = p_order_item_id for update;
  if not found then
    raise exception 'Ítem no encontrado';
  end if;

  v_order_id := v_item.order_id;
  if not exists (select 1 from public.orders where id = v_order_id) then
    raise exception 'Pedido no encontrado';
  end if;

  v_qty := greatest(coalesce(v_item.quantity, 0), 0);
  v_price := coalesce(v_item.price_snapshot, 0);
  v_line_total := coalesce(v_qty * v_price, 0);

  v_status := lower(trim(coalesce(v_item.status, '')));

  v_size_norm := trim(coalesce(v_item.size::text, ''));
  if v_size_norm = '' then
    v_size_norm := null;
  elsif v_size_norm ~ '^\d+(\.\d+)?$' then
    v_size_norm := split_part(v_size_norm, '.', 1);
  end if;

  select id into v_general_id from public.warehouses where code = 'general' limit 1;

  if v_item.variant_id is not null then
    select pv.product_id into v_product_id from public.product_variants pv where pv.id = v_item.variant_id;
    perform 1
    from public.product_variants pv
    where pv.id = v_item.variant_id
    for update;
  end if;

  select exists (
    select 1 from public.order_item_stock_sources s where s.order_item_id = p_order_item_id
  ) into v_has_sources;

  -- ---------- Stock: por order_item_stock_sources (evidencia real, sin cambios) ----------
  if v_item.variant_id is not null and v_size_norm is not null and v_has_sources then
    for v_src in
      select s.warehouse_id, s.qty
      from public.order_item_stock_sources s
      where s.order_item_id = p_order_item_id
    loop
      if coalesce(v_src.qty, 0) <= 0 then
        continue;
      end if;

      v_before := 0;
      v_found := false;
      for v_row in
        select vsws.id, vsws.size, vsws.stock_qty
        from public.variant_size_warehouse_stock vsws
        where vsws.variant_id = v_item.variant_id
          and vsws.warehouse_id = v_src.warehouse_id
      loop
        v_st := trim(coalesce(v_row.size::text, ''));
        if v_st = '' then
          v_st := null;
        elsif v_st ~ '^\d+(\.\d+)?$' then
          v_st := split_part(v_st, '.', 1);
        end if;
        if v_st is not distinct from v_size_norm then
          v_before := coalesce(v_row.stock_qty, 0);
          v_found := true;
          v_after := v_before + v_src.qty;
          update public.variant_size_warehouse_stock
          set stock_qty = v_after, updated_at = now()
          where id = v_row.id;
          if v_product_id is not null then
            perform public.log_stock_change(
              v_product_id,
              v_item.variant_id,
              v_size_norm,
              v_src.warehouse_id,
              'adjustment',
              v_before,
              v_after,
              null,
              null,
              format('rpc_remove_order_item_restore_stock: devolución por fuentes order_item=%s', p_order_item_id)
            );
          end if;
          exit;
        end if;
      end loop;

      if not v_found then
        v_after := v_src.qty;
        insert into public.variant_size_warehouse_stock (variant_id, size, warehouse_id, stock_qty, updated_at)
        values (v_item.variant_id, v_size_norm, v_src.warehouse_id, v_after, now())
        on conflict (variant_id, size, warehouse_id)
        do update set
          stock_qty = public.variant_size_warehouse_stock.stock_qty + excluded.stock_qty,
          updated_at = now();
        if v_product_id is not null then
          perform public.log_stock_change(
            v_product_id,
            v_item.variant_id,
            v_size_norm,
            v_src.warehouse_id,
            'adjustment',
            0,
            v_after,
            null,
            null,
            format('rpc_remove_order_item_restore_stock: insert devolución por fuentes order_item=%s', p_order_item_id)
          );
        end if;
      end if;
    end loop;
  end if;

  -- ---------- Fallback (342): sin fuentes y no missing -> YA NO restaura solo ----------
  -- Antes (140) esta rama sumaba +qty al deposito general asumiendo que la unidad
  -- fisica existia, sin evidencia real. Eso genero un credito fantasma que
  -- termino ofertado a una clienta real (ver cabecera de este archivo).
  -- Ahora: no se muta variant_size_warehouse_stock. Se deja un registro en
  -- stock_history (delta 0) para revision manual/fisica.
  if v_item.variant_id is not null
     and v_size_norm is not null
     and not v_has_sources
     and v_status <> 'missing'
     and v_status in ('picked', 'reserved', 'waiting')
     and v_general_id is not null
  then
    v_before := 0;
    v_found := false;
    v_match_id := null;
    for v_row in
      select vsws.id, vsws.size, vsws.stock_qty
      from public.variant_size_warehouse_stock vsws
      where vsws.variant_id = v_item.variant_id
        and vsws.warehouse_id = v_general_id
    loop
      v_st := trim(coalesce(v_row.size::text, ''));
      if v_st = '' then
        v_st := null;
      elsif v_st ~ '^\d+(\.\d+)?$' then
        v_st := split_part(v_st, '.', 1);
      end if;
      if v_st is not distinct from v_size_norm then
        v_before := coalesce(v_row.stock_qty, 0);
        v_match_id := v_row.id;
        v_found := true;
        exit;
      end if;
    end loop;

    if v_product_id is not null then
      perform public.log_stock_change(
        v_product_id,
        v_item.variant_id,
        v_size_norm,
        v_general_id,
        'no_restore_no_sources_review',
        v_before,
        v_before,
        null,
        null,
        format('rpc_remove_order_item_restore_stock: item %s (status=%s) removido sin order_item_stock_sources. NO se restauro stock automaticamente (342, ex-fallback). Requiere verificacion fisica antes de reingresar unidades. order_item=%s', p_order_item_id, v_status, p_order_item_id)
      );
    end if;
  end if;

  -- reserved_qty (fix 249): liberar cuando corresponde. Sigue igual: es
  -- contable (cuanto esta "tomado" por pedidos), no afecta lo que el catalogo
  -- ofrece como disponible.
  if v_item.variant_id is not null
     and (v_has_sources or v_status in ('picked', 'reserved', 'waiting'))
  then
    update public.product_variants pv
    set reserved_qty = greatest(coalesce(pv.reserved_qty, 0) - v_qty, 0)
    where pv.id = v_item.variant_id;
  end if;

  delete from public.order_items where id = p_order_item_id;

  update public.orders o
  set
    total_amount = greatest(coalesce(o.total_amount, 0) - v_line_total, 0),
    updated_at = now()
  where o.id = v_order_id;

  if public.order_eligible_for_empty_deletion(v_order_id) then
    perform public.maint_try_delete_order_if_eligible(v_order_id, 'rpc_remove_order_item_restore_stock');
    v_order_deleted := true;
  end if;

  return json_build_object(
    'ok', true,
    'order_id', v_order_id,
    'order_deleted', v_order_deleted
  );
end;
$function$;

COMMENT ON FUNCTION public.rpc_remove_order_item_restore_stock(uuid) IS
  '342: al quitar un item picked/reserved/waiting SIN order_item_stock_sources, ya no restaura stock a ciegas (causa raiz confirmada del caso A56971/Yamila 2026-09-12). Solo registra en stock_history para revision manual. La restauracion por fuentes trazadas sigue exacta.';

-- Extiende la watchlist de 341 para incluir tambien estos eventos "no restaurado,
-- pendiente de revision" en el mismo tablero.
CREATE OR REPLACE VIEW public.vw_stock_audit_untracked_sales AS
SELECT
  'public_sale_sin_stock'::text AS source_type,
  psi.created_at AS event_at,
  pv.product_id,
  COALESCE(p.name, psi.product_name) AS product_name,
  psi.variant_id,
  pv.color AS variant_color,
  pv.sku AS variant_sku,
  NULLIF(TRIM(COALESCE(psi.sold_size_normalized::text, '')), '') AS size,
  psi.qty,
  psi.sale_id AS reference_id,
  ps.sold_by AS admin_user_id,
  'sell_without_stock: venta publica confirmada sin descuento en variant_size_warehouse_stock (sistema ya mostraba 0/0 en ese talle)'::text AS reason
FROM public.public_sale_items psi
JOIN public.public_sales ps ON ps.id = psi.sale_id
LEFT JOIN public.product_variants pv ON pv.id = psi.variant_id
LEFT JOIN public.products p ON p.id = pv.product_id
WHERE psi.variant_id IS NOT NULL
  AND COALESCE(psi.is_return, false) = false
  AND ps.voided_at IS NULL
  AND psi.qty_venta_publico IS NOT NULL
  AND psi.qty_general IS NOT NULL
  AND psi.qty_venta_publico = 0
  AND psi.qty_general = 0

UNION ALL

SELECT
  'admin_order_confirmado_sin_verificar'::text AS source_type,
  oi.created_at AS event_at,
  pv.product_id,
  oi.product_name,
  oi.variant_id,
  oi.color AS variant_color,
  pv.sku AS variant_sku,
  NULLIF(TRIM(COALESCE(oi.size::text, '')), '') AS size,
  oi.quantity AS qty,
  oi.order_id AS reference_id,
  o.created_by_user_id AS admin_user_id,
  'admin_confirmed_missing: pedido admin marcado apartado por confirmacion manual (neto stock = 0 via rpc_admin_manual_inject_and_deduct), sin verificacion del sistema'::text AS reason
FROM public.order_items oi
JOIN public.orders o ON o.id = oi.order_id
LEFT JOIN public.product_variants pv ON pv.id = oi.variant_id
WHERE oi.variant_id IS NOT NULL
  AND COALESCE(oi.admin_confirmed_missing, false) = true
  AND oi.status IN ('picked', 'missing')
  AND NULLIF(TRIM(COALESCE(oi.size::text, '')), '') IS NOT NULL

UNION ALL

SELECT
  'removido_sin_restaurar_pendiente_revision'::text AS source_type,
  sh.created_at AS event_at,
  sh.product_id,
  p.name AS product_name,
  sh.variant_id,
  pv.color AS variant_color,
  pv.sku AS variant_sku,
  NULLIF(TRIM(COALESCE(sh.size::text, '')), '') AS size,
  0 AS qty,
  sh.id AS reference_id,
  sh.user_id AS admin_user_id,
  'no_restore_no_sources_review: item removido de un pedido sin order_item_stock_sources; no se reingreso stock automaticamente (342), talle pendiente de verificacion fisica'::text AS reason
FROM public.stock_history sh
LEFT JOIN public.product_variants pv ON pv.id = sh.variant_id
LEFT JOIN public.products p ON p.id = sh.product_id
WHERE sh.change_type = 'no_restore_no_sources_review';

COMMENT ON VIEW public.vw_stock_audit_untracked_sales IS
  '341/342: eventos donde un talle quedo marcado como potencialmente no confiable (venta sin descuento, alta admin sin verificar, o remocion sin restauracion automatica por falta de evidencia). Watchlist para conteo fisico antes de que el catalogo online lo venda.';

SELECT pg_notify('pgrst', 'reload schema');
