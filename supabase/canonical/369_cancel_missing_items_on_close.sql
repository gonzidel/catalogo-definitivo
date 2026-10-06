-- 369_cancel_missing_items_on_close.sql
--
-- NEGOCIO CONFIRMADO (2026-10-06): al cerrar un pedido, los productos marcados
-- sin stock se quitan automáticamente (pasan a 'cancelled'); no existen en el
-- pedido y no deben aparecer en cerrados ni sumar en el mensaje de cierre.
--
-- Caso: A57833 (Romina Fester). fyllocal01 marcó 3 productos sin stock antes
-- del cierre; rpc_close_stuck_customer_requested_orders cerró el pedido y el
-- aviso de la campana dijo $136.000 en vez de $102.700, porque
-- fn_compute_closed_order_products_total solo excluía 'cancelled'. Misma
-- situación en A57495, A57356, A57269 y A57666 (últimos 30 días).
--
-- Cambios:
--   1) Trigger AFTER UPDATE OF status en orders (-> 'closed'): cubre todos los
--      caminos de cierre (rpc_close_order, rpc_close_stuck_customer_requested_orders,
--      rpc_close_mirrored_retiro_from_local_order) y corre antes del aviso de
--      cierre, que cada camino llama después del UPDATE.
--      Para cada ítem 'missing':
--        * ajusta total_amount si todavía los incluía (fn_orders_exclude_missing_from_total);
--        * descuenta de reserved_qty las unidades de sus fuentes (la vista
--          vw_stock_audit_reserved_qty_diff espera reserved_qty = fuentes de
--          pedidos no enviados);
--        * status -> 'cancelled'. El trigger existente 344 marca
--          cancelled_from_status='missing' y borra las fuentes SIN devolver stock
--          (la unidad no existe), igual que cuando la clienta lo quita a mano.
--      No actúa si todos los ítems vigentes están sin stock: quitarlos dejaría el
--      pedido vacío y maint_try_delete_order_if_eligible lo borraría durante el
--      cierre (0 casos en 90 días).
--   2) fn_compute_closed_order_products_total excluye también 'missing' (aviso de
--      cierre COD/transferencia, Correo y paso a Pagado), por ítems marcados sin
--      stock después del cierre o en el caso de pedido todo sin stock.
--
-- Sin cambios de stock físico. Sin cambios en el NJ (el panel de la clienta ya
-- oculta los 'cancelled'; cerrados ya excluía 'missing').

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $guard$
BEGIN
  IF md5(pg_get_functiondef('public.fn_compute_closed_order_products_total(uuid)'::regprocedure))
     <> '9d021e3f9cc3b76024ab9a7bc0770242' THEN
    RAISE EXCEPTION '369: fn_compute_closed_order_products_total cambió desde la auditoría';
  END IF;
  IF md5(pg_get_functiondef('public.fn_orders_exclude_missing_from_total(uuid)'::regprocedure))
     <> 'ae8817ab5fcb7835678da067295158f9' THEN
    RAISE EXCEPTION '369: fn_orders_exclude_missing_from_total cambió desde la auditoría';
  END IF;
  IF md5(pg_get_functiondef('public.trg_cleanup_missing_sources_on_cancel()'::regprocedure))
     <> 'cb3b4e5cef4125791a40c8ec5b7a204f' THEN
    RAISE EXCEPTION '369: trg_cleanup_missing_sources_on_cancel cambió desde la auditoría';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.orders'::regclass
       AND tgname = 'trg_orders_cancel_missing_items_on_close'
  ) THEN
    RAISE EXCEPTION '369: el trigger ya existe';
  END IF;
END
$guard$;

-- ---------------------------------------------------------------------------
-- 1) Quitar productos sin stock al cerrar
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_cancel_missing_items_on_close(p_order_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_rec       record;
  v_cancelled integer := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.order_items oi
     WHERE oi.order_id = p_order_id
       AND lower(trim(coalesce(oi.status, ''))) = 'missing'
  ) THEN
    RETURN 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.order_items oi
     WHERE oi.order_id = p_order_id
       AND lower(trim(coalesce(oi.status, ''))) NOT IN ('missing', 'cancelled', 'expired')
  ) THEN
    RETURN 0;
  END IF;

  PERFORM public.fn_orders_exclude_missing_from_total(p_order_id);

  FOR v_rec IN
    SELECT oi.variant_id, sum(greatest(coalesce(s.qty, 0), 0))::integer AS units
      FROM public.order_items oi
      JOIN public.order_item_stock_sources s ON s.order_item_id = oi.id
     WHERE oi.order_id = p_order_id
       AND lower(trim(coalesce(oi.status, ''))) = 'missing'
       AND oi.variant_id IS NOT NULL
     GROUP BY oi.variant_id
     ORDER BY oi.variant_id
  LOOP
    IF v_rec.units > 0 THEN
      UPDATE public.product_variants pv
         SET reserved_qty = greatest(coalesce(pv.reserved_qty, 0) - v_rec.units, 0)
       WHERE pv.id = v_rec.variant_id;
    END IF;
  END LOOP;

  UPDATE public.order_items oi
     SET status = 'cancelled',
         updated_at = now()
   WHERE oi.order_id = p_order_id
     AND lower(trim(coalesce(oi.status, ''))) = 'missing';

  GET DIAGNOSTICS v_cancelled = ROW_COUNT;
  RETURN v_cancelled;
END
$function$;

COMMENT ON FUNCTION public.fn_cancel_missing_items_on_close(uuid) IS
  'canonical:369 — al cerrar, quita (cancelled) los ítems sin stock; no actúa si dejaría el pedido vacío.';

CREATE FUNCTION public.trgfn_orders_cancel_missing_items_on_close()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  PERFORM public.fn_cancel_missing_items_on_close(NEW.id);
  RETURN NULL;
END
$function$;

CREATE TRIGGER trg_orders_cancel_missing_items_on_close
  AFTER UPDATE OF status ON public.orders
  FOR EACH ROW
  WHEN (NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed')
  EXECUTE FUNCTION public.trgfn_orders_cancel_missing_items_on_close();

REVOKE EXECUTE ON FUNCTION public.fn_cancel_missing_items_on_close(uuid)         FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.trgfn_orders_cancel_missing_items_on_close()   FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2) Total del aviso de cierre sin productos sin stock
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_compute_closed_order_products_total(p_order_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_subtotal numeric := 0;
  v_notes jsonb;
  v_shipping numeric := 0;
  v_discount numeric := 0;
  v_extras numeric := 0;
  v_extras_pct numeric := 0;
BEGIN
  SELECT coalesce(sum((coalesce(oi.quantity, 0)::numeric * coalesce(oi.price_snapshot, 0)::numeric)), 0)
    INTO v_subtotal
    FROM public.order_items oi
   WHERE oi.order_id = p_order_id
     AND lower(trim(coalesce(oi.status, ''))) NOT IN ('cancelled', 'missing');

  SELECT coalesce(o.notes::jsonb, '{}'::jsonb)
    INTO v_notes
    FROM public.orders o
   WHERE o.id = p_order_id;

  v_shipping := coalesce((v_notes->>'shipping')::numeric, (v_notes->>'shipping_cost')::numeric, 0);
  v_discount := coalesce((v_notes->>'discount')::numeric, 0);
  v_extras := coalesce((v_notes->>'extras_amount')::numeric, (v_notes->>'extras')::numeric, 0);
  v_extras_pct := coalesce((v_notes->>'extras_percentage')::numeric, 0);

  RETURN greatest(0,
    v_subtotal + v_shipping - v_discount + v_extras + (v_subtotal * v_extras_pct / 100)
  );
END;
$function$;

COMMENT ON FUNCTION public.fn_compute_closed_order_products_total(uuid) IS
  'canonical:369 — total de productos para avisos de cierre; excluye cancelled y missing.';

COMMIT;
