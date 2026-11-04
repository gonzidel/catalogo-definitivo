-- 367_expired_orders_keep_stock_until_dismantle.sql
--
-- NEGOCIO CONFIRMADO (2026-10-03): un pedido vencido NO devuelve stock hasta que
-- un admin confirma el desarme. Antes, rpc_orders_daily_maintenance (cron cada
-- 15 min) reingresaba al vencer el stock de todos los ítems (incluidos los
-- apartados, que siguen físicamente en la bolsa) y borraba las fuentes; el stock
-- quedaba vendible aunque las prendas no hubieran vuelto al depósito.
--
-- Ahora:
--   * Al vencer: orders.status = 'expired'. Los ítems reserved/picked/waiting/
--     missing conservan su estado y sus order_item_stock_sources. Solo los
--     awaiting_apartado sin fuentes (no tienen stock descontado) pasan a 'expired'.
--   * "Desarmar" en la columna Vencido (rpc_cancel_order_full, sin cambios) es la
--     confirmación: reingresa por fuentes, libera reserved_qty y borra el pedido.
--   * trg_orders_release_reserved_qty_on_final_status deja de liberar
--     reserved_qty al pasar a 'expired' (lo libera el desarme). Sigue liberando
--     al pasar a 'sent'/'devolución', incluido expired -> sent ("Ya enviado").
--   * Un pedido 'expired' con fuentes cuenta como reserva activa en
--     vw_stock_audit_reserved_qty_diff (usa rpc_reconcile_stock),
--     fn_reserved_by_variant_size, rpc_get_variant_size_reserved y get_meta_feed.
--     Los 'expired' históricos no tienen fuentes (verificado: 0 filas), así que
--     ese cambio no altera nada existente.
--
-- Sin cambios: rpc_cancel_order_full, rpc_admin_reopen_expired_order (reabre
-- con las reservas intactas), rpc_admin_mark_expired_order_sent, plazos,
-- ventana de gracia 355, avisos WA.

BEGIN;

-- ---------------------------------------------------------------------------
-- Guardas: abortar si producción cambió respecto de lo auditado.
-- ---------------------------------------------------------------------------
DO $guard$
BEGIN
  IF md5(pg_get_functiondef('public.rpc_orders_daily_maintenance()'::regprocedure))
     <> '21218d8db8ca46c3c8edc393533ebf76' THEN
    RAISE EXCEPTION '367: rpc_orders_daily_maintenance cambió desde la auditoría; revisar antes de aplicar';
  END IF;
  IF md5(pg_get_functiondef('public.trgfn_orders_release_reserved_qty_on_final_status()'::regprocedure))
     <> '7b6aabb4912136bd22ca79a2a1087f1e' THEN
    RAISE EXCEPTION '367: trgfn_orders_release_reserved_qty_on_final_status cambió desde la auditoría';
  END IF;
END
$guard$;

-- ---------------------------------------------------------------------------
-- 1) Mantenimiento: vencer sin reingresar stock.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_orders_daily_maintenance()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
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

  -- El stock de un pedido vencido queda reservado (ítems y fuentes intactos)
  -- hasta que un admin confirma el desarme con rpc_cancel_order_full.
  -- awaiting_apartado no tiene stock descontado: pasa a expired para que el
  -- desarme pueda borrar el pedido.
  UPDATE public.order_items oi
  SET status = 'expired'
  WHERE oi.order_id = ANY(v_expiring_order_ids)
    AND oi.status = 'awaiting_apartado'
    AND NOT EXISTS (
      SELECT 1
      FROM public.order_item_stock_sources s
      WHERE s.order_item_id = oi.id
        AND greatest(coalesce(s.qty, 0), 0) > 0
    );

  UPDATE public.orders
  SET status = 'expired', expired_at = now()
  WHERE id = ANY(v_expiring_order_ids);

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

COMMENT ON FUNCTION public.rpc_orders_daily_maintenance() IS
  'canonical:367 | Vence pedidos (ventana 355) SIN reingresar stock: ítems y fuentes quedan reservados hasta el desarme admin (rpc_cancel_order_full).';

-- ---------------------------------------------------------------------------
-- 2) reserved_qty: no liberar al vencer; sí al pasar a sent/devolución
--    (incluye expired -> sent). release_reserved_qty_for_order es idempotente
--    por order_reserved_qty_released, así que los expired históricos ya
--    liberados no se descuentan dos veces.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trgfn_orders_release_reserved_qty_on_final_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status IN ('sent', 'devolución')
     AND OLD.status NOT IN ('sent', 'devolución')
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
  new.status = ANY (ARRAY['sent'::text, 'devolución'::text])
  AND old.status IS DISTINCT FROM new.status
  AND old.status <> ALL (ARRAY['sent'::text, 'devolución'::text])
)
EXECUTE FUNCTION public.trgfn_orders_release_reserved_qty_on_final_status();

-- ---------------------------------------------------------------------------
-- 3) Auditoría de reservas: expired con fuentes = reserva activa.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.vw_stock_audit_reserved_qty_diff
WITH (security_invoker = on)
AS
 WITH order_reserved AS (
         SELECT oi.variant_id,
            sum(COALESCE(oiss.qty, 0))::integer AS qty
           FROM order_item_stock_sources oiss
             JOIN order_items oi ON oi.id = oiss.order_item_id
             JOIN orders o ON o.id = oi.order_id
          WHERE (o.status <> ALL (ARRAY['sent'::text, 'devolución'::text])) AND COALESCE(oiss.qty, 0) > 0
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

-- ---------------------------------------------------------------------------
-- 4) Reservados por talle (catálogo/carrito vanilla, feed Meta): mismo criterio.
--    Parche puntual sobre la definición viva, con guardas md5.
-- ---------------------------------------------------------------------------
DO $patch$
DECLARE
  r record;
  v_def text;
  v_new text;
BEGIN
  FOR r IN
    SELECT *
    FROM (VALUES
      (
        'public.fn_reserved_by_variant_size()'::regprocedure,
        '59ac2bb5433136b58cbe70fd08fc10fd',
        '350a87cc52154734b0bff34f49717236',
        $o$WHERE (o.status <> ALL (ARRAY['sent'::text, 'expired'::text, 'devolución'::text]))$o$,
        $o$WHERE (o.status <> ALL (ARRAY['sent'::text, 'devolución'::text]))$o$
      ),
      (
        'public.rpc_get_variant_size_reserved(uuid[])'::regprocedure,
        '942b56dfa829466d3e2b787005d3265a',
        '54d09be518c122aeae93a82a52ceec32',
        $o$and o.status not in ('sent', 'expired', 'devolución')$o$,
        $o$and o.status not in ('sent', 'devolución')$o$
      ),
      (
        'public.get_meta_feed()'::regprocedure,
        '4dbab39c403e1f55288edf2cc0d9cb66',
        '1e9c9cf2a981c7d7f883a688e0f79f5b',
        $o$WHERE o.status NOT IN ('sent', 'expired', 'devolución') AND coalesce(oiss.qty, 0) > 0$o$,
        $o$WHERE o.status NOT IN ('sent', 'devolución') AND coalesce(oiss.qty, 0) > 0$o$
      )
    ) AS t(fn, md5_before, md5_after, old_txt, new_txt)
  LOOP
    v_def := pg_get_functiondef(r.fn);
    IF md5(v_def) <> r.md5_before THEN
      RAISE EXCEPTION '367: % cambió desde la auditoría (md5=%)', r.fn, md5(v_def);
    END IF;
    IF (length(v_def) - length(replace(v_def, r.old_txt, ''))) / length(r.old_txt) <> 1 THEN
      RAISE EXCEPTION '367: % no contiene exactamente una vez el filtro esperado', r.fn;
    END IF;

    v_new := replace(v_def, r.old_txt, r.new_txt);
    EXECUTE v_new;

    IF md5(pg_get_functiondef(r.fn)) <> r.md5_after THEN
      RAISE EXCEPTION '367: % quedó con md5 inesperado tras el parche', r.fn;
    END IF;
  END LOOP;
END
$patch$;

COMMIT;
