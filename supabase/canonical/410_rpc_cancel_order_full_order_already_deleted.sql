-- 410_rpc_cancel_order_full_order_already_deleted.sql
--
-- BUG (2026-11-20, pedido A58953 / Gesica Croce; logs 2026-11-19 16:03 y 2026-11-20 12:40 UTC):
-- "Archivar"/"Desarmar" en Orders falla con
--   "rpc_cancel_order_full: el pedido ... no quedó elegible para borrado tras cancelar ítems operacionales"
-- en pedidos SIN ítems 'picked' (solo 'missing' o solo 'reserved').
--
-- Causa: en el Pase 1, al cancelar el ÚLTIMO ítem operativo con rpc_cancel_order_item,
-- el trigger order_items_after_cancelled_try_empty_order (319) ya borra el pedido
-- (maint_try_delete_order_if_eligible). Después el chequeo final vuelve a llamar a
-- maint_try_delete_order_if_eligible, que devuelve false porque el pedido YA NO EXISTE,
-- y la RPC lo toma como "no elegible": lanza la excepción y revierte todo.
-- Con ítems 'picked' no pasaba porque el Pase 2 sí propaga order_deleted.
--
-- Cambio (único): después del Pase 1, si el pedido ya no existe se marca
-- v_order_deleted := true. No cambia ninguna regla de stock ni qué ítems se procesan;
-- el resto de la función es idéntico a 267 (= producción al 2026-11-20).
--
-- Riesgo: BAJO. Solo afecta el camino que hoy termina en excepción.
-- Rollback: 410_ROLLBACK_rpc_cancel_order_full_order_already_deleted.sql (vuelve a 267).
--
-- Verificación post-deploy (solo lectura):
--   1) Archivar A58953 desde Orders: el pedido desaparece y queda fila en
--      order_empty_deletion_audit (source = 'trigger_order_items_cancelled').
--   2) stock_history: filas 'writeoff_missing' con quantity_changed = 0 (no suma stock).
--   3) variant_size_warehouse_stock de J25 Verde 37/38 sin cambios.
--
-- NO APLICAR en producción sin aprobación explícita.

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

  -- 410: el trigger order_items_after_cancelled_try_empty_order pudo haber borrado
  -- el pedido al cancelar el último ítem. Eso es éxito, no "no elegible".
  IF NOT v_order_deleted
     AND NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.id = p_order_id)
  THEN
    v_order_deleted := true;
  END IF;

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
