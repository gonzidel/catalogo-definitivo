-- 365_color_offers_reprice_open_orders.sql
--
-- Regla de negocio (confirmada por el dueño 2026-10-02, caso A57481 /
-- MANATTINI, 740 Chocolate): si se carga o activa una oferta por color, los
-- pedidos abiertos que ya tenían ese producto/color pasan al precio de oferta.
--
-- Antes: order_items.price_snapshot quedaba congelado al agregar el ítem. El
-- PAU (recalculateOrderTotalWithOffersAndPromos) descontaba la oferta solo en
-- orders.total_amount, así que el panel de la clienta y el WhatsApp de cierre
-- (que suman líneas) mostraban otro total.
--
-- Alcance:
--   - Pedidos status active / closing_soon. Cerrados, enviados, etc. no se tocan.
--   - Se excluyen espejos de venta en local (notes.mirrored_from_local_order):
--     su precio sale de la venta del local, que tiene su propio registro.
--   - Solo ofertas por color (color_price_offers activa y en ventana, misma
--     selección que get_effective_price: la más reciente por producto+color).
--     Bajas del precio de lista no se aplican.
--   - Solo baja precios (price_snapshot > offer_price). Si la oferta termina
--     o sube, las líneas no vuelven a subir.
--   - Ítems cancelled, extras especiales (variant_id NULL) y devoluciones
--     (price_snapshot <= 0) quedan fuera.
--
-- Total: orders.total_amount baja en la diferencia de las líneas cobrables
-- (status <> missing). Si el total ya coincide con la nueva suma de líneas
-- (el PAU ya había descontado la oferta), no se toca.
-- Pedidos con ítems missing y total por encima de la suma cobrable (extras /
-- envío en notes) se saltean: trg_orders_total_exclude_missing volvería a
-- restar los missing. Se informan en skipped_orders para revisión manual.
--
-- Disparo:
--   - Trigger AFTER INSERT/UPDATE en color_price_offers (oferta activa).
--   - Cron diario 00:05 UTC: ofertas con start_date futura entran en vigencia
--     cuando cambia CURRENT_DATE (UTC), igual que get_effective_price.
--
-- Rollback: 365_ROLLBACK_color_offers_reprice_open_orders.sql
-- Tests: 365_color_offers_reprice_open_orders_tests.sql

CREATE OR REPLACE FUNCTION public.fn_apply_color_offers_to_open_orders(
  p_product_id uuid DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  r record;
  v_lines int := 0;
  v_orders int := 0;
  v_skipped uuid[] := '{}';
  v_old_charged numeric;
  v_new_charged numeric;
  v_missing numeric;
  v_delta numeric;
  v_total numeric;
  v_target numeric;
  v_updated int;
BEGIN
  FOR r IN
    WITH offer AS (
      SELECT DISTINCT ON (cpo.product_id, cpo.color)
             cpo.product_id, cpo.color, cpo.offer_price
        FROM public.color_price_offers cpo
       WHERE cpo.status = 'active'
         AND CURRENT_DATE >= cpo.start_date
         AND CURRENT_DATE <= cpo.end_date
         AND coalesce(cpo.offer_price, 0) > 0
         AND (p_product_id IS NULL OR cpo.product_id = p_product_id)
       ORDER BY cpo.product_id, cpo.color, cpo.created_at DESC
    )
    SELECT oi.order_id,
           array_agg(oi.id) AS item_ids,
           array_agg(offer.offer_price) AS new_prices
      FROM public.order_items oi
      JOIN public.orders o ON o.id = oi.order_id
      JOIN public.product_variants pv ON pv.id = oi.variant_id
      JOIN offer ON offer.product_id = pv.product_id AND offer.color = pv.color
     WHERE o.status IN ('active', 'closing_soon')
       AND NOT (
         CASE WHEN o.notes IS JSON OBJECT
              THEN coalesce((o.notes::jsonb ->> 'mirrored_from_local_order')::boolean, false)
              ELSE false
         END
       )
       AND lower(trim(coalesce(oi.status, ''))) <> 'cancelled'
       AND coalesce(oi.price_snapshot, 0) > offer.offer_price
     GROUP BY oi.order_id
  LOOP
    SELECT o.total_amount INTO v_total
      FROM public.orders o
     WHERE o.id = r.order_id
       FOR UPDATE;

    SELECT coalesce(sum(oi.quantity * coalesce(oi.price_snapshot, 0)), 0)
      INTO v_old_charged
      FROM public.order_items oi
     WHERE oi.order_id = r.order_id
       AND lower(trim(coalesce(oi.status, ''))) NOT IN ('cancelled', 'missing');

    SELECT coalesce(sum(oi.quantity * coalesce(oi.price_snapshot, 0)), 0)
      INTO v_missing
      FROM public.order_items oi
     WHERE oi.order_id = r.order_id
       AND lower(trim(coalesce(oi.status, ''))) = 'missing';

    SELECT coalesce(sum(
             oi.quantity * (coalesce(oi.price_snapshot, 0) - u.new_price)
           ), 0)
      INTO v_delta
      FROM unnest(r.item_ids, r.new_prices) AS u(item_id, new_price)
      JOIN public.order_items oi ON oi.id = u.item_id
     WHERE lower(trim(coalesce(oi.status, ''))) NOT IN ('cancelled', 'missing')
       AND oi.price_snapshot > u.new_price;

    v_new_charged := v_old_charged - v_delta;

    IF abs(coalesce(v_total, 0) - v_new_charged) < 0.02 THEN
      v_target := v_total;
    ELSE
      v_target := greatest(0, coalesce(v_total, 0) - v_delta);
    END IF;

    IF v_missing > 0 AND v_target > v_new_charged + 0.02 THEN
      v_skipped := v_skipped || r.order_id;
      CONTINUE;
    END IF;

    UPDATE public.order_items oi
       SET price_snapshot = u.new_price,
           updated_at = now()
      FROM unnest(r.item_ids, r.new_prices) AS u(item_id, new_price)
     WHERE oi.id = u.item_id
       AND oi.price_snapshot > u.new_price;
    GET DIAGNOSTICS v_updated = ROW_COUNT;

    IF v_updated = 0 THEN
      CONTINUE;
    END IF;

    IF v_target IS DISTINCT FROM v_total THEN
      UPDATE public.orders
         SET total_amount = v_target,
             updated_at = now()
       WHERE id = r.order_id;
    END IF;

    v_lines := v_lines + v_updated;
    v_orders := v_orders + 1;
  END LOOP;

  IF array_length(v_skipped, 1) > 0 THEN
    RAISE LOG 'fn_apply_color_offers_to_open_orders: pedidos salteados (missing + extras): %', v_skipped;
  END IF;

  RETURN json_build_object(
    'ok', true,
    'lines_updated', v_lines,
    'orders_updated', v_orders,
    'skipped_orders', to_json(v_skipped)
  );
END;
$function$;

COMMENT ON FUNCTION public.fn_apply_color_offers_to_open_orders(uuid) IS
  'canonical:365 | Aplica ofertas por color vigentes a líneas de pedidos active/closing_soon (solo baja precio, excluye espejos de venta local) y ajusta total_amount.';

CREATE OR REPLACE FUNCTION public.trg_color_offers_reprice_open_orders()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  PERFORM public.fn_apply_color_offers_to_open_orders(NEW.product_id);
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS trg_color_offers_reprice_open_orders ON public.color_price_offers;
CREATE TRIGGER trg_color_offers_reprice_open_orders
  AFTER INSERT OR UPDATE OF status, offer_price, start_date, end_date, color, product_id
  ON public.color_price_offers
  FOR EACH ROW
  WHEN (NEW.status = 'active')
  EXECUTE FUNCTION public.trg_color_offers_reprice_open_orders();

REVOKE ALL ON FUNCTION public.fn_apply_color_offers_to_open_orders(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_apply_color_offers_to_open_orders(uuid) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_apply_color_offers_to_open_orders(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.trg_color_offers_reprice_open_orders() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.trg_color_offers_reprice_open_orders() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.trg_color_offers_reprice_open_orders() FROM anon;

DO $$
BEGIN
  PERFORM cron.unschedule('color-offers-reprice-open-orders');
EXCEPTION
  WHEN OTHERS THEN
    NULL;
END $$;

SELECT cron.schedule(
  'color-offers-reprice-open-orders',
  '5 0 * * *',
  $$SELECT public.fn_apply_color_offers_to_open_orders(NULL);$$
);
