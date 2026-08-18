-- 267_rpc_cancel_order_full_resolve_pending_cancelled_items.sql
--
-- BUG REAL DETECTADO (2026-08-03, junto con 266): rpc_cancel_order_full
-- ("Desarmar", definida en 163_stage1_stock_hardening.sql) solo procesa,
-- antes de borrar el pedido, items en status IN ('reserved','waiting',
-- 'missing') (pase 1, via rpc_cancel_order_item) y en 'picked' (pase 2, via
-- rpc_remove_order_item_restore_stock). Los items que YA estaban
-- 'cancelled' antes de apretar "Desarmar" (tipico: un producto que estaba
-- 'picked' y se cancelo individualmente -- rpc_cancel_order_item no le
-- devuelve el stock, queda pendiente del boton check) nunca se tocan en
-- ninguno de los dos pases.
--
-- Como el pedido queda elegible para borrado automatico en cuanto todos sus
-- items dejan de ser "operacionales" (order_item_status_is_operacional
-- devuelve false para 'cancelled' Y para 'expired'), maint_try_delete_order_
-- if_eligible borra el pedido entero por CASCADE al final de la funcion --
-- llevandose puesto ese item 'cancelled' con stock todavia pendiente, sin
-- que nadie lo haya devuelto nunca. Reproducido en produccion sobre A55245
-- (ver docs/FYL-Obsidian/48-AUDITORIA-ESTADOS-PEDIDOS-Y-FIXES-2026-08-01.md).
--
-- Cambio: se agrega un "Pase 0", antes del pase 1, que busca items
-- 'cancelled' del pedido que TODAVIA tengan filas en
-- order_item_stock_sources con qty > 0 (la presencia de esas filas es
-- exactamente la señal de "stock pendiente de devolver" -- rpc_cancel_order_
-- item las borra en el momento en que SI devuelve el stock automaticamente,
-- y las deja intactas cuando NO lo devuelve). Para esos items se llama a
-- rpc_remove_order_item_restore_stock, la misma funcion que ya usa el boton
-- check individual -- no filtra por status cuando hay fuentes (ver su
-- definicion), asi que funciona igual de bien aca. Se valida ok=true igual
-- que los pases existentes; si el resultado indica que el pedido ya se
-- borro (order_deleted=true, puede pasar si era el ultimo item), se sale del
-- loop y se deja que el resto de la funcion lo detecte de la forma normal.
--
-- No se cambia el pase 1, el pase 2, ni la logica de borrado del pedido al
-- final -- todo el resto de la funcion queda igual a 163.
--
-- Riesgo: BAJO-MEDIO (toca la RPC de cancelacion/desarme masivo). Mitigado
-- por:
--   - Reusa una funcion ya probada en produccion (rpc_remove_order_item_
--     restore_stock, la misma del boton check individual) en vez de
--     reimplementar la devolucion de stock.
--   - Solo afecta items que YA estaban 'cancelled' con fuentes pendientes;
--     no cambia el comportamiento para ningun item 'reserved'/'waiting'/
--     'missing'/'picked' (pases 1 y 2 identicos a 163).
--   - Si no hay ningun item en esa condicion, el nuevo pase no hace nada
--     (0 iteraciones) y el comportamiento es exactamente el de antes.
--
-- Rollback: volver a aplicar el CREATE OR REPLACE de
-- supabase/canonical/163_stage1_stock_hardening.sql (vuelve a dejar sin
-- resolver los items 'cancelled' con stock pendiente; no recomendado).
--
-- Verificacion post-deploy sugerida (solo lectura):
--   1) Crear (o usar) un pedido de prueba con un item 'picked' cancelado
--      individualmente (queda 'cancelled' con stock_sources intacto).
--   2) Apretar "Desarmar" sin tocar el boton check antes.
--   3) Verificar que variant_size_warehouse_stock / variant_warehouse_stock
--      del item sumaron la cantidad esperada y que reserved_qty bajo en la
--      misma cantidad -- antes de este fix, ninguno de los dos pasaba.

CREATE OR REPLACE FUNCTION public.rpc_cancel_order_full(p_order_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_uid uuid;
  v_order record;
  v_item_id uuid;
  v_rpc_result json;
  v_pending_cancelled_items int := 0;
  v_cancelled_items int := 0;
  v_removed_items int := 0;
  v_order_deleted boolean := false;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.admins a WHERE a.user_id = v_uid
  ) THEN
    RAISE EXCEPTION 'Solo administradores pueden cancelar pedidos completos';
  END IF;

  SELECT
    o.id,
    o.order_number,
    o.status,
    o.customer_id
  INTO v_order
  FROM public.orders o
  WHERE o.id = p_order_id
  FOR UPDATE;

  -- Idempotencia débil: si la orden ya no existe, consideramos que
  -- la operación ya fue aplicada previamente y devolvemos noop.
  IF v_order.id IS NULL THEN
    RETURN json_build_object(
      'ok', true,
      'idempotent_noop', true,
      'reason', 'order_not_found',
      'order_id', p_order_id
    );
  END IF;

  IF v_order.status IN ('closed', 'sent') THEN
    RAISE EXCEPTION 'No se puede cancelar un pedido con estado %', v_order.status;
  END IF;

  -- Bloquear ítems actuales del pedido para evitar carrera con otras acciones.
  PERFORM 1
  FROM public.order_items oi
  WHERE oi.order_id = p_order_id
  FOR UPDATE;

  -- Pase 0 (NUEVO en 267): items YA 'cancelled' antes de este Desarmar que
  -- todavia tienen stock pendiente de devolver (order_item_stock_sources con
  -- qty > 0 -- tipicamente items que estaban 'picked' al cancelarse
  -- individualmente). Se resuelven con la misma funcion que usa el boton
  -- check individual, para que "Desarmar" no se lleve puesto ese stock sin
  -- devolverlo.
  FOR v_item_id IN
    SELECT oi.id
    FROM public.order_items oi
    WHERE oi.order_id = p_order_id
      AND lower(trim(coalesce(oi.status, ''))) = 'cancelled'
      AND EXISTS (
        SELECT 1
        FROM public.order_item_stock_sources s
        WHERE s.order_item_id = oi.id
          AND greatest(coalesce(s.qty, 0), 0) > 0
      )
    ORDER BY oi.created_at, oi.id
  LOOP
    v_rpc_result := public.rpc_remove_order_item_restore_stock(v_item_id);

    IF v_rpc_result IS NULL
       OR NOT COALESCE((v_rpc_result->>'ok')::boolean, false)
    THEN
      RAISE EXCEPTION
        'rpc_remove_order_item_restore_stock no confirmó ok=true para item cancelado pendiente item_id=% (resultado=%)',
        v_item_id, v_rpc_result;
    END IF;

    v_pending_cancelled_items := v_pending_cancelled_items + 1;

    IF COALESCE((v_rpc_result->>'order_deleted')::boolean, false) THEN
      v_order_deleted := true;
      EXIT;
    END IF;
  END LOOP;

  -- Pase 1: reserved / waiting / missing -> rpc_cancel_order_item.
  -- rpc_cancel_order_item marca el item como 'cancelled' (trazabilidad),
  -- devuelve stock cuando corresponde y NO borra el pedido. Validamos
  -- applied=true en el JSON devuelto; si no, rollback de TODA la cancelación.
  FOR v_item_id IN
    SELECT oi.id
    FROM public.order_items oi
    WHERE oi.order_id = p_order_id
      AND lower(trim(coalesce(oi.status, ''))) IN ('reserved', 'waiting', 'missing')
    ORDER BY oi.created_at, oi.id
  LOOP
    v_rpc_result := public.rpc_cancel_order_item(v_item_id);

    IF v_rpc_result IS NULL
       OR NOT COALESCE((v_rpc_result->>'applied')::boolean, false)
    THEN
      RAISE EXCEPTION
        'rpc_cancel_order_item no confirmó applied=true para item_id=% (resultado=%)',
        v_item_id, v_rpc_result;
    END IF;

    v_cancelled_items := v_cancelled_items + 1;
  END LOOP;

  -- Pase 2: picked -> rpc_remove_order_item_restore_stock.
  -- Esta RPC restaura stock, BORRA el order_item y, si el pedido queda sin
  -- ítems operacionales, delega el borrado en maint_try_delete_order_if_eligible
  -- (registra order_empty_deletion_audit). Validamos ok=true del JSON; si no,
  -- rollback de TODA la cancelación.
  FOR v_item_id IN
    SELECT oi.id
    FROM public.order_items oi
    WHERE oi.order_id = p_order_id
      AND lower(trim(coalesce(oi.status, ''))) = 'picked'
    ORDER BY oi.created_at, oi.id
  LOOP
    v_rpc_result := public.rpc_remove_order_item_restore_stock(v_item_id);

    IF v_rpc_result IS NULL
       OR NOT COALESCE((v_rpc_result->>'ok')::boolean, false)
    THEN
      RAISE EXCEPTION
        'rpc_remove_order_item_restore_stock no confirmó ok=true para item_id=% (resultado=%)',
        v_item_id, v_rpc_result;
    END IF;

    v_removed_items := v_removed_items + 1;

    -- La RPC puede haber borrado el pedido ya (trigger 119).
    IF COALESCE((v_rpc_result->>'order_deleted')::boolean, false) THEN
      v_order_deleted := true;
      EXIT;
    END IF;
  END LOOP;

  -- Borrado del pedido por el camino oficial con auditoría.
  -- Si todos los ítems operativos pasaron a 'cancelled' o fueron eliminados,
  -- el pedido es elegible y maint_try_delete_order_if_eligible:
  --   - inserta una fila en public.order_empty_deletion_audit
  --   - DELETE FROM public.orders (que CASCADEA order_items y tablas derivadas)
  -- Los order_items en estado 'cancelled' se pierden por CASCADE: ese es el
  -- diseño actual del sistema (la auditoría se conserva en
  -- order_empty_deletion_audit + stock_history vía log_stock_change, no en
  -- order_items). Con el Pase 0 de arriba, para cuando se llega aca ya no
  -- deberia quedar ningun 'cancelled' con stock pendiente -- no se introduce
  -- un cambio a esa política, solo se cierra el hueco que la violaba.
  IF NOT v_order_deleted THEN
    v_order_deleted := COALESCE(
      public.maint_try_delete_order_if_eligible(p_order_id, 'rpc_cancel_order_full'),
      false
    );
  END IF;

  IF NOT v_order_deleted THEN
    -- Invariante esperada: tras procesar todos los ítems operacionales, el
    -- pedido debe quedar elegible para borrado. Si no, algún ítem quedó en
    -- estado operativo inesperado: abortar para forzar revisión manual.
    RAISE EXCEPTION
      'rpc_cancel_order_full: el pedido % no quedó elegible para borrado tras cancelar ítems operacionales',
      p_order_id;
  END IF;

  RETURN json_build_object(
    'ok', true,
    'idempotent_noop', false,
    'order_id', p_order_id,
    'order_number', v_order.order_number,
    'items_pending_cancelled_resolved', v_pending_cancelled_items,
    'items_cancelled_reserved_waiting_missing', v_cancelled_items,
    'items_removed_picked', v_removed_items,
    'order_deleted', v_order_deleted
  );
END;
$$;

SELECT pg_notify('pgrst', 'reload schema');
