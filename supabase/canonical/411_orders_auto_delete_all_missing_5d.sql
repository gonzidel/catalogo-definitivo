-- 411_orders_auto_delete_all_missing_5d.sql
--
-- REGLA (pedida por el dueño el 2026-11-20, caso A58953 / Gesica Croce):
-- un pedido normal en el que TODOS los ítems quedaron "sin stock" (missing) y la
-- clienta no agregó ni quitó nada se elimina solo a los 5 días de creado, en vez
-- de quedar colgado hasta el día 7 + 24 h de gracia.
--
-- Alcance (decidido por el dueño):
--   - Solo pedidos active / closing_soon, NO Retira Local diferido
--     (local_deferred_pickup = false; esos tienen otro circuito y quedan fuera).
--   - Solo si el pedido tiene >= 1 ítem y TODOS están en 'missing'.
--     Cualquier ítem reserved / waiting / picked / awaiting_apartado / cancelled /
--     expired hace que el pedido NO se toque. Los pedidos con stock real
--     (reserved / picked) quedan exactamente igual que hoy.
--   - 5 días desde orders.created_at.
--
-- Cómo borra (sin reimplementar nada):
--   1) cleanup_missing_order_item_sources(item, 'auto_all_missing_5d'): da de baja
--      las fuentes de stock SIN devolver stock (missing = no había producto físico);
--      deja fila 'writeoff_missing' con quantity_changed = 0 en stock_history (344).
--   2) UPDATE order_items SET status = 'cancelled': el trigger BEFORE (344) fija
--      cancelled_from_status = 'missing' y admin_confirmed_missing; trigger 356 no
--      toca el total (el missing ya lo había restado).
--   3) Al cancelar el último ítem, order_items_after_cancelled_try_empty_order
--      borra el pedido por el camino oficial y registra order_empty_deletion_audit.
--
-- Concurrencia: toma el pedido con FOR UPDATE SKIP LOCKED y re-chequea la condición
-- bajo lock; cada pedido va en su propio subbloque (un fallo no frena a los demás).
-- Idempotente: re-ejecutarla no hace nada sobre pedidos ya borrados.
--
-- p_dry_run = true: solo cuenta candidatos, no modifica nada.
--
-- Acceso: SECURITY DEFINER, solo service_role (el cron corre como postgres).
-- No se crean tablas, por lo que no hay GRANTs de Data API nuevos.
--
-- Riesgo: MEDIO (borra pedidos de clientas). Mitigado por alcance estricto,
-- dry-run previo y activación del cron en archivo aparte (411b).
-- Rollback: 411_ROLLBACK_orders_auto_delete_all_missing_5d.sql
--
-- NO APLICAR en producción sin aprobación explícita.

CREATE OR REPLACE FUNCTION public.rpc_orders_auto_delete_all_missing(
  p_batch integer DEFAULT 20,
  p_dry_run boolean DEFAULT false
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_order_id uuid;
  v_item_id uuid;
  v_count integer := 0;
  v_limit integer := greatest(coalesce(p_batch, 20), 1);
BEGIN
  FOR v_order_id IN
    SELECT o.id
    FROM public.orders o
    WHERE o.status IN ('active', 'closing_soon')
      AND coalesce(o.local_deferred_pickup, false) = false
      AND o.created_at <= now() - interval '5 days'
      AND EXISTS (
        SELECT 1 FROM public.order_items oi WHERE oi.order_id = o.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.order_items oi
        WHERE oi.order_id = o.id
          AND lower(trim(coalesce(oi.status, ''))) <> 'missing'
      )
    ORDER BY o.created_at, o.id
    LIMIT v_limit
  LOOP
    IF p_dry_run THEN
      v_count := v_count + 1;
      CONTINUE;
    END IF;

    BEGIN
      -- Re-chequeo bajo lock: si la clienta cambió algo en el medio, no se toca.
      PERFORM 1
      FROM public.orders o
      WHERE o.id = v_order_id
        AND o.status IN ('active', 'closing_soon')
        AND coalesce(o.local_deferred_pickup, false) = false
        AND o.created_at <= now() - interval '5 days'
      FOR UPDATE SKIP LOCKED;

      IF NOT FOUND THEN
        CONTINUE;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM public.order_items oi WHERE oi.order_id = v_order_id)
         OR EXISTS (
           SELECT 1
           FROM public.order_items oi
           WHERE oi.order_id = v_order_id
             AND lower(trim(coalesce(oi.status, ''))) <> 'missing'
         )
      THEN
        CONTINUE;
      END IF;

      FOR v_item_id IN
        SELECT oi.id
        FROM public.order_items oi
        WHERE oi.order_id = v_order_id
        ORDER BY oi.created_at, oi.id
        FOR UPDATE
      LOOP
        PERFORM public.cleanup_missing_order_item_sources(v_item_id, 'auto_all_missing_5d');

        UPDATE public.order_items
        SET status = 'cancelled'
        WHERE id = v_item_id;
      END LOOP;

      IF NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.id = v_order_id) THEN
        v_count := v_count + 1;
      ELSE
        -- No debería pasar: tras cancelar todos los ítems el pedido es elegible.
        RAISE EXCEPTION
          'rpc_orders_auto_delete_all_missing: el pedido % no se borró tras cancelar sus ítems',
          v_order_id;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- El subbloque se revierte solo; se registra y se sigue con el siguiente pedido.
      RAISE WARNING 'rpc_orders_auto_delete_all_missing: pedido % omitido (%)', v_order_id, SQLERRM;
    END;
  END LOOP;

  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.rpc_orders_auto_delete_all_missing(integer, boolean) IS
  '411: elimina pedidos normales (no Retira Local diferido) con TODOS los ítems missing a los 5 días de creados. Sin devolver stock (writeoff_missing). p_dry_run=true solo cuenta. Solo service_role / cron.';

REVOKE ALL ON FUNCTION public.rpc_orders_auto_delete_all_missing(integer, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_orders_auto_delete_all_missing(integer, boolean) TO service_role;

SELECT pg_notify('pgrst', 'reload schema');
