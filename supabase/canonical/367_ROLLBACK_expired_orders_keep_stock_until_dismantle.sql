-- 367_ROLLBACK_expired_orders_keep_stock_until_dismantle.sql
--
-- Restaura el comportamiento previo a 367: el cron reingresa stock al vencer y
-- el trigger 188 libera reserved_qty al pasar a 'expired'. Bodies copiados de
-- producción (pg_get_functiondef / pg_get_viewdef, 2026-10-03).
--
-- ANTES de ejecutar: los pedidos que vencieron con 367 activo siguen con
-- fuentes y reserved_qty. Desarmarlos primero desde la columna Vencido
-- (rpc_cancel_order_full los reingresa). Si quedan, tras el rollback dejan de
-- contarse como reserva (la auditoría los marcará reserved_qty_inflated) y
-- "Ya enviado" no les liberará reserved_qty.

BEGIN;

DO $warn$
DECLARE
  v_pending int;
BEGIN
  SELECT count(DISTINCT o.id) INTO v_pending
  FROM public.orders o
  JOIN public.order_items oi ON oi.order_id = o.id
  JOIN public.order_item_stock_sources s ON s.order_item_id = oi.id
  WHERE o.status = 'expired'
    AND coalesce(s.qty, 0) > 0;

  IF v_pending > 0 THEN
    RAISE WARNING '367 ROLLBACK: % pedido(s) vencidos con stock reservado sin desarmar', v_pending;
  END IF;
END
$warn$;

CREATE OR REPLACE FUNCTION public.rpc_orders_daily_maintenance()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_general_warehouse_id uuid;
  v_venta_warehouse_id uuid;
  v_legacy_fallback_count int := 0;
  v_expiring_order_ids uuid[];
BEGIN
  PERFORM public.fn_refresh_awaiting_apartado_availability(NULL);

  UPDATE public.orders o
  SET
    dismantle_at = coalesce(
      o.dismantle_at,
      (SELECT d.dismantle_at FROM public.fn_order_deadlines_for_customer(o.customer_id, o.created_at) d)
    ),
    expires_at = coalesce(
      o.expires_at,
      (SELECT d.expires_at FROM public.fn_order_deadlines_for_customer(o.customer_id, o.created_at) d)
    )
  WHERE o.status IN ('active','closing_soon')
    AND (o.expires_at IS NULL OR o.dismantle_at IS NULL)
    AND NOT (coalesce(o.local_deferred_pickup, false) = true AND o.dismantle_at IS NULL);

  UPDATE public.orders
  SET status = 'closing_soon'
  WHERE status = 'active'
    AND dismantle_at IS NOT NULL
    AND expires_at IS NOT NULL
    AND now() >= expires_at
    AND now() < dismantle_at;

  SELECT id INTO v_general_warehouse_id FROM public.warehouses WHERE code = 'general' LIMIT 1;
  SELECT id INTO v_venta_warehouse_id FROM public.warehouses WHERE code = 'venta-publico' LIMIT 1;

  SELECT coalesce(array_agg(o.id), '{}'::uuid[])
  INTO v_expiring_order_ids
  FROM public.orders o
  WHERE o.status IN ('active','closing_soon')
    AND o.dismantle_at IS NOT NULL
    AND (
      (coalesce(o.local_deferred_pickup, false) = true AND now() >= o.dismantle_at)
      OR
      (coalesce(o.local_deferred_pickup, false) = false AND now() >= o.dismantle_at + interval '24 hours')
    );

  PERFORM 1
  FROM public.order_items oi
  WHERE oi.order_id = ANY(v_expiring_order_ids)
    AND oi.status IN ('reserved','picked','waiting','missing','awaiting_apartado')
  FOR UPDATE OF oi;

  PERFORM 1
  FROM public.product_variants pv
  WHERE pv.id IN (
    SELECT DISTINCT oi.variant_id
    FROM public.order_items oi
    WHERE oi.order_id = ANY(v_expiring_order_ids)
      AND oi.status IN ('reserved','picked','waiting','missing','awaiting_apartado')
      AND oi.variant_id IS NOT NULL
  )
  ORDER BY pv.id
  FOR UPDATE;

  INSERT INTO public.variant_size_warehouse_stock (variant_id, warehouse_id, size, stock_qty, updated_at)
  SELECT x.variant_id, x.warehouse_id, x.size_normalized, SUM(x.qty)::int, now()
  FROM (
    SELECT
      oi.variant_id,
      s.warehouse_id,
      CASE
        WHEN trim(coalesce(oi.size::text, '')) ~ '^\d+(\.\d+)?$' THEN split_part(trim(coalesce(oi.size::text, '')), '.', 1)
        ELSE trim(coalesce(oi.size::text, ''))
      END AS size_normalized,
      greatest(coalesce(s.qty, 0), 0)::int AS qty
    FROM public.order_items oi
    JOIN public.order_item_stock_sources s ON s.order_item_id = oi.id
    WHERE oi.order_id = ANY(v_expiring_order_ids)
      AND oi.status IN ('reserved','picked','waiting','missing','awaiting_apartado')
      AND oi.variant_id IS NOT NULL
      AND greatest(coalesce(s.qty, 0), 0) > 0
  ) x
  WHERE x.size_normalized <> ''
  GROUP BY x.variant_id, x.warehouse_id, x.size_normalized
  ON CONFLICT (variant_id, warehouse_id, size) DO UPDATE
  SET stock_qty = public.variant_size_warehouse_stock.stock_qty + excluded.stock_qty,
      updated_at = now();

  INSERT INTO public.variant_warehouse_stock (variant_id, warehouse_id, stock_qty, updated_at)
  SELECT x.variant_id, x.warehouse_id, SUM(x.qty)::int, now()
  FROM (
    SELECT
      oi.variant_id,
      s.warehouse_id,
      CASE
        WHEN trim(coalesce(oi.size::text, '')) ~ '^\d+(\.\d+)?$' THEN split_part(trim(coalesce(oi.size::text, '')), '.', 1)
        ELSE trim(coalesce(oi.size::text, ''))
      END AS size_normalized,
      (
        exists (
          select 1
          from public.variant_size_warehouse_stock vsws
          where vsws.variant_id = oi.variant_id
          limit 1
        )
        or exists (
          select 1
          from public.variant_sizes vs
          where vs.variant_id = oi.variant_id
            and trim(coalesce(vs.size, '')) <> ''
          limit 1
        )
      ) AS has_size_model,
      greatest(coalesce(s.qty, 0), 0)::int AS qty
    FROM public.order_items oi
    JOIN public.order_item_stock_sources s ON s.order_item_id = oi.id
    WHERE oi.order_id = ANY(v_expiring_order_ids)
      AND oi.status IN ('reserved','picked','waiting','missing','awaiting_apartado')
      AND oi.variant_id IS NOT NULL
      AND greatest(coalesce(s.qty, 0), 0) > 0
  ) x
  WHERE x.size_normalized = ''
    AND x.has_size_model = false
  GROUP BY x.variant_id, x.warehouse_id
  ON CONFLICT (variant_id, warehouse_id) DO UPDATE
  SET stock_qty = public.variant_warehouse_stock.stock_qty + excluded.stock_qty,
      updated_at = now();

  INSERT INTO public.variant_size_warehouse_stock (variant_id, warehouse_id, size, stock_qty, updated_at)
  SELECT x.variant_id, x.warehouse_id, x.size_normalized, SUM(x.qty)::int, now()
  FROM (
    SELECT
      oi.variant_id,
      CASE
        WHEN oi.status = 'waiting' THEN v_venta_warehouse_id
        ELSE v_general_warehouse_id
      END AS warehouse_id,
      CASE
        WHEN trim(coalesce(oi.size::text, '')) ~ '^\d+(\.\d+)?$' THEN split_part(trim(coalesce(oi.size::text, '')), '.', 1)
        ELSE trim(coalesce(oi.size::text, ''))
      END AS size_normalized,
      greatest(coalesce(oi.quantity, 0), 0)::int AS qty
    FROM public.order_items oi
    WHERE oi.order_id = ANY(v_expiring_order_ids)
      AND oi.status IN ('reserved','waiting')
      AND oi.variant_id IS NOT NULL
      AND greatest(coalesce(oi.quantity, 0), 0) > 0
      AND NOT EXISTS (
        SELECT 1
        FROM public.order_item_stock_sources s
        WHERE s.order_item_id = oi.id
          AND greatest(coalesce(s.qty, 0), 0) > 0
      )
  ) x
  WHERE x.warehouse_id IS NOT NULL
    AND x.size_normalized <> ''
  GROUP BY x.variant_id, x.warehouse_id, x.size_normalized
  ON CONFLICT (variant_id, warehouse_id, size) DO UPDATE
  SET stock_qty = public.variant_size_warehouse_stock.stock_qty + excluded.stock_qty,
      updated_at = now();

  INSERT INTO public.variant_warehouse_stock (variant_id, warehouse_id, stock_qty, updated_at)
  SELECT x.variant_id, x.warehouse_id, SUM(x.qty)::int, now()
  FROM (
    SELECT
      oi.variant_id,
      CASE
        WHEN oi.status = 'waiting' THEN v_venta_warehouse_id
        ELSE v_general_warehouse_id
      END AS warehouse_id,
      CASE
        WHEN trim(coalesce(oi.size::text, '')) ~ '^\d+(\.\d+)?$' THEN split_part(trim(coalesce(oi.size::text, '')), '.', 1)
        ELSE trim(coalesce(oi.size::text, ''))
      END AS size_normalized,
      (
        exists (
          select 1
          from public.variant_size_warehouse_stock vsws
          where vsws.variant_id = oi.variant_id
          limit 1
        )
        or exists (
          select 1
          from public.variant_sizes vs
          where vs.variant_id = oi.variant_id
            and trim(coalesce(vs.size, '')) <> ''
          limit 1
        )
      ) AS has_size_model,
      greatest(coalesce(oi.quantity, 0), 0)::int AS qty
    FROM public.order_items oi
    WHERE oi.order_id = ANY(v_expiring_order_ids)
      AND oi.status IN ('reserved','waiting')
      AND oi.variant_id IS NOT NULL
      AND greatest(coalesce(oi.quantity, 0), 0) > 0
      AND NOT EXISTS (
        SELECT 1
        FROM public.order_item_stock_sources s
        WHERE s.order_item_id = oi.id
          AND greatest(coalesce(s.qty, 0), 0) > 0
      )
  ) x
  WHERE x.warehouse_id IS NOT NULL
    AND x.size_normalized = ''
    AND x.has_size_model = false
  GROUP BY x.variant_id, x.warehouse_id
  ON CONFLICT (variant_id, warehouse_id) DO UPDATE
  SET stock_qty = public.variant_warehouse_stock.stock_qty + excluded.stock_qty,
      updated_at = now();

  SELECT count(*)::int
  INTO v_legacy_fallback_count
  FROM public.order_items oi
  WHERE oi.order_id = ANY(v_expiring_order_ids)
    AND oi.status IN ('reserved','waiting')
    AND oi.variant_id IS NOT NULL
    AND greatest(coalesce(oi.quantity, 0), 0) > 0
    AND NOT EXISTS (
      SELECT 1
      FROM public.order_item_stock_sources s
      WHERE s.order_item_id = oi.id
        AND greatest(coalesce(s.qty, 0), 0) > 0
    );

  IF coalesce(v_legacy_fallback_count, 0) > 0 THEN
    RAISE WARNING 'rpc_orders_daily_maintenance: fallback legacy sin sources aplicado en % item(s).', v_legacy_fallback_count;
  END IF;

  UPDATE public.order_items oi
  SET status = 'expired'
  WHERE oi.order_id = ANY(v_expiring_order_ids)
    AND oi.status IN ('reserved','picked','waiting','missing','awaiting_apartado');

  UPDATE public.orders
  SET status = 'expired', expired_at = now()
  WHERE id = ANY(v_expiring_order_ids);

  DELETE FROM public.order_item_stock_sources s
  WHERE EXISTS (
    SELECT 1
    FROM public.order_items oi
    WHERE oi.id = s.order_item_id
      AND oi.order_id = ANY(v_expiring_order_ids)
      AND oi.status = 'expired'
  );

  INSERT INTO public.order_notifications (order_id, customer_id, type, payload)
  SELECT o.id, o.customer_id, 'DAY_4', jsonb_build_object(
    'order_id', o.id, 'order_number', coalesce(o.order_number,''),
    'days_elapsed', floor(extract(epoch from (now() - o.created_at))/86400)::int,
    'picked_waiting', (SELECT count(*)::int FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status IN ('picked','waiting')),
    'missing_to_min', greatest(0, 4 - (SELECT count(*) FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status IN ('picked','waiting'))),
    'expires_at', o.expires_at, 'dismantle_at', o.dismantle_at
  )
  FROM public.orders o
  WHERE o.status IN ('active','closing_soon')
    AND floor(extract(epoch from (now() - o.created_at))/86400) >= 4
  ON CONFLICT (order_id, type) DO NOTHING;

  INSERT INTO public.order_notifications (order_id, customer_id, type, payload)
  SELECT o.id, o.customer_id, 'DAY_6', jsonb_build_object(
    'order_id', o.id, 'order_number', coalesce(o.order_number,''),
    'days_elapsed', floor(extract(epoch from (now() - o.created_at))/86400)::int,
    'picked_waiting', (SELECT count(*)::int FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status IN ('picked','waiting')),
    'missing_to_min', greatest(0, 4 - (SELECT count(*) FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status IN ('picked','waiting'))),
    'expires_at', o.expires_at, 'dismantle_at', o.dismantle_at
  )
  FROM public.orders o
  WHERE o.status IN ('active','closing_soon')
    AND floor(extract(epoch from (now() - o.created_at))/86400) >= 6
  ON CONFLICT (order_id, type) DO NOTHING;

  INSERT INTO public.order_notifications (order_id, customer_id, type, payload)
  SELECT o.id, o.customer_id, 'DAY_7', jsonb_build_object(
    'order_id', o.id, 'order_number', coalesce(o.order_number,''),
    'days_elapsed', floor(extract(epoch from (now() - o.created_at))/86400)::int,
    'picked_waiting', (SELECT count(*)::int FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status IN ('picked','waiting')),
    'missing_to_min', greatest(0, 4 - (SELECT count(*) FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status IN ('picked','waiting'))),
    'expires_at', o.expires_at, 'dismantle_at', o.dismantle_at
  )
  FROM public.orders o
  WHERE o.status IN ('active','closing_soon')
    AND floor(extract(epoch from (now() - o.created_at))/86400) >= 7
  ON CONFLICT (order_id, type) DO NOTHING;

  INSERT INTO public.order_notifications (order_id, customer_id, type, payload)
  SELECT o.id, o.customer_id, 'DAY_11', jsonb_build_object(
    'order_id', o.id, 'order_number', coalesce(o.order_number,''),
    'days_elapsed', floor(extract(epoch from (now() - o.created_at))/86400)::int,
    'picked_waiting', (SELECT count(*)::int FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status IN ('picked','waiting')),
    'missing_to_min', greatest(0, 4 - (SELECT count(*) FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status IN ('picked','waiting'))),
    'expires_at', o.expires_at, 'dismantle_at', o.dismantle_at
  )
  FROM public.orders o
  WHERE o.status IN ('active','closing_soon')
    AND floor(extract(epoch from (now() - o.created_at))/86400) >= 11
  ON CONFLICT (order_id, type) DO NOTHING;

  INSERT INTO public.order_notifications (order_id, customer_id, type, payload)
  SELECT o.id, o.customer_id, 'DAY_13', jsonb_build_object(
    'order_id', o.id, 'order_number', coalesce(o.order_number,''),
    'days_elapsed', floor(extract(epoch from (now() - o.created_at))/86400)::int,
    'picked_waiting', (SELECT count(*)::int FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status IN ('picked','waiting')),
    'missing_to_min', greatest(0, 4 - (SELECT count(*) FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status IN ('picked','waiting'))),
    'expires_at', o.expires_at, 'dismantle_at', o.dismantle_at
  )
  FROM public.orders o
  WHERE o.status IN ('active','closing_soon')
    AND floor(extract(epoch from (now() - o.created_at))/86400) >= 13
  ON CONFLICT (order_id, type) DO NOTHING;

  INSERT INTO public.order_notifications (order_id, customer_id, type, payload)
  SELECT o.id, o.customer_id, 'MIN_REACHED', jsonb_build_object(
    'order_id', o.id, 'order_number', coalesce(o.order_number,''),
    'days_elapsed', floor(extract(epoch from (now() - o.created_at))/86400)::int,
    'picked_waiting', cnt.c,
    'missing_to_min', 0,
    'expires_at', o.expires_at, 'dismantle_at', o.dismantle_at
  )
  FROM public.orders o
  CROSS JOIN LATERAL (SELECT count(*)::int AS c FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status IN ('picked','waiting')) cnt
  WHERE o.status IN ('active','closing_soon') AND cnt.c >= 4
  ON CONFLICT (order_id, type) DO NOTHING;

  INSERT INTO public.order_notifications (order_id, customer_id, type, payload)
  SELECT o.id, o.customer_id, 'MIN_MISSING', jsonb_build_object(
    'order_id', o.id, 'order_number', coalesce(o.order_number,''),
    'days_elapsed', floor(extract(epoch from (now() - o.created_at))/86400)::int,
    'picked_waiting', cnt.c,
    'missing_to_min', greatest(0, 4 - cnt.c),
    'expires_at', o.expires_at, 'dismantle_at', o.dismantle_at
  )
  FROM public.orders o
  CROSS JOIN LATERAL (SELECT count(*)::int AS c FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status IN ('picked','waiting')) cnt
  WHERE o.status IN ('active','closing_soon') AND cnt.c < 4
  ON CONFLICT (order_id, type) DO NOTHING;

  INSERT INTO public.order_notifications (order_id, customer_id, type, payload)
  SELECT o.id, o.customer_id, 'EXPIRED', jsonb_build_object(
    'order_id', o.id, 'order_number', coalesce(o.order_number,''),
    'days_elapsed', floor(extract(epoch from (o.expired_at - o.created_at))/86400)::int,
    'picked_waiting', (SELECT count(*)::int FROM public.order_items oi WHERE oi.order_id = o.id AND oi.status IN ('picked','waiting')),
    'missing_to_min', 0,
    'expires_at', o.expires_at, 'dismantle_at', o.dismantle_at
  )
  FROM public.orders o
  WHERE o.status = 'expired' AND o.expired_at >= now() - interval '1 minute'
  ON CONFLICT (order_id, type) DO NOTHING;
END;
$function$;

COMMENT ON FUNCTION public.rpc_orders_daily_maintenance() IS NULL;

CREATE OR REPLACE FUNCTION public.trgfn_orders_release_reserved_qty_on_final_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
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
$function$;

DROP TRIGGER IF EXISTS trg_orders_release_reserved_qty_on_final_status ON public.orders;
CREATE TRIGGER trg_orders_release_reserved_qty_on_final_status
AFTER UPDATE OF status ON public.orders
FOR EACH ROW
WHEN (
  new.status = ANY (ARRAY['sent'::text, 'expired'::text, 'devolución'::text])
  AND old.status IS DISTINCT FROM new.status
  AND old.status <> ALL (ARRAY['sent'::text, 'expired'::text, 'devolución'::text])
)
EXECUTE FUNCTION public.trgfn_orders_release_reserved_qty_on_final_status();

CREATE OR REPLACE VIEW public.vw_stock_audit_reserved_qty_diff
WITH (security_invoker = on)
AS
 WITH order_reserved AS (
         SELECT oi.variant_id,
            sum(COALESCE(oiss.qty, 0))::integer AS qty
           FROM order_item_stock_sources oiss
             JOIN order_items oi ON oi.id = oiss.order_item_id
             JOIN orders o ON o.id = oi.order_id
          WHERE (o.status <> ALL (ARRAY['sent'::text, 'expired'::text, 'devolución'::text])) AND COALESCE(oiss.qty, 0) > 0
          GROUP BY oi.variant_id
        ), cart_reserved AS (
         SELECT ci.variant_id,
            sum(COALESCE(ci.qty, 0))::integer AS qty
           FROM cart_items ci
             JOIN carts c ON c.id = ci.cart_id
          WHERE c.status = 'open'::text AND ci.status = 'reserved'::text
          GROUP BY ci.variant_id
        ), real_reserved AS (
         SELECT COALESCE(o.variant_id, cr.variant_id) AS variant_id,
            COALESCE(o.qty, 0) AS order_qty,
            COALESCE(cr.qty, 0) AS cart_qty,
            COALESCE(o.qty, 0) + COALESCE(cr.qty, 0) AS total_real
           FROM order_reserved o
             FULL JOIN cart_reserved cr ON cr.variant_id = o.variant_id
        )
 SELECT p.id AS product_id,
    p.name AS product_name,
    pv.id AS variant_id,
    pv.color AS variant_color,
    pv.sku AS variant_sku,
    COALESCE(pv.reserved_qty, 0) AS stored_reserved_qty,
    COALESCE(rr.total_real, 0) AS real_reserved_qty,
    COALESCE(rr.order_qty, 0) AS order_sources_qty,
    COALESCE(rr.cart_qty, 0) AS cart_open_qty,
    COALESCE(pv.reserved_qty, 0) - COALESCE(rr.total_real, 0) AS delta,
        CASE
            WHEN COALESCE(pv.reserved_qty, 0) > COALESCE(rr.total_real, 0) THEN 'reserved_qty_inflated'::text
            ELSE 'reserved_qty_deflated'::text
        END AS anomaly_type
   FROM product_variants pv
     JOIN products p ON p.id = pv.product_id
     LEFT JOIN real_reserved rr ON rr.variant_id = pv.id
  WHERE COALESCE(pv.reserved_qty, 0) IS DISTINCT FROM COALESCE(rr.total_real, 0);

DO $patch$
DECLARE
  r record;
  v_def text;
BEGIN
  FOR r IN
    SELECT *
    FROM (VALUES
      (
        'public.fn_reserved_by_variant_size()'::regprocedure,
        '350a87cc52154734b0bff34f49717236',
        '59ac2bb5433136b58cbe70fd08fc10fd',
        $o$WHERE (o.status <> ALL (ARRAY['sent'::text, 'devolución'::text]))$o$,
        $o$WHERE (o.status <> ALL (ARRAY['sent'::text, 'expired'::text, 'devolución'::text]))$o$
      ),
      (
        'public.rpc_get_variant_size_reserved(uuid[])'::regprocedure,
        '54d09be518c122aeae93a82a52ceec32',
        '942b56dfa829466d3e2b787005d3265a',
        $o$and o.status not in ('sent', 'devolución')$o$,
        $o$and o.status not in ('sent', 'expired', 'devolución')$o$
      ),
      (
        'public.get_meta_feed()'::regprocedure,
        '1e9c9cf2a981c7d7f883a688e0f79f5b',
        '4dbab39c403e1f55288edf2cc0d9cb66',
        $o$WHERE o.status NOT IN ('sent', 'devolución') AND coalesce(oiss.qty, 0) > 0$o$,
        $o$WHERE o.status NOT IN ('sent', 'expired', 'devolución') AND coalesce(oiss.qty, 0) > 0$o$
      )
    ) AS t(fn, md5_before, md5_after, old_txt, new_txt)
  LOOP
    v_def := pg_get_functiondef(r.fn);
    IF md5(v_def) <> r.md5_before THEN
      RAISE EXCEPTION '367 ROLLBACK: % no está en la versión 367 (md5=%)', r.fn, md5(v_def);
    END IF;
    EXECUTE replace(v_def, r.old_txt, r.new_txt);
    IF md5(pg_get_functiondef(r.fn)) <> r.md5_after THEN
      RAISE EXCEPTION '367 ROLLBACK: % quedó con md5 inesperado', r.fn;
    END IF;
  END LOOP;
END
$patch$;

COMMIT;
