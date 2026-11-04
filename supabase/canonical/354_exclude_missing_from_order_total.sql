-- 354_exclude_missing_from_order_total.sql
--
-- Caso A57282 (Analia Uro): RT Gris marcado missing seguía sumando en
-- orders.total_amount al cerrar ($118.800 vs $107.800 reales).
--
-- Reglas:
-- 1) Al marcar sin stock (rpc_admin_mark_item_missing): restar la línea del total
--    (paridad con rpc_remove_missing_order_item).
-- 2) Al cerrar (rpc_close_order): red de seguridad que excluye missing del total
--    sin doble-resta si ya se descontó al marcar, y sin romper promos.
-- 3) Checkout: al recalcular total ignora status=missing (además de cancelled).
--
-- NO APLICAR en producción sin aprobación explícita.

-- =============================================================================
-- Helper: excluir missing del total (idempotente / promo-safe)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_orders_exclude_missing_from_total(p_order_id uuid)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_total numeric := 0;
  v_sum_incl numeric := 0;
  v_sum_excl numeric := 0;
  v_missing numeric := 0;
  v_new numeric := 0;
BEGIN
  SELECT coalesce(o.total_amount, 0)
  INTO v_total
  FROM public.orders o
  WHERE o.id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pedido no encontrado';
  END IF;

  SELECT coalesce(sum(oi.quantity * coalesce(oi.price_snapshot, 0)), 0)
  INTO v_sum_incl
  FROM public.order_items oi
  WHERE oi.order_id = p_order_id
    AND lower(trim(coalesce(oi.status, ''))) <> 'cancelled';

  SELECT coalesce(sum(oi.quantity * coalesce(oi.price_snapshot, 0)), 0)
  INTO v_sum_excl
  FROM public.order_items oi
  WHERE oi.order_id = p_order_id
    AND lower(trim(coalesce(oi.status, ''))) NOT IN ('cancelled', 'missing');

  v_missing := v_sum_incl - v_sum_excl;
  IF v_missing <= 0 THEN
    RETURN v_total;
  END IF;

  -- Ya descontado al marcar missing (con o sin promo residual chica).
  IF abs(v_total - v_sum_excl) < 0.02 THEN
    RETURN v_total;
  END IF;

  -- Total todavía incluye las líneas missing (exacto o con promo).
  IF abs(v_total - v_sum_incl) < 0.02 OR v_total > (v_sum_excl + 0.02) THEN
    v_new := greatest(0, v_total - v_missing);
    UPDATE public.orders
    SET total_amount = v_new,
        updated_at = now()
    WHERE id = p_order_id;
    RETURN v_new;
  END IF;

  RETURN v_total;
END;
$function$;

COMMENT ON FUNCTION public.fn_orders_exclude_missing_from_total(uuid) IS
  'canonical:354 | Resta del total las líneas missing si todavía están incluidas. Idempotente si ya se descontaron al marcar sin stock.';

REVOKE ALL ON FUNCTION public.fn_orders_exclude_missing_from_total(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_orders_exclude_missing_from_total(uuid) TO service_role;

-- =============================================================================
-- rpc_admin_mark_item_missing: baja total al pasar a missing
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_admin_mark_item_missing(p_item_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_uid uuid;
  v_item public.order_items%rowtype;
  v_product_id uuid;
  v_size_norm text;
  v_src record;
  v_row record;
  v_before int;
  v_qty_released int := 0;
  v_prev_status text;
  v_line_total numeric := 0;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = v_uid) THEN
    RAISE EXCEPTION 'Solo administradores pueden marcar un producto sin stock';
  END IF;

  SELECT * INTO v_item FROM public.order_items WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ítem no encontrado';
  END IF;

  v_prev_status := lower(trim(coalesce(v_item.status, '')));

  IF v_prev_status = 'cancelled' THEN
    RAISE EXCEPTION 'Este ítem ya está cancelado';
  END IF;

  IF v_item.variant_id IS NOT NULL THEN
    SELECT pv.product_id INTO v_product_id FROM public.product_variants pv WHERE pv.id = v_item.variant_id;
  END IF;

  v_size_norm := trim(coalesce(v_item.size::text, ''));
  IF v_size_norm = '' THEN
    v_size_norm := NULL;
  ELSIF v_size_norm ~ '^\d+(\.\d+)?$' THEN
    v_size_norm := split_part(v_size_norm, '.', 1);
  END IF;

  FOR v_src IN
    SELECT warehouse_id, greatest(coalesce(qty, 0), 0) AS qty
    FROM public.order_item_stock_sources
    WHERE order_item_id = p_item_id
  LOOP
    IF coalesce(v_src.qty, 0) <= 0 THEN
      CONTINUE;
    END IF;

    v_before := 0;
    IF v_item.variant_id IS NOT NULL THEN
      FOR v_row IN
        SELECT vsws.size, vsws.stock_qty
        FROM public.variant_size_warehouse_stock vsws
        WHERE vsws.variant_id = v_item.variant_id
          AND vsws.warehouse_id = v_src.warehouse_id
      LOOP
        IF trim(coalesce(v_row.size::text, '')) IS NOT DISTINCT FROM v_size_norm THEN
          v_before := coalesce(v_row.stock_qty, 0);
          EXIT;
        END IF;
      END LOOP;
    END IF;

    IF v_product_id IS NOT NULL THEN
      PERFORM public.log_stock_change(
        v_product_id, v_item.variant_id, v_size_norm, v_src.warehouse_id,
        'sin_stock_baja', v_before, v_before, NULL, NULL,
        format(
          'Marcado sin stock (Kanban): baja de reserva sin reingresar. order_item=%s',
          p_item_id
        )
      );
    END IF;

    v_qty_released := v_qty_released + v_src.qty;
  END LOOP;

  DELETE FROM public.order_item_stock_sources WHERE order_item_id = p_item_id;

  IF v_item.variant_id IS NOT NULL AND v_qty_released > 0 THEN
    UPDATE public.product_variants
    SET reserved_qty = greatest(coalesce(reserved_qty, 0) - v_qty_released, 0)
    WHERE id = v_item.variant_id;
  END IF;

  UPDATE public.order_items
  SET status = 'missing', checked_by = v_uid, checked_at = now(), updated_at = now()
  WHERE id = p_item_id;

  -- 354: no facturar un ítem sin stock. Solo al pasar a missing (no idempotente doble).
  IF v_prev_status IS DISTINCT FROM 'missing' THEN
    v_line_total := coalesce(v_item.quantity, 0)::numeric * coalesce(v_item.price_snapshot, 0);
    IF v_line_total > 0 AND v_item.order_id IS NOT NULL THEN
      UPDATE public.orders
      SET
        total_amount = greatest(coalesce(total_amount, 0) - v_line_total, 0),
        updated_at = now()
      WHERE id = v_item.order_id;
    END IF;
  END IF;

  RETURN json_build_object(
    'ok', true,
    'item_id', p_item_id,
    'qty_written_off', v_qty_released,
    'total_reduced_by', coalesce(v_line_total, 0)
  );
END;
$function$;

COMMENT ON FUNCTION public.rpc_admin_mark_item_missing(uuid) IS
  'canonical:354 | Marca ítem sin stock (writeoff reserva) y resta su línea de orders.total_amount.';

-- =============================================================================
-- rpc_close_order: red de seguridad missing + pago por transporte (351)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_close_order(
  p_order_id uuid,
  p_payment_method text DEFAULT NULL::text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_customer_id uuid;
  v_is_admin boolean;
  v_status text;
  v_dismantle_at timestamptz;
  v_pending_count int;
  v_payment_method text;
BEGIN
  SELECT EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()) INTO v_is_admin;

  SELECT customer_id, status, dismantle_at
  INTO v_customer_id, v_status, v_dismantle_at
  FROM public.orders
  WHERE id = p_order_id;

  IF v_customer_id IS NULL THEN
    RAISE EXCEPTION 'Pedido no encontrado';
  END IF;

  IF v_status = 'expired' THEN
    RAISE EXCEPTION 'Pedido vencido';
  END IF;

  IF v_dismantle_at IS NOT NULL AND now() >= v_dismantle_at THEN
    RAISE EXCEPTION 'Pedido vencido';
  END IF;

  IF NOT v_is_admin AND v_customer_id != auth.uid() THEN
    RAISE EXCEPTION 'No tienes permiso para cerrar este pedido';
  END IF;

  SELECT count(*)
  INTO v_pending_count
  FROM public.order_items
  WHERE order_id = p_order_id
    AND status IN ('reserved', 'waiting', 'awaiting_apartado');

  IF v_pending_count > 0 THEN
    RAISE EXCEPTION 'No se puede cerrar: hay % ítem(s) todavía reservado(s) o en espera', v_pending_count;
  END IF;

  -- 354: asegurar que líneas missing no queden facturadas (A57282).
  PERFORM public.fn_orders_exclude_missing_from_total(p_order_id);

  v_payment_method := public.fn_resolve_order_close_payment_method(
    p_order_id,
    p_payment_method
  );

  UPDATE public.orders
  SET status = 'closed',
      payment_method = v_payment_method,
      closed_at = now(),
      updated_at = now()
  WHERE id = p_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No se pudo cerrar el pedido.';
  END IF;

  PERFORM public.rpc_enqueue_customer_closed_notifications(p_order_id);
END;
$function$;

COMMENT ON FUNCTION public.rpc_close_order(uuid, text) IS
  'canonical:354 | Cierra pedido; excluye missing del total (354); pago por transporte (351).';

-- =============================================================================
-- Trigger: cualquier UPDATE de total_amount (p.ej. rpc_checkout_cart) no puede
-- reintroducir líneas missing en el monto facturable.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.trg_orders_total_exclude_missing()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_sum_incl numeric := 0;
  v_sum_excl numeric := 0;
  v_missing numeric := 0;
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;
  IF NEW.total_amount IS NOT DISTINCT FROM OLD.total_amount THEN
    RETURN NEW;
  END IF;

  SELECT coalesce(sum(oi.quantity * coalesce(oi.price_snapshot, 0)), 0)
  INTO v_sum_incl
  FROM public.order_items oi
  WHERE oi.order_id = NEW.id
    AND lower(trim(coalesce(oi.status, ''))) <> 'cancelled';

  SELECT coalesce(sum(oi.quantity * coalesce(oi.price_snapshot, 0)), 0)
  INTO v_sum_excl
  FROM public.order_items oi
  WHERE oi.order_id = NEW.id
    AND lower(trim(coalesce(oi.status, ''))) NOT IN ('cancelled', 'missing');

  v_missing := v_sum_incl - v_sum_excl;
  IF v_missing <= 0 THEN
    RETURN NEW;
  END IF;

  IF abs(coalesce(NEW.total_amount, 0) - v_sum_excl) < 0.02 THEN
    RETURN NEW;
  END IF;

  IF abs(coalesce(NEW.total_amount, 0) - v_sum_incl) < 0.02
     OR coalesce(NEW.total_amount, 0) > (v_sum_excl + 0.02) THEN
    NEW.total_amount := greatest(0, coalesce(NEW.total_amount, 0) - v_missing);
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_orders_total_exclude_missing ON public.orders;
CREATE TRIGGER trg_orders_total_exclude_missing
  BEFORE UPDATE OF total_amount ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_orders_total_exclude_missing();

COMMENT ON FUNCTION public.trg_orders_total_exclude_missing() IS
  'canonical:354 | BEFORE UPDATE total_amount: saca líneas missing del monto (cubre checkout).';

SELECT pg_notify('pgrst', 'reload schema');
