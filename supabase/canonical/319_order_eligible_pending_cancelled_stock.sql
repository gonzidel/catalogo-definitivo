-- 319_order_eligible_pending_cancelled_stock.sql
--
-- BUG (2026-09-01, pedido A56391 / luis cuadrado): si la clienta cancela varios
-- productos desde el dashboard y el admin confirma (✓) uno en Cancelados,
-- rpc_remove_order_item_restore_stock borraba el pedido entero en cuanto no
-- quedaban ítems "operacionales" — aunque otros ítems cancelados seguían con
-- order_item_stock_sources (stock apartado sin devolver). Esos ítems se
-- eliminaban por CASCADE sin devolver stock → pérdida de inventario y pedido
-- fantasma en UI ("Sin productos cancelados" con contador de unidades).
--
-- Causa: order_eligible_for_empty_deletion solo miraba ítems operacionales;
-- todos los cancelled cuentan como no operacionales, así que tras confirmar el
-- primero el pedido era "elegible" y maint_try_delete_order_if_eligible lo
-- borraba (mismo patrón documentado en 267 para rpc_cancel_order_full).
--
-- Cambios:
--   1) order_has_cancelled_items_pending_stock_return(uuid) — espejo de
--      nj/lib/orders/domain.ts cancelledItemNeedsStockConfirmation.
--   2) order_eligible_for_empty_deletion — false si queda stock pendiente.
--   3) Trigger al cancelar ítem (INSERT/UPDATE → cancelled): intenta borrar
--      pedido solo cuando ya es seguro (sin stock pendiente).
--   4) Backfill: pedidos active/closing_soon/cancelled solo con ítems
--      cancelados/expired y sin stock pendiente.
--
-- Riesgo: BAJO. Evita borrados prematuros; no cambia devolución de stock.
-- Rollback: volver a aplicar 119_order_item_operational_and_empty_order_maint.sql
-- (no recomendado).

-- ---------------------------------------------------------------------------
-- 1) Helper: ítems cancelados con stock aún en order_item_stock_sources
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.order_has_cancelled_items_pending_stock_return(p_order_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.order_items oi
    JOIN public.order_item_stock_sources s ON s.order_item_id = oi.id
    WHERE oi.order_id = p_order_id
      AND lower(trim(coalesce(oi.status, ''))) = 'cancelled'
      AND coalesce(oi.admin_confirmed_missing, false) = false
      AND greatest(coalesce(s.qty, 0), 0) > 0
  );
$$;

COMMENT ON FUNCTION public.order_has_cancelled_items_pending_stock_return(uuid) IS
  'true si el pedido tiene ítems cancelled (no admin_confirmed_missing) con order_item_stock_sources qty > 0 — stock apartado pendiente de confirmar con ✓ admin.';

-- ---------------------------------------------------------------------------
-- 2) Elegibilidad de borrado: exige que no quede stock pendiente en cancelados
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.order_eligible_for_empty_deletion(p_order_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM public.order_items oi
    WHERE oi.order_id = p_order_id
      AND public.order_item_status_is_operacional(oi.status)
  )
  AND NOT public.order_has_cancelled_items_pending_stock_return(p_order_id);
$$;

COMMENT ON FUNCTION public.order_eligible_for_empty_deletion(uuid) IS
  'true si no hay ítems operacionales Y no hay cancelados con stock pendiente en order_item_stock_sources (319). Sin filas en order_items también true.';

-- ---------------------------------------------------------------------------
-- 3) Trigger: al pasar un ítem a cancelled, borrar pedido si ya es seguro
--    (p. ej. todos reserved cancelados sin fuentes — evita fantasmas active)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_order_items_cancelled_try_empty_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF lower(trim(coalesce(NEW.status, ''))) = 'cancelled' THEN
    PERFORM public.maint_try_delete_order_if_eligible(
      NEW.order_id,
      'trigger_order_items_cancelled'
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS order_items_after_cancelled_try_empty_order ON public.order_items;
CREATE TRIGGER order_items_after_cancelled_try_empty_order
  AFTER INSERT OR UPDATE OF status ON public.order_items
  FOR EACH ROW
  EXECUTE PROCEDURE public.trg_order_items_cancelled_try_empty_order();

COMMENT ON FUNCTION public.trg_order_items_cancelled_try_empty_order() IS
  'Tras marcar un order_item cancelled, borra el pedido si order_eligible_for_empty_deletion (319).';

-- ---------------------------------------------------------------------------
-- 4) Backfill: pedidos sin ítems operacionales ni stock pendiente
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_oid uuid;
  v_deleted int := 0;
BEGIN
  FOR v_oid IN
    SELECT o.id
    FROM public.orders o
    WHERE o.status IN ('active', 'closing_soon', 'cancelled')
      AND coalesce(o.local_deferred_pickup, false) = false
      AND public.order_eligible_for_empty_deletion(o.id)
  LOOP
    IF coalesce(
      public.maint_try_delete_order_if_eligible(v_oid, '319_backfill_ghost_cancelled_orders'),
      false
    ) THEN
      v_deleted := v_deleted + 1;
    END IF;
  END LOOP;

  RAISE NOTICE '319: backfill deleted % ghost order(s)', v_deleted;
END $$;

SELECT pg_notify('pgrst', 'reload schema');
