-- 188_order_reserved_qty_release_on_final_status.sql
--
-- Objetivo: al pasar un pedido a estado final excluido por vw_stock_audit_reserved_qty_diff
-- (sent, expired, devolución), restar de product_variants.reserved_qty la suma de
-- order_item_stock_sources.qty por variante, sin tocar stock físico ni borrar fuentes.
--
-- Idempotencia: tabla order_reserved_qty_released (PK = order_id); una sola liberación por pedido.
--
-- Caso especial — rpc_orders_daily_maintenance (147 / 123):
--   Ese flujo puede poner order_item_stock_sources.qty = 0 y borrar filas ANTES de
--   marcar orders.status = 'expired'. En ese escenario el trigger verá suma 0 y no
--   bajará reserved_qty; el drift puede persistir hasta rpc_reconcile_stock(true) o
--   hasta una migración que invoque la misma lógica ANTES de vaciar fuentes, o que
--   alinee el bloque reserved_qty += de 147 con este modelo. No se corrige 147 aquí.
--
-- UP: crea tabla, función, trigger.
-- DOWN: ver sección al final del archivo (ejecutar manualmente si hace falta rollback).

-- =============================================================================
-- 1) Tabla ledger
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.order_reserved_qty_released (
  order_id    uuid PRIMARY KEY
    REFERENCES public.orders (id) ON DELETE CASCADE,
  released_at timestamptz NOT NULL DEFAULT now(),
  old_status  text,
  new_status  text
);

COMMENT ON TABLE public.order_reserved_qty_released IS
  'Ledger idempotente: un pedido solo libera product_variants.reserved_qty una vez al pasar a estado final (sent/expired/devolución). Ver función release_reserved_qty_for_order.';

COMMENT ON COLUMN public.order_reserved_qty_released.order_id IS
  'Pedido procesado; PK impide doble liberación.';

COMMENT ON COLUMN public.order_reserved_qty_released.old_status IS
  'Estado previo a la transición que disparó la liberación.';

COMMENT ON COLUMN public.order_reserved_qty_released.new_status IS
  'Estado final (sent, expired, devolución).';

CREATE INDEX IF NOT EXISTS idx_order_reserved_qty_released_released_at
  ON public.order_reserved_qty_released (released_at DESC);

-- Solo escritura vía función SECURITY DEFINER / mantenimiento; no exponer a PostgREST indiscriminadamente.
REVOKE ALL ON TABLE public.order_reserved_qty_released FROM PUBLIC;
GRANT SELECT ON TABLE public.order_reserved_qty_released TO service_role;

-- =============================================================================
-- 2) Función interna (invocada solo desde el trigger; sin GRANT a authenticated)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.release_reserved_qty_for_order(
  p_order_id   uuid,
  p_old_status text,
  p_new_status text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_inserted int;
  rec record;
BEGIN
  IF p_order_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.order_reserved_qty_released (order_id, old_status, new_status)
  VALUES (p_order_id, p_old_status, p_new_status)
  ON CONFLICT (order_id) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    RETURN;
  END IF;

  FOR rec IN
    SELECT
      oi.variant_id,
      SUM(COALESCE(s.qty, 0))::int AS units
    FROM public.order_items oi
    INNER JOIN public.order_item_stock_sources s ON s.order_item_id = oi.id
    WHERE oi.order_id = p_order_id
      AND oi.variant_id IS NOT NULL
      AND COALESCE(s.qty, 0) > 0
      AND COALESCE(oi.status, '') <> 'cancelled'
    GROUP BY oi.variant_id
    ORDER BY oi.variant_id
  LOOP
    IF rec.units IS NULL OR rec.units <= 0 THEN
      CONTINUE;
    END IF;

    UPDATE public.product_variants pv
    SET
      reserved_qty = GREATEST(COALESCE(pv.reserved_qty, 0) - rec.units, 0)
    WHERE pv.id = rec.variant_id;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.release_reserved_qty_for_order(uuid, text, text) IS
  'Interna: libera reserved_qty por variante según SUM(order_item_stock_sources.qty) del pedido. Idempotente vía order_reserved_qty_released. No modifica almacenes ni oiss.';

REVOKE ALL ON FUNCTION public.release_reserved_qty_for_order(uuid, text, text) FROM PUBLIC;

-- =============================================================================
-- 3) Trigger AFTER UPDATE OF status
-- =============================================================================

CREATE OR REPLACE FUNCTION public.trgfn_orders_release_reserved_qty_on_final_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status IN ('sent', 'expired', 'devolución')
     AND OLD.status NOT IN ('sent', 'expired', 'devolución')
  THEN
    PERFORM public.release_reserved_qty_for_order(NEW.id, OLD.status::text, NEW.status::text);
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.trgfn_orders_release_reserved_qty_on_final_status() IS
  'Dispara release_reserved_qty_for_order en transición a estado final desde estado no final.';

REVOKE ALL ON FUNCTION public.trgfn_orders_release_reserved_qty_on_final_status() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_orders_release_reserved_qty_on_final_status ON public.orders;

CREATE TRIGGER trg_orders_release_reserved_qty_on_final_status
  AFTER UPDATE OF status ON public.orders
  FOR EACH ROW
  WHEN (
    NEW.status IN ('sent', 'expired', 'devolución')
    AND OLD.status IS DISTINCT FROM NEW.status
    AND OLD.status NOT IN ('sent', 'expired', 'devolución')
  )
  EXECUTE FUNCTION public.trgfn_orders_release_reserved_qty_on_final_status();

SELECT pg_notify('pgrst', 'reload schema');

-- =============================================================================
-- VERIFICACIÓN POST-DEPLOY (ejecutar manualmente en SQL Editor)
-- =============================================================================
--
-- 1) Objeto existe:
--    SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename='order_reserved_qty_released';
--    SELECT proname FROM pg_proc WHERE proname IN ('release_reserved_qty_for_order','trgfn_orders_release_reserved_qty_on_final_status');
--    SELECT tgname FROM pg_trigger WHERE tgname='trg_orders_release_reserved_qty_on_final_status';
--
-- 2) Tras marcar un pedido cerrado como sent (entorno de prueba), comprobar ledger:
--    SELECT * FROM order_reserved_qty_released ORDER BY released_at DESC LIMIT 20;
--
-- 3) Salud auditoría (debe bajar con el tiempo el inflado si el flujo sent tiene oiss):
--    SELECT count(*) FROM vw_stock_audit_reserved_qty_diff WHERE anomaly_type='reserved_qty_inflated';
--
-- 4) Pedidos sent con fuentes > 0 (snapshot operativo; debería decrecer para pedidos NUEVOS enviados post-deploy):
--    SELECT count(*) FROM orders o
--    WHERE o.status='sent' AND EXISTS (
--      SELECT 1 FROM order_items oi
--      JOIN order_item_stock_sources s ON s.order_item_id=oi.id
--      WHERE oi.order_id=o.id AND coalesce(s.qty,0)>0
--    );

-- =============================================================================
-- PLAN DE BACKFILL (ejecutar aparte, en ventana acordada; NO incluido en este script)
-- =============================================================================
--
-- Contexto: hay pedidos ya en sent/expired/devolución con oiss.qty>0 que nunca pasaron
-- por este trigger (ej. 227 pedidos sent / 558 unidades al momento del diagnóstico).
--
-- Opciones (elegir UNA estrategia con el equipo):
--
-- A) Correr rpc_reconcile_stock(true) una vez post-deploy para alinear reserved_qty con
--    la vista (incluye histórico y casos 147).
--
-- B) Backfill dirigido: para cada pedido final con oiss>0 sin fila en ledger, INSERT en
--    order_reserved_qty_released y llamar release_reserved_qty_for_order(id, '<estimado>', status)
--    — arriesga desalinear old_status; preferir solo si se documenta.
--
-- C) Insertar solo en ledger los order_id ya "corregidos" por reconcile para evitar
--    doble descuento si alguien re-ejecuta lógica manual.
--
-- Nunca borrar order_item_stock_sources en el backfill.

-- =============================================================================
-- ROLLBACK / DOWN (ejecutar manualmente si se revierte la migración)
-- =============================================================================
--
-- DROP TRIGGER IF EXISTS trg_orders_release_reserved_qty_on_final_status ON public.orders;
-- DROP FUNCTION IF EXISTS public.trgfn_orders_release_reserved_qty_on_final_status();
-- DROP FUNCTION IF EXISTS public.release_reserved_qty_for_order(uuid, text, text);
-- DROP TABLE IF EXISTS public.order_reserved_qty_released CASCADE;
-- SELECT pg_notify('pgrst', 'reload schema');
