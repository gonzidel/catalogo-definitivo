-- 365_color_offers_reprice_open_orders_tests.sql
-- Ejecutar SIEMPRE en transacción y descartar:
--   BEGIN;
--   \i 365_color_offers_reprice_open_orders_tests.sql
--   ROLLBACK;
-- Inserta una oferta de prueba sobre un ítem real de un pedido abierto y
-- verifica línea + total; también que cerrados y espejos de venta local no cambien.

DO $$
BEGIN
  IF has_function_privilege('authenticated', 'public.fn_apply_color_offers_to_open_orders(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_apply_color_offers_to_open_orders(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '365 FAIL: fn_apply_color_offers_to_open_orders ejecutable por authenticated/anon';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'color-offers-reprice-open-orders') THEN
    RAISE EXCEPTION '365 FAIL: falta el cron color-offers-reprice-open-orders';
  END IF;
  RAISE NOTICE '365 OK: privilegios y cron';
END $$;

DO $$
DECLARE
  v_item record;
  v_total_before numeric;
  v_total_after numeric;
  v_charged_before numeric;
  v_price_after numeric;
  v_offer numeric;
  v_closed_before numeric;
  v_closed_after numeric;
  v_closed_item uuid;
BEGIN
  SELECT oi.id, oi.order_id, oi.quantity, oi.price_snapshot, pv.product_id, pv.color
    INTO v_item
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    JOIN public.product_variants pv ON pv.id = oi.variant_id
   WHERE o.status IN ('active', 'closing_soon')
     AND NOT (o.notes IS JSON OBJECT AND coalesce((o.notes::jsonb ->> 'mirrored_from_local_order')::boolean, false))
     AND lower(coalesce(oi.status, '')) NOT IN ('cancelled', 'missing')
     AND oi.price_snapshot > 2000
     AND NOT EXISTS (
       SELECT 1 FROM public.order_items m
        WHERE m.order_id = oi.order_id AND lower(coalesce(m.status, '')) = 'missing'
     )
   LIMIT 1;

  IF v_item.id IS NULL THEN
    RAISE NOTICE '365 SKIP: no hay ítems elegibles en pedidos abiertos';
    RETURN;
  END IF;

  SELECT oi.id, oi.price_snapshot INTO v_closed_item, v_closed_before
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    JOIN public.product_variants pv ON pv.id = oi.variant_id
   WHERE o.status = 'closed'
     AND pv.product_id = v_item.product_id
     AND pv.color = v_item.color
     AND oi.price_snapshot > 1000
   LIMIT 1;

  SELECT total_amount INTO v_total_before FROM public.orders WHERE id = v_item.order_id;
  SELECT coalesce(sum(quantity * price_snapshot), 0) INTO v_charged_before
    FROM public.order_items
   WHERE order_id = v_item.order_id
     AND lower(coalesce(status, '')) NOT IN ('cancelled', 'missing');

  v_offer := v_item.price_snapshot - 1000;

  INSERT INTO public.color_price_offers (product_id, color, offer_price, status, start_date, end_date)
  VALUES (v_item.product_id, v_item.color, v_offer, 'active', CURRENT_DATE, CURRENT_DATE + 30);

  SELECT price_snapshot INTO v_price_after FROM public.order_items WHERE id = v_item.id;
  IF v_price_after <> v_offer THEN
    RAISE EXCEPTION '365 FAIL: línea esperaba %, quedó %', v_offer, v_price_after;
  END IF;

  SELECT total_amount INTO v_total_after FROM public.orders WHERE id = v_item.order_id;
  IF abs(v_total_before - v_charged_before) < 0.02 THEN
    IF v_total_after > v_total_before - 1000 * v_item.quantity + 0.02 THEN
      RAISE EXCEPTION '365 FAIL: total esperaba bajar al menos %, antes % después %',
        1000 * v_item.quantity, v_total_before, v_total_after;
    END IF;
  END IF;

  IF v_closed_item IS NOT NULL THEN
    SELECT price_snapshot INTO v_closed_after FROM public.order_items WHERE id = v_closed_item;
    IF v_closed_after <> v_closed_before THEN
      RAISE EXCEPTION '365 FAIL: se modificó un pedido cerrado (% -> %)', v_closed_before, v_closed_after;
    END IF;
  END IF;

  RAISE NOTICE '365 OK: línea % -> %, total % -> %', v_item.price_snapshot, v_price_after, v_total_before, v_total_after;
END $$;

-- Espejos de venta local: nunca se repricean.
DO $$
DECLARE
  v_result json;
  v_changed int;
BEGIN
  CREATE TEMP TABLE _365_mirror_before ON COMMIT DROP AS
  SELECT oi.id, oi.price_snapshot
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
   WHERE o.status IN ('active', 'closing_soon')
     AND o.notes IS JSON OBJECT
     AND coalesce((o.notes::jsonb ->> 'mirrored_from_local_order')::boolean, false);

  v_result := public.fn_apply_color_offers_to_open_orders(NULL);

  SELECT count(*) INTO v_changed
    FROM _365_mirror_before b
    JOIN public.order_items oi ON oi.id = b.id
   WHERE oi.price_snapshot IS DISTINCT FROM b.price_snapshot;
  IF v_changed > 0 THEN
    RAISE EXCEPTION '365 FAIL: se modificaron % líneas de espejos de venta local', v_changed;
  END IF;
  RAISE NOTICE '365 OK: espejos de venta local intactos; corrida completa %', v_result;
END $$;
