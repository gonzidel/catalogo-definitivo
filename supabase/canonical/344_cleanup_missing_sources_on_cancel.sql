-- 344_cleanup_missing_sources_on_cancel.sql
--
-- BUG REAL (2026-09-16, A57074 / Dahiana Eren, GLE Negro T.38):
-- un item marcado "missing" podia conservar order_item_stock_sources de una
-- reserva anterior. Cuando la clienta lo cancelaba, la migracion 340 veia
-- sources qty > 0 y enviaba el pedido a Cancelados, como si hubiera una pieza
-- fisica pendiente de devolver. Confirmar con el check podia crear stock
-- fantasma.
--
-- No se puede usar admin_confirmed_missing como criterio general porque tambien
-- identifica altas manuales picked con stock fisico real (A56782/A56807).
-- La unica señal no ambigua es la transicion OLD.status=missing ->
-- NEW.status=cancelled. En esa transicion las fuentes son necesariamente
-- obsoletas: "missing" significa que no existe una unidad fisica para devolver.
--
-- Fix defensivo de backend:
--   1. guarda cancelled_from_status al cancelar para distinguir sin ambiguedad
--      missing de picked manual;
--   2. antes de completar missing -> cancelled registra cada fuente como
--      writeoff_missing con delta 0 y la elimina sin sumar stock;
--   3. no toca reserved_qty: una fuente obsoleta no permite saber si esa
--      reserva ya fue liberada, y recalcular mientras el carrito cambia en
--      paralelo podria pisar reservas legitimas;
--   4. la clasificacion SQL y frontend ignora fuentes de cancelled_from_status
--      = missing, incluso si un writer concurrente llegara tarde.
--
-- Esto cubre rpc_cancel_order_item, rpc_cancel_order_item_units (cancelacion
-- total) y cualquier otro caller futuro que haga la misma transicion.
-- Las altas manuales pasan de picked -> cancelled y no entran en este trigger.
--
-- Riesgo: bajo. No incrementa stock_qty. Solo actua sobre una transicion exacta.
-- Rollback: 344_ROLLBACK_cleanup_missing_sources_on_cancel.sql.

ALTER TABLE public.order_items
  ADD COLUMN IF NOT EXISTS cancelled_from_status text;

COMMENT ON COLUMN public.order_items.cancelled_from_status IS
  '344: status anterior cuando una fila pasa a cancelled; distingue missing real de altas manuales picked.';

CREATE OR REPLACE FUNCTION public.cleanup_missing_order_item_sources(
  p_order_item_id uuid,
  p_reason text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_item public.order_items%rowtype;
  v_product_id uuid;
  v_size_norm text;
  v_src record;
  v_stock_before integer;
  v_deleted integer := 0;
BEGIN
  SELECT *
  INTO v_item
  FROM public.order_items
  WHERE id = p_order_item_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  IF v_item.variant_id IS NOT NULL THEN
    SELECT pv.product_id
    INTO v_product_id
    FROM public.product_variants pv
    WHERE pv.id = v_item.variant_id
    FOR UPDATE;
  END IF;

  v_size_norm := trim(coalesce(v_item.size::text, ''));
  IF v_size_norm = '' THEN
    v_size_norm := NULL;
  ELSIF v_size_norm ~ '^\d+(\.\d+)?$' THEN
    v_size_norm := split_part(v_size_norm, '.', 1);
  END IF;

  FOR v_src IN
    SELECT
      s.id,
      s.warehouse_id,
      greatest(coalesce(s.qty, 0), 0)::integer AS qty
    FROM public.order_item_stock_sources s
    WHERE s.order_item_id = p_order_item_id
    ORDER BY s.id
    FOR UPDATE
  LOOP
    IF v_src.qty > 0 THEN
      v_stock_before := 0;

      IF v_item.variant_id IS NOT NULL AND v_size_norm IS NOT NULL THEN
        SELECT coalesce(vsws.stock_qty, 0)
        INTO v_stock_before
        FROM public.variant_size_warehouse_stock vsws
        WHERE vsws.variant_id = v_item.variant_id
          AND vsws.warehouse_id = v_src.warehouse_id
          AND trim(coalesce(vsws.size::text, '')) = trim(coalesce(v_item.size::text, ''))
        LIMIT 1;
      ELSIF v_item.variant_id IS NOT NULL THEN
        SELECT coalesce(vws.stock_qty, 0)
        INTO v_stock_before
        FROM public.variant_warehouse_stock vws
        WHERE vws.variant_id = v_item.variant_id
          AND vws.warehouse_id = v_src.warehouse_id
        LIMIT 1;
      END IF;

      v_stock_before := coalesce(v_stock_before, 0);

      INSERT INTO public.stock_history (
        product_id,
        variant_id,
        size,
        warehouse_id,
        change_type,
        stock_before,
        stock_after,
        quantity_changed,
        user_id,
        notes
      )
      VALUES (
        v_product_id,
        v_item.variant_id,
        v_size_norm,
        v_src.warehouse_id,
        'writeoff_missing',
        v_stock_before,
        v_stock_before,
        0,
        auth.uid(),
        format(
          '344 %s: fuente obsoleta eliminada sin devolver stock, order_item=%s source=%s qty=%s',
          coalesce(nullif(trim(p_reason), ''), 'missing'),
          p_order_item_id,
          v_src.id,
          v_src.qty
        )
      );
    END IF;
  END LOOP;

  DELETE FROM public.order_item_stock_sources
  WHERE order_item_id = p_order_item_id;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_cleanup_missing_sources_on_cancel()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  NEW.cancelled_from_status := lower(trim(coalesce(OLD.status, '')));

  IF NEW.cancelled_from_status = 'missing' THEN
    NEW.admin_confirmed_missing := true;
    PERFORM public.cleanup_missing_order_item_sources(
      OLD.id,
      'missing->cancelled'
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS order_items_before_missing_cancel_cleanup
  ON public.order_items;

CREATE TRIGGER order_items_before_missing_cancel_cleanup
  BEFORE UPDATE OF status ON public.order_items
  FOR EACH ROW
  WHEN (
    lower(trim(coalesce(OLD.status, '')))
      IS DISTINCT FROM lower(trim(coalesce(NEW.status, '')))
    AND lower(trim(coalesce(NEW.status, ''))) = 'cancelled'
  )
  EXECUTE PROCEDURE public.trg_cleanup_missing_sources_on_cancel();

CREATE OR REPLACE FUNCTION public.order_has_cancelled_items_pending_stock_return(
  p_order_id uuid
)
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
      AND lower(trim(coalesce(oi.cancelled_from_status, ''))) <> 'missing'
      AND greatest(coalesce(s.qty, 0), 0) > 0
  );
$$;

COMMENT ON FUNCTION public.trg_cleanup_missing_sources_on_cancel() IS
  '344: guarda cancelled_from_status y limpia fuentes si la transicion era missing->cancelled.';

COMMENT ON FUNCTION public.order_has_cancelled_items_pending_stock_return(uuid) IS
  '344: cancelled con fuentes pide devolucion salvo que cancelled_from_status=missing; conserva altas manuales picked.';

REVOKE ALL ON FUNCTION public.cleanup_missing_order_item_sources(uuid, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_cleanup_missing_sources_on_cancel()
  FROM PUBLIC;

SELECT pg_notify('pgrst', 'reload schema');
