-- 260_fix_orders_daily_maintenance_reserved_qty_release_order.sql
--
-- Motivo del fix (choque documentado en 188_order_reserved_qty_release_on_final_status.sql,
-- seccion "Caso especial", y en docs/FYL-Obsidian/06-RESERVED-QTY-Y-RECONCILE.md):
--
--   rpc_orders_daily_maintenance() (definida en 257) hace, en este orden, dentro de la
--   misma transaccion, para cada pedido que vence (dismantle_at):
--     1) devuelve el stock fisico a los depositos (correcto, sin cambios aqui)
--     2) SUMA product_variants.reserved_qty += suma de fuentes del pedido (INCORRECTO,
--        ver mas abajo)
--     3) pone order_item_stock_sources.qty = 0 y borra esas filas
--     4) recien despues marca orders.status = 'expired'
--
--   El trigger trg_orders_release_reserved_qty_on_final_status (188) se dispara al
--   pasar orders.status a 'expired' y calcula cuanto reserved_qty liberar sumando
--   order_item_stock_sources.qty > 0 del pedido. Como el paso 3 ya vacio esas filas
--   ANTES del paso 4, el trigger encuentra 0 y no libera nada -- pero igual deja
--   registrada la fila en el ledger (order_reserved_qty_released), bloqueando
--   cualquier reintento futuro para ese pedido.
--
--   Ademas, el paso 2 (incremento manual) es conceptualmente incorrecto: una vez que
--   el pedido pasa a un estado final (sent/expired/devolucion), su aporte a
--   "real_reserved_qty" (vw_stock_audit_reserved_qty_diff) desaparece, por lo que
--   reserved_qty deberia BAJAR (via el trigger 188), nunca subir. Esta suma es una
--   causa raiz del drift "reserved_qty_inflated" documentado en
--   06-RESERVED-QTY-Y-RECONCILE.md para pedidos vencidos.
--
--   Este choque era historicamente de bajo impacto porque rpc_orders_daily_maintenance
--   casi no corria en produccion (ver docs/FYL-Obsidian/47-VENCIMIENTO-...). Desde
--   supabase/canonical/255_pg_cron_orders_maintenance.sql corre cada 15 minutos, por
--   lo que el drift se acumula mucho mas rapido ahora.
--
-- Cambio aplicado (unicamente dentro de rpc_orders_daily_maintenance, bloque D.3):
--   A) Se captura el conjunto de pedidos que vencen en esta corrida en un array
--      (v_expiring_order_ids), calculado UNA sola vez al principio del bloque D.3,
--      antes de mutar ningun status. Todos los sub-pasos de D.3 filtran por ese
--      array en vez de por o.status/dismantle_at (que dejan de ser validos apenas
--      se actualiza el status del pedido a mitad de bloque).
--   B) Se elimina por completo el bloque que sumaba reserved_qty (paso 2 de arriba).
--      La liberacion de reserved_qty para estos pedidos queda 100% a cargo del
--      trigger 188 (misma logica ya usada y verificada en produccion para sent y
--      devolucion).
--   C) Se reordena: primero se marcan order_items.status='expired' y
--      orders.status='expired' (esto dispara el trigger 188 con las fuentes
--      TODAVIA pobladas, permitiendole calcular y liberar reserved_qty
--      correctamente); recien despues se ponen en 0 y se borran las filas de
--      order_item_stock_sources.
--
--   No se toca fn_is_business_day, fn_next_business_day, fn_compute_order_deadline,
--   rpc_checkout_cart, ni el trigger/funcion de 188 -- todos siguen exactamente
--   igual que en 257 / 188. D.1, D.2 y D.4 (notificaciones) quedan identicos.
--
-- Riesgo: MEDIO-ALTO (toca la funcion de mantenimiento automatico que corre cada
-- 15 minutos sobre pedidos reales, vencimientos y devolucion de stock). Mitigado
-- por:
--   - No cambia ninguna condicion de ELEGIBILIDAD de pedidos/items (mismo criterio
--     status IN ('active','closing_soon') AND now() >= dismantle_at, ahora
--     capturado una sola vez en vez de re-evaluado con columnas ya mutadas).
--   - No cambia la devolucion de stock fisico (mismos 4 bloques de INSERT ... ON
--     CONFLICT, sin tocar su logica interna).
--   - No cambia las notificaciones (bloque D.4 identico, byte a byte).
--   - El unico comportamiento nuevo es CUANTO se resta de reserved_qty al expirar
--     (antes: se sumaba mal y no se restaba nada; ahora: se resta correctamente via
--     el trigger ya probado en produccion desde 188).
--
-- Rollback: volver a aplicar el CREATE OR REPLACE de
-- supabase/canonical/257_order_deadline_business_days.sql (deja la funcion
-- exactamente como estaba antes de este archivo; no requiere tocar 188 ni datos).
--
-- Verificacion post-deploy sugerida (solo lectura):
--   1) SELECT proname FROM pg_proc WHERE proname = 'rpc_orders_daily_maintenance';
--   2) Antes de la proxima corrida del cron, anotar:
--      SELECT count(*) FROM vw_stock_audit_reserved_qty_diff WHERE anomaly_type='reserved_qty_inflated';
--   3) Tras una corrida real del cron (cada 15 min) que expire al menos un pedido,
--      volver a contar: el numero de inflated no deberia crecer por esta causa
--      (puede seguir habiendo drift historico de otras causas, eso se corrige
--      aparte con rpc_reconcile_stock(true), ya documentado).
--   4) SELECT * FROM order_reserved_qty_released ORDER BY released_at DESC LIMIT 20;
--      -- deberia empezar a aparecer new_status='expired' con old_status en
--      -- ('active','closing_soon').

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
  -- D.1 Backfill fechas (identico a 257)
  UPDATE public.orders o
  SET
    dismantle_at = coalesce(o.dismantle_at, public.fn_compute_order_deadline(o.created_at, 7)),
    expires_at = coalesce(
      o.expires_at,
      coalesce(o.dismantle_at, public.fn_compute_order_deadline(o.created_at, 7)) - interval '2 days'
    )
  WHERE o.status IN ('active','closing_soon')
    AND (o.expires_at IS NULL OR o.dismantle_at IS NULL);

  -- D.2 Pasar a closing_soon (identico a 257)
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

  -- (Eliminado respecto a 257: el UPDATE product_variants SET reserved_qty =
  -- reserved_qty + agg.sum_qty que sumaba mal. La liberacion de reserved_qty
  -- para estos pedidos ahora la hace exclusivamente el trigger 188 mas abajo,
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

  -- Orden clave del fix: primero se marcan los items y el pedido como
  -- 'expired' (esto dispara el trigger 188 con order_item_stock_sources
  -- TODAVIA con qty > 0, permitiendole liberar reserved_qty correctamente);
  -- recien despues se ponen en 0 y se borran esas fuentes.
  UPDATE public.order_items oi
  SET status = 'expired'
  WHERE oi.order_id = ANY(v_expiring_order_ids)
    AND oi.status IN ('reserved','picked','waiting','missing');

  UPDATE public.orders
  SET status = 'expired', expired_at = now()
  WHERE id = ANY(v_expiring_order_ids);

  UPDATE public.order_item_stock_sources s
  SET qty = 0
  FROM public.order_items oi
  WHERE s.order_item_id = oi.id
    AND oi.order_id = ANY(v_expiring_order_ids)
    AND greatest(coalesce(s.qty, 0), 0) > 0;

  DELETE FROM public.order_item_stock_sources s
  WHERE coalesce(s.qty, 0) <= 0
    AND EXISTS (
      SELECT 1
      FROM public.order_items oi
      WHERE oi.id = s.order_item_id
        AND oi.order_id = ANY(v_expiring_order_ids)
    );

  -- D.4 Notificaciones (outbox) idempotentes -- identico a 257
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
