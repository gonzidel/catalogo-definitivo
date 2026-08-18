-- 265_fix_orders_daily_maintenance_qty_zero_check_violation.sql
--
-- INCIDENTE ACTIVO EN PRODUCCION (detectado 2026-08-03):
--   rpc_orders_daily_maintenance() (bloque D.3, reescrito en
--   260_fix_orders_daily_maintenance_reserved_qty_release_order.sql) hace:
--
--     UPDATE public.order_item_stock_sources s
--     SET qty = 0
--     ...
--
--   pero order_item_stock_sources tiene el constraint
--   order_item_stock_sources_qty_check = CHECK (qty > 0), que NUNCA permite
--   qty = 0. Esa fila nunca puede pisarse con 0, solo borrarse.
--
--   Resultado real verificado en cron.job_run_details (jobid=1,
--   'orders-daily-maintenance', */15 * * * *):
--     - Primer fallo: 2026-08-01 22:15:00 UTC (el mismo ciclo en que el
--       pedido A55245 cruzo su dismantle_at, 2026-08-01 22:06:13 UTC).
--     - Fallando ININTERRUMPIDAMENTE desde entonces, cada 15 minutos, hasta
--       ahora (2026-08-03, ~40+ horas, 163 de 193 corridas totales).
--     - Como toda la funcion corre en una sola transaccion implicita, la
--       excepcion hace ROLLBACK de TODO el intento: no solo D.3 (expirar),
--       sino tambien D.1 (backfill fechas), D.2 (active -> closing_soon) y
--       D.4 (notificaciones outbox) para TODOS los pedidos, en cada corrida,
--       mientras exista al menos un pedido que dispare este error.
--     - Verificado (solo lectura) que hoy solo hay 1 pedido atascado en este
--       estado (A55245, status='closing_soon', dismantle_at ya vencido hace
--       mas de un dia), pero mientras siga atascado bloquea el mantenimiento
--       de TODOS los pedidos en cada corrida.
--
-- Cambio (unicamente el tramo de limpieza de order_item_stock_sources dentro
-- de D.3, inmediatamente despues de marcar order_items/orders como
-- 'expired'): se elimina el UPDATE ... SET qty = 0 (innecesario e invalido
-- contra el constraint) y se deja solo el DELETE directo. El trigger 188 ya
-- se disparo arriba, con las fuentes todavia en qty > 0, y ya libero
-- reserved_qty correctamente -- este DELETE es pura limpieza posterior y el
-- resultado final (cero filas de sources para esos items) es identico al
-- que se buscaba con el UPDATE+DELETE original, sin violar el constraint.
--
-- No se toca ninguna otra parte de la funcion (D.1, D.2, D.4 y el resto de
-- D.3 quedan byte a byte iguales a 260).
--
-- Riesgo: BAJO. Es un fix puntual de una linea que hoy siempre falla (no
-- puede "romper" un camino que ya esta roto). No cambia elegibilidad de
-- pedidos, no cambia devolucion de stock fisico, no cambia notificaciones.
--
-- Rollback: volver a aplicar el CREATE OR REPLACE de 260 (deja la funcion
-- en el estado roto actual; no recomendado, solo por completitud).
--
-- Verificacion post-deploy sugerida (solo lectura):
--   1) SELECT * FROM cron.job_run_details WHERE jobid = 1 ORDER BY start_time DESC LIMIT 3;
--      -- debe empezar a aparecer status='succeeded'.
--   2) SELECT status, dismantle_at FROM orders WHERE order_number = 'A55245';
--      -- debe pasar a status='expired' en la primera corrida posterior (<=15 min).
--   3) SELECT count(*) FROM order_item_stock_sources s
--        JOIN order_items oi ON oi.id = s.order_item_id
--        WHERE oi.order_id = (SELECT id FROM orders WHERE order_number = 'A55245');
--      -- deberia dar 0 tras la corrida (la orden ya paso a 'expired').
--      -- Nota: si la orden ya no existe tras esa corrida, es porque quedo sin
--      -- items operacionales y el flujo de borrado automatico la elimino
--      -- (comportamiento existente, no introducido por este fix).

CREATE OR REPLACE FUNCTION public.rpc_orders_daily_maintenance()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_general_warehouse_id uuid;
  v_venta_warehouse_id uuid;
  v_legacy_fallback_count int := 0;
  v_expiring_order_ids uuid[];
BEGIN
  -- D.1 Backfill fechas (identico a 257/260)
  UPDATE public.orders o
  SET
    dismantle_at = coalesce(o.dismantle_at, public.fn_compute_order_deadline(o.created_at, 7)),
    expires_at = coalesce(
      o.expires_at,
      coalesce(o.dismantle_at, public.fn_compute_order_deadline(o.created_at, 7)) - interval '2 days'
    )
  WHERE o.status IN ('active','closing_soon')
    AND (o.expires_at IS NULL OR o.dismantle_at IS NULL);

  -- D.2 Pasar a closing_soon (identico a 257/260)
  UPDATE public.orders
  SET status = 'closing_soon'
  WHERE status = 'active'
    AND now() >= expires_at
    AND now() < dismantle_at;

  -- D.3 Expirar / desarmar (devolver por source respetando talle + deposito; fallback legacy sin source)
  SELECT id INTO v_general_warehouse_id FROM public.warehouses WHERE code = 'general' LIMIT 1;
  SELECT id INTO v_venta_warehouse_id FROM public.warehouses WHERE code = 'venta-publico' LIMIT 1;

  -- Captura del conjunto de pedidos que vencen en ESTA corrida, antes de mutar
  -- ningun status. Todo el resto de D.3 usa este array en vez de re-derivar
  -- elegibilidad por o.status/dismantle_at (que cambian a mitad de bloque).
  SELECT coalesce(array_agg(o.id), '{}'::uuid[])
  INTO v_expiring_order_ids
  FROM public.orders o
  WHERE o.status IN ('active','closing_soon')
    AND now() >= o.dismantle_at;

  PERFORM 1
  FROM public.order_items oi
  WHERE oi.order_id = ANY(v_expiring_order_ids)
    AND oi.status IN ('reserved','picked','waiting','missing')
  FOR UPDATE OF oi;

  PERFORM 1
  FROM public.product_variants pv
  WHERE pv.id IN (
    SELECT DISTINCT oi.variant_id
    FROM public.order_items oi
    WHERE oi.order_id = ANY(v_expiring_order_ids)
      AND oi.status IN ('reserved','picked','waiting','missing')
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
      AND oi.status IN ('reserved','picked','waiting','missing')
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
      AND oi.status IN ('reserved','picked','waiting','missing')
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

  -- (Eliminado desde 260: el UPDATE product_variants SET reserved_qty =
  -- reserved_qty + agg.sum_qty que sumaba mal. La liberacion de reserved_qty
  -- para estos pedidos la hace exclusivamente el trigger 188 mas abajo,
  -- al marcar orders.status = 'expired' con las fuentes todavia pobladas.)

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

  -- Orden clave del fix de 260 (sin cambios aqui): primero se marcan los
  -- items y el pedido como 'expired' (esto dispara el trigger 188 con
  -- order_item_stock_sources TODAVIA con qty > 0, permitiendole liberar
  -- reserved_qty correctamente); recien despues se borran esas fuentes.
  UPDATE public.order_items oi
  SET status = 'expired'
  WHERE oi.order_id = ANY(v_expiring_order_ids)
    AND oi.status IN ('reserved','picked','waiting','missing');

  UPDATE public.orders
  SET status = 'expired', expired_at = now()
  WHERE id = ANY(v_expiring_order_ids);

  -- FIX 265: se borra directo, sin el UPDATE ... SET qty = 0 previo (ese
  -- paso violaba order_item_stock_sources_qty_check, que exige qty > 0
  -- siempre). El trigger 188 ya corrio en el UPDATE de arriba con las
  -- fuentes todavia pobladas, asi que este DELETE es limpieza pura y no
  -- afecta la liberacion de reserved_qty.
  DELETE FROM public.order_item_stock_sources s
  WHERE EXISTS (
    SELECT 1
    FROM public.order_items oi
    WHERE oi.id = s.order_item_id
      AND oi.order_id = ANY(v_expiring_order_ids)
  );

  -- D.4 Notificaciones (outbox) idempotentes -- identico a 257/260
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
$$;

SELECT pg_notify('pgrst', 'reload schema');
