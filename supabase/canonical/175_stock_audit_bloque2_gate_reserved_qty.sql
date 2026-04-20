-- 175_stock_audit_bloque2_gate_reserved_qty.sql
-- Sprint 4 / Bloque 2 — Corrección de auditoría y release gate.
--
-- Cambios incluidos:
--   1. vw_stock_audit_variant_warehouse_diff  → excluir variantes sin filas en
--      variant_size_warehouse_stock (elimina falsos positivos).
--   2. vw_stock_audit_reserved_qty_diff        → nueva vista: drift entre
--      product_variants.reserved_qty y reservas activas reales.
--   3. vw_stock_audit_health_score             → agrega KPI reserved_qty_diffs.
--   4. vw_stock_audit_release_gate             → go_live_ready depende del nuevo KPI.
--   5. vw_stock_audit_alerts_current           → alerta crítica por drift de reserved_qty.
--
-- NO modifica: rpc_reconcile_stock, triggers 84/145, ninguna RPC operativa.
-- vw_stock_audit_health_score usa DROP CASCADE + CREATE por cambio de nombre
-- de columna en posición 7 (inserta reserved_qty_diffs antes de affected_variants).
-- El CASCADE elimina automáticamente release_gate y alerts_current, que se
-- recrean con CREATE OR REPLACE más adelante en el mismo archivo.


-- ============================================================================
-- 1) vw_stock_audit_variant_warehouse_diff — corregir falsos positivos
--    Problema: variantes SIN filas en variant_size_warehouse_stock no tienen
--    desglose canónico por talle. Comparar variant_warehouse_stock contra
--    SUM(size_rows)=0 produce un delta incorrecto. Se excluyen del diff.
-- ============================================================================
CREATE OR REPLACE VIEW public.vw_stock_audit_variant_warehouse_diff AS
WITH by_wh AS (
  SELECT
    variant_id,
    warehouse_id,
    SUM(COALESCE(stock_qty, 0))::int AS sum_qty
  FROM public.variant_size_warehouse_stock
  GROUP BY variant_id, warehouse_id
)
SELECT
  p.id   AS product_id,
  p.name AS product_name,
  pv.id    AS variant_id,
  pv.color AS variant_color,
  pv.sku   AS variant_sku,
  w.id   AS warehouse_id,
  w.code AS warehouse_code,
  COALESCE(vws.stock_qty, 0)::int AS variant_warehouse_qty,
  COALESCE(bw.sum_qty,   0)::int AS sum_from_size_rows,
  (COALESCE(vws.stock_qty, 0)::int - COALESCE(bw.sum_qty, 0)::int) AS delta,
  'variant_warehouse_vs_sum_size_rows'::text AS anomaly_type
FROM public.variant_warehouse_stock vws
JOIN public.product_variants pv ON pv.id = vws.variant_id
JOIN public.products         p  ON p.id  = pv.product_id
JOIN public.warehouses       w  ON w.id  = vws.warehouse_id
LEFT JOIN by_wh bw
  ON bw.variant_id   = vws.variant_id
 AND bw.warehouse_id = vws.warehouse_id
WHERE COALESCE(vws.stock_qty, 0)::int IS DISTINCT FROM COALESCE(bw.sum_qty, 0)::int
  -- Solo comparar variantes que tienen al menos una fila en la canónica por talle.
  -- Para variantes sin desglose (sin talle), la comparación no aplica.
  AND EXISTS (
    SELECT 1
    FROM public.variant_size_warehouse_stock sw2
    WHERE sw2.variant_id = vws.variant_id
  );

COMMENT ON VIEW public.vw_stock_audit_variant_warehouse_diff IS
  'V2 auditoría: diferencias entre variant_warehouse_stock y suma por depósito/talle. '
  'Excluye variantes sin desglose canónico en variant_size_warehouse_stock (sin falsos positivos).';


-- ============================================================================
-- 2) vw_stock_audit_reserved_qty_diff — nueva vista
--    Compara product_variants.reserved_qty contra la suma de reservas activas
--    reales derivadas de:
--      a) order_item_stock_sources: filas de pedidos admin con stock descontado.
--      b) cart_items: ítems de carritos abiertos (cliente B2B).
--
--    Estados de orden excluidos (reserva ya liberada):
--      'sent'       → pedido enviado, stock descontado definitivamente.
--      'expired'    → pedido expirado, reserva debió liberarse.
--      'devolución' → pedido devuelto, stock restituido.
--
--    Nota: order_item_stock_sources se ELIMINA cuando un ítem es cancelado
--    (rpc_cancel_order_item). Por eso no se filtra por oi.status = 'cancelled'.
-- ============================================================================
CREATE OR REPLACE VIEW public.vw_stock_audit_reserved_qty_diff AS
WITH order_reserved AS (
  -- Reservas reales de pedidos (stock efectivamente descontado).
  SELECT
    oi.variant_id,
    SUM(COALESCE(oiss.qty, 0))::int AS qty
  FROM public.order_item_stock_sources oiss
  JOIN public.order_items oi ON oi.id = oiss.order_item_id
  JOIN public.orders      o  ON o.id  = oi.order_id
  WHERE o.status NOT IN ('sent', 'expired', 'devolución')
    AND COALESCE(oiss.qty, 0) > 0
  GROUP BY oi.variant_id
),
cart_reserved AS (
  -- Reservas de carritos abiertos (clientes B2B pendientes de checkout).
  SELECT
    ci.variant_id,
    SUM(COALESCE(ci.qty, 0))::int AS qty
  FROM public.cart_items ci
  JOIN public.carts c ON c.id = ci.cart_id
  WHERE c.status  = 'open'
    AND ci.status = 'reserved'
  GROUP BY ci.variant_id
),
real_reserved AS (
  SELECT
    COALESCE(o.variant_id, cr.variant_id) AS variant_id,
    COALESCE(o.qty,  0) AS order_qty,
    COALESCE(cr.qty, 0) AS cart_qty,
    COALESCE(o.qty, 0) + COALESCE(cr.qty, 0) AS total_real
  FROM order_reserved o
  FULL OUTER JOIN cart_reserved cr ON cr.variant_id = o.variant_id
)
SELECT
  p.id   AS product_id,
  p.name AS product_name,
  pv.id    AS variant_id,
  pv.color AS variant_color,
  pv.sku   AS variant_sku,
  COALESCE(pv.reserved_qty, 0)::int   AS stored_reserved_qty,
  COALESCE(rr.total_real,   0)::int   AS real_reserved_qty,
  COALESCE(rr.order_qty,    0)::int   AS order_sources_qty,
  COALESCE(rr.cart_qty,     0)::int   AS cart_open_qty,
  (COALESCE(pv.reserved_qty, 0)::int
   - COALESCE(rr.total_real, 0)::int) AS delta,
  CASE
    WHEN COALESCE(pv.reserved_qty, 0) > COALESCE(rr.total_real, 0)
      THEN 'reserved_qty_inflated'   -- stored > real: valor fantasma, stock disponible subestimado
    ELSE 'reserved_qty_deflated'     -- stored < real: valor faltante, stock disponible sobreestimado
  END::text AS anomaly_type
FROM public.product_variants pv
JOIN public.products p ON p.id = pv.product_id
LEFT JOIN real_reserved rr ON rr.variant_id = pv.id
WHERE COALESCE(pv.reserved_qty, 0)::int
        IS DISTINCT FROM
      COALESCE(rr.total_real, 0)::int;

COMMENT ON VIEW public.vw_stock_audit_reserved_qty_diff IS
  'V1 auditoría reserved_qty: compara product_variants.reserved_qty contra reservas activas reales '
  '(order_item_stock_sources para pedidos no-enviados/expirados/devueltos + cart_items open). '
  'inflated = stored > real (stock disponible subestimado). '
  'deflated = stored < real (stock disponible sobreestimado — más peligroso).';


-- ============================================================================
-- 3) vw_stock_audit_health_score — agrega KPI reserved_qty_diffs
--    DROP CASCADE necesario: se inserta reserved_qty_diffs antes de
--    affected_variants, lo que cambia el nombre de columna en posición 7.
--    PostgreSQL rechaza CREATE OR REPLACE cuando cambia un nombre de columna.
--    El CASCADE elimina también release_gate y alerts_current, que se
--    recrean a continuación con CREATE OR REPLACE.
-- ============================================================================
DROP VIEW IF EXISTS public.vw_stock_audit_health_score CASCADE;

CREATE VIEW public.vw_stock_audit_health_score AS
SELECT
  (SELECT count(*)::int FROM public.vw_stock_audit_variant_sizes_diff)
    AS variant_sizes_diffs,
  (SELECT count(*)::int FROM public.vw_stock_audit_variant_warehouse_diff)
    AS variant_warehouse_diffs,
  (SELECT count(*)::int FROM public.vw_stock_audit_orphan_size_rows)
    AS orphan_rows,
  (SELECT count(*)::int FROM public.vw_stock_audit_reference_signals WHERE severity = 'critical')
    AS critical_signals,
  (SELECT count(*)::int FROM public.vw_stock_audit_reference_signals WHERE severity = 'warning')
    AS warning_signals,
  (SELECT count(*)::int FROM public.vw_stock_audit_reference_signals WHERE severity = 'review')
    AS review_signals,
  (SELECT count(*)::int FROM public.vw_stock_audit_reserved_qty_diff)
    AS reserved_qty_diffs,
  (
    SELECT count(*)::int
    FROM (
      SELECT DISTINCT variant_id FROM public.vw_stock_audit_variant_sizes_diff
        WHERE variant_id IS NOT NULL
      UNION
      SELECT DISTINCT variant_id FROM public.vw_stock_audit_variant_warehouse_diff
        WHERE variant_id IS NOT NULL
      UNION
      SELECT DISTINCT variant_id FROM public.vw_stock_audit_orphan_size_rows
        WHERE variant_id IS NOT NULL
      UNION
      SELECT DISTINCT variant_id FROM public.vw_stock_audit_reference_signals
        WHERE variant_id IS NOT NULL
      UNION
      SELECT DISTINCT variant_id FROM public.vw_stock_audit_reserved_qty_diff
        WHERE variant_id IS NOT NULL
    ) variants
  ) AS affected_variants,
  (EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trigger_sync_variant_sizes_on_warehouse_stock'
  ))::boolean AS trigger_84_active,
  (EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trigger_sync_variant_warehouse_stock'
  ))::boolean AS trigger_145_active,
  now() AS measured_at;

COMMENT ON VIEW public.vw_stock_audit_health_score IS
  'Stock Audit V3: conteos globales de salud + triggers 84/145 + drift de reserved_qty.';


-- ============================================================================
-- 4) vw_stock_audit_release_gate — go_live_ready depende de reserved_qty_diffs
-- ============================================================================
CREATE OR REPLACE VIEW public.vw_stock_audit_release_gate AS
WITH hs AS (
  SELECT * FROM public.vw_stock_audit_health_score
)
SELECT
  hs.*,
  (hs.variant_sizes_diffs     = 0) AS kpi_variant_sizes_diffs_ok,
  (hs.variant_warehouse_diffs = 0) AS kpi_variant_warehouse_diffs_ok,
  (hs.orphan_rows             = 0) AS kpi_orphan_rows_ok,
  (hs.critical_signals        = 0) AS kpi_critical_signals_ok,
  (hs.trigger_84_active AND hs.trigger_145_active) AS kpi_triggers_ok,
  (hs.reserved_qty_diffs      = 0) AS kpi_reserved_qty_diffs_ok,
  (
    hs.variant_sizes_diffs     = 0
    AND hs.variant_warehouse_diffs = 0
    AND hs.orphan_rows         = 0
    AND hs.critical_signals    = 0
    AND hs.trigger_84_active
    AND hs.trigger_145_active
    AND hs.reserved_qty_diffs  = 0
  ) AS go_live_ready,
  CASE
    WHEN (
      hs.variant_sizes_diffs     = 0
      AND hs.variant_warehouse_diffs = 0
      AND hs.orphan_rows         = 0
      AND hs.critical_signals    = 0
      AND hs.trigger_84_active
      AND hs.trigger_145_active
      AND hs.reserved_qty_diffs  = 0
    ) THEN 'go'
    ELSE 'no-go'
  END AS release_decision,
  ARRAY_REMOVE(
    ARRAY[
      CASE WHEN hs.variant_sizes_diffs     <> 0 THEN 'variant_sizes_diffs'     END,
      CASE WHEN hs.variant_warehouse_diffs <> 0 THEN 'variant_warehouse_diffs' END,
      CASE WHEN hs.orphan_rows             <> 0 THEN 'orphan_rows'             END,
      CASE WHEN hs.critical_signals        <> 0 THEN 'critical_signals'        END,
      CASE WHEN NOT hs.trigger_84_active        THEN 'trigger_84_inactive'     END,
      CASE WHEN NOT hs.trigger_145_active       THEN 'trigger_145_inactive'    END,
      CASE WHEN hs.reserved_qty_diffs      <> 0 THEN 'reserved_qty_diffs'      END
    ],
    NULL
  )::text[] AS blocking_reasons
FROM hs;

COMMENT ON VIEW public.vw_stock_audit_release_gate IS
  'V3 Gate de lanzamiento: go/no-go con KPIs bloqueantes incluyendo drift de reserved_qty.';


-- ============================================================================
-- 5) vw_stock_audit_alerts_current — agrega alerta crítica por reserved_qty drift
-- ============================================================================
CREATE OR REPLACE VIEW public.vw_stock_audit_alerts_current AS
WITH gate AS (
  SELECT * FROM public.vw_stock_audit_release_gate
)

-- Alerta bloqueante genérica del gate
SELECT
  'critical'::text AS severity,
  'release_gate_blocked'::text AS alert_key,
  gate.release_decision AS status,
  (
    'Gate bloqueado. Razones: '
    || COALESCE(array_to_string(gate.blocking_reasons, ', '), 'sin detalle')
  )::text AS message,
  gate.measured_at AS measured_at
FROM gate
WHERE NOT gate.go_live_ready

UNION ALL

-- Alerta específica de reserved_qty drift (da contexto extra con el conteo)
SELECT
  'critical'::text AS severity,
  'reserved_qty_drift'::text AS alert_key,
  'no-go'::text AS status,
  (
    'Drift de reserved_qty en '
    || gate.reserved_qty_diffs::text
    || ' variante(s). '
    || 'Consultar vw_stock_audit_reserved_qty_diff para detalle. '
    || 'Requiere corrección antes del release.'
  )::text AS message,
  gate.measured_at AS measured_at
FROM gate
WHERE gate.reserved_qty_diffs > 0

UNION ALL

SELECT
  'warning'::text AS severity,
  'warning_signals_detected'::text AS alert_key,
  'review'::text AS status,
  ('Hay ' || gate.warning_signals::text || ' señales warning para revisar antes del release.')::text AS message,
  gate.measured_at AS measured_at
FROM gate
WHERE gate.warning_signals > 0

UNION ALL

SELECT
  'review'::text AS severity,
  'review_signals_detected'::text AS alert_key,
  'info'::text AS status,
  ('Hay ' || gate.review_signals::text || ' señales review pendientes de auditoría manual.')::text AS message,
  gate.measured_at AS measured_at
FROM gate
WHERE gate.review_signals > 0;

COMMENT ON VIEW public.vw_stock_audit_alerts_current IS
  'V2 Alertas automáticas del stock audit: añade alerta crítica específica por drift de reserved_qty.';


SELECT pg_notify('pgrst', 'reload schema');
