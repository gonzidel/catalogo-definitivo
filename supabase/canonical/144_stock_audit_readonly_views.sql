-- 144_stock_audit_readonly_views.sql
-- Vistas de SOLO LECTURA para observabilidad/auditoria de stock (V1)
-- No modifica stock ni crea flujos operativos.

-- ============================================================================
-- 1) Snapshot auditable por variante/talle/deposito
-- ============================================================================
CREATE OR REPLACE VIEW public.vw_stock_audit_snapshot AS
WITH sws AS (
  SELECT
    sw.variant_id,
    TRIM(COALESCE(sw.size::text, '')) AS size,
    sw.warehouse_id,
    COALESCE(sw.stock_qty, 0)::int AS size_wh_qty
  FROM public.variant_size_warehouse_stock sw
),
sum_size_by_variant AS (
  SELECT
    s.variant_id,
    SUM(s.size_wh_qty)::int AS sum_size_all_wh
  FROM sws s
  GROUP BY s.variant_id
),
sum_size_by_variant_wh AS (
  SELECT
    s.variant_id,
    s.warehouse_id,
    SUM(s.size_wh_qty)::int AS sum_size_by_wh
  FROM sws s
  GROUP BY s.variant_id, s.warehouse_id
)
SELECT
  p.id AS product_id,
  p.name AS product_name,
  pv.id AS variant_id,
  pv.color AS variant_color,
  pv.sku AS variant_sku,
  NULLIF(s.size, '') AS size,
  w.id AS warehouse_id,
  w.code AS warehouse_code,
  s.size_wh_qty,
  COALESCE(vs.stock_qty, 0)::int AS variant_sizes_qty,
  COALESCE(vws.stock_qty, 0)::int AS variant_warehouse_qty,
  COALESCE(sbw.sum_size_by_wh, 0)::int AS sum_size_rows_same_warehouse,
  COALESCE(sbv.sum_size_all_wh, 0)::int AS sum_size_rows_all_warehouses,
  (COALESCE(vs.stock_qty, 0)::int - s.size_wh_qty)::int AS delta_variant_sizes_vs_row,
  (COALESCE(vws.stock_qty, 0)::int - COALESCE(sbw.sum_size_by_wh, 0)::int)::int AS delta_variant_warehouse_vs_sum_by_wh
FROM sws s
JOIN public.product_variants pv ON pv.id = s.variant_id
JOIN public.products p ON p.id = pv.product_id
JOIN public.warehouses w ON w.id = s.warehouse_id
LEFT JOIN public.variant_sizes vs
  ON vs.variant_id = s.variant_id
 AND TRIM(COALESCE(vs.size::text, '')) = s.size
LEFT JOIN public.variant_warehouse_stock vws
  ON vws.variant_id = s.variant_id
 AND vws.warehouse_id = s.warehouse_id
LEFT JOIN sum_size_by_variant_wh sbw
  ON sbw.variant_id = s.variant_id
 AND sbw.warehouse_id = s.warehouse_id
LEFT JOIN sum_size_by_variant sbv
  ON sbv.variant_id = s.variant_id;

COMMENT ON VIEW public.vw_stock_audit_snapshot IS
  'V1 auditoria stock (readonly): snapshot por variante/talle/deposito + deltas de coherencia.';

-- ============================================================================
-- 2) Diff: variant_sizes vs suma de variant_size_warehouse_stock por talle
-- ============================================================================
CREATE OR REPLACE VIEW public.vw_stock_audit_variant_sizes_diff AS
WITH sws AS (
  SELECT
    variant_id,
    TRIM(COALESCE(size::text, '')) AS size_norm,
    SUM(COALESCE(stock_qty, 0))::int AS sum_qty
  FROM public.variant_size_warehouse_stock
  GROUP BY variant_id, TRIM(COALESCE(size::text, ''))
)
SELECT
  p.id AS product_id,
  p.name AS product_name,
  pv.id AS variant_id,
  pv.color AS variant_color,
  pv.sku AS variant_sku,
  TRIM(COALESCE(vs.size::text, '')) AS size,
  COALESCE(vs.stock_qty, 0)::int AS variant_sizes_qty,
  COALESCE(sws.sum_qty, 0)::int AS sum_size_warehouse_qty,
  (COALESCE(vs.stock_qty, 0)::int - COALESCE(sws.sum_qty, 0)::int) AS delta,
  'variant_sizes_vs_sum_size_warehouse'::text AS anomaly_type
FROM public.variant_sizes vs
JOIN public.product_variants pv ON pv.id = vs.variant_id
JOIN public.products p ON p.id = pv.product_id
LEFT JOIN sws
  ON sws.variant_id = vs.variant_id
 AND sws.size_norm = TRIM(COALESCE(vs.size::text, ''))
WHERE COALESCE(vs.stock_qty, 0)::int IS DISTINCT FROM COALESCE(sws.sum_qty, 0)::int;

COMMENT ON VIEW public.vw_stock_audit_variant_sizes_diff IS
  'V1 auditoria stock (readonly): diferencias entre variant_sizes y suma por talle en variant_size_warehouse_stock.';

-- ============================================================================
-- 3) Diff: variant_warehouse_stock vs suma por deposito en variant_size_warehouse_stock
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
  p.id AS product_id,
  p.name AS product_name,
  pv.id AS variant_id,
  pv.color AS variant_color,
  pv.sku AS variant_sku,
  w.id AS warehouse_id,
  w.code AS warehouse_code,
  COALESCE(vws.stock_qty, 0)::int AS variant_warehouse_qty,
  COALESCE(bw.sum_qty, 0)::int AS sum_from_size_rows,
  (COALESCE(vws.stock_qty, 0)::int - COALESCE(bw.sum_qty, 0)::int) AS delta,
  'variant_warehouse_vs_sum_size_rows'::text AS anomaly_type
FROM public.variant_warehouse_stock vws
JOIN public.product_variants pv ON pv.id = vws.variant_id
JOIN public.products p ON p.id = pv.product_id
JOIN public.warehouses w ON w.id = vws.warehouse_id
LEFT JOIN by_wh bw
  ON bw.variant_id = vws.variant_id
 AND bw.warehouse_id = vws.warehouse_id
WHERE COALESCE(vws.stock_qty, 0)::int IS DISTINCT FROM COALESCE(bw.sum_qty, 0)::int;

COMMENT ON VIEW public.vw_stock_audit_variant_warehouse_diff IS
  'V1 auditoria stock (readonly): diferencias entre variant_warehouse_stock y suma por deposito/talle.';

-- ============================================================================
-- 4) Orfandad: filas en variant_size_warehouse_stock sin fila en variant_sizes
-- ============================================================================
CREATE OR REPLACE VIEW public.vw_stock_audit_orphan_size_rows AS
SELECT
  p.id AS product_id,
  p.name AS product_name,
  pv.id AS variant_id,
  pv.color AS variant_color,
  pv.sku AS variant_sku,
  TRIM(COALESCE(sws.size::text, '')) AS size,
  sws.warehouse_id,
  w.code AS warehouse_code,
  COALESCE(sws.stock_qty, 0)::int AS size_wh_qty,
  'orphan_size_row_missing_variant_sizes'::text AS anomaly_type
FROM public.variant_size_warehouse_stock sws
JOIN public.product_variants pv ON pv.id = sws.variant_id
JOIN public.products p ON p.id = pv.product_id
JOIN public.warehouses w ON w.id = sws.warehouse_id
WHERE NOT EXISTS (
  SELECT 1
  FROM public.variant_sizes vs
  WHERE vs.variant_id = sws.variant_id
    AND TRIM(COALESCE(vs.size::text, '')) = TRIM(COALESCE(sws.size::text, ''))
);

COMMENT ON VIEW public.vw_stock_audit_orphan_size_rows IS
  'V1 auditoria stock (readonly): filas por talle/deposito sin fila madre en variant_sizes.';

-- ============================================================================
-- 5) Senales de trazabilidad (NO ledger completo)
-- ============================================================================
CREATE OR REPLACE VIEW public.vw_stock_audit_reference_signals AS
WITH order_sources AS (
  SELECT
    oi.id AS order_item_id,
    oi.order_id,
    oi.variant_id,
    oi.size,
    oi.quantity,
    oi.status,
    COALESCE(SUM(oiss.qty), 0)::int AS sources_qty_sum
  FROM public.order_items oi
  LEFT JOIN public.order_item_stock_sources oiss ON oiss.order_item_id = oi.id
  GROUP BY oi.id, oi.order_id, oi.variant_id, oi.size, oi.quantity, oi.status
)
SELECT
  'stock_history'::text AS signal_source,
  'history_event'::text AS signal_kind,
  sh.created_at AS event_at,
  'stock_history'::text AS reference_type,
  sh.id AS reference_id,
  'none'::text AS parent_reference_type,
  NULL::uuid AS parent_reference_id,
  COALESCE(sh.product_id, pv.product_id) AS product_id,
  sh.variant_id,
  NULLIF(TRIM(COALESCE(sh.size::text, '')), '') AS size,
  sh.warehouse_id,
  w.code AS warehouse_code,
  sh.from_warehouse_id,
  wf.code AS from_warehouse_code,
  sh.to_warehouse_id,
  wt.code AS to_warehouse_code,
  COALESCE(sh.quantity_changed, 0)::int AS qty,
  sh.change_type,
  NULL::text AS document_status,
  ('Historial ' || sh.id::text)::text AS reference_label,
  CASE
    WHEN sh.variant_id IS NOT NULL AND sh.warehouse_id IS NOT NULL THEN 'exact'
    WHEN sh.variant_id IS NOT NULL THEN 'partial'
    ELSE 'insufficient'
  END::text AS trace_status,
  CASE
    WHEN sh.variant_id IS NOT NULL AND sh.warehouse_id IS NOT NULL THEN 'history_row_with_variant_and_warehouse'
    ELSE 'reference_missing_or_ambiguous'
  END::text AS trace_reason,
  'review'::text AS severity
FROM public.stock_history sh
LEFT JOIN public.product_variants pv ON pv.id = sh.variant_id
LEFT JOIN public.warehouses w ON w.id = sh.warehouse_id
LEFT JOIN public.warehouses wf ON wf.id = sh.from_warehouse_id
LEFT JOIN public.warehouses wt ON wt.id = sh.to_warehouse_id

UNION ALL

SELECT
  'stock_movements'::text AS signal_source,
  'inter_warehouse_move'::text AS signal_kind,
  sm.created_at AS event_at,
  'stock_movement'::text AS reference_type,
  sm.id AS reference_id,
  'none'::text AS parent_reference_type,
  NULL::uuid AS parent_reference_id,
  pv.product_id AS product_id,
  sm.variant_id,
  NULL::text AS size,
  NULL::uuid AS warehouse_id,
  NULL::text AS warehouse_code,
  sm.from_warehouse_id,
  wf.code AS from_warehouse_code,
  sm.to_warehouse_id,
  wt.code AS to_warehouse_code,
  COALESCE(sm.qty, 0)::int AS qty,
  'inter_warehouse_move'::text AS change_type,
  NULL::text AS document_status,
  ('Movimiento ' || sm.id::text)::text AS reference_label,
  'partial'::text AS trace_status,
  'movement_row_without_size'::text AS trace_reason,
  'review'::text AS severity
FROM public.stock_movements sm
LEFT JOIN public.product_variants pv ON pv.id = sm.variant_id
LEFT JOIN public.warehouses wf ON wf.id = sm.from_warehouse_id
LEFT JOIN public.warehouses wt ON wt.id = sm.to_warehouse_id

UNION ALL

SELECT
  'order_item_stock_sources'::text AS signal_source,
  'order_reservation_trace'::text AS signal_kind,
  oiss.created_at AS event_at,
  'order_item'::text AS reference_type,
  oi.id AS reference_id,
  'order'::text AS parent_reference_type,
  oi.order_id AS parent_reference_id,
  pv.product_id AS product_id,
  oi.variant_id,
  CASE
    WHEN oi.size IS NULL OR TRIM(oi.size::text) = '' THEN NULL::text
    WHEN TRIM(oi.size::text) ~ '^\d+(\.\d+)?$' THEN split_part(TRIM(oi.size::text), '.', 1)
    ELSE TRIM(oi.size::text)
  END AS size,
  oiss.warehouse_id,
  w.code AS warehouse_code,
  NULL::uuid AS from_warehouse_id,
  NULL::text AS from_warehouse_code,
  NULL::uuid AS to_warehouse_id,
  NULL::text AS to_warehouse_code,
  COALESCE(oiss.qty, 0)::int AS qty,
  'order_reservation'::text AS change_type,
  oi.status AS document_status,
  ('Pedido ' || oi.order_id::text)::text AS reference_label,
  CASE
    WHEN os.sources_qty_sum = oi.quantity THEN 'exact'
    ELSE 'insufficient'
  END::text AS trace_status,
  CASE
    WHEN os.sources_qty_sum = oi.quantity THEN 'order_sources_complete'
    ELSE 'order_sources_qty_mismatch'
  END::text AS trace_reason,
  CASE
    WHEN os.sources_qty_sum = oi.quantity THEN 'review'
    ELSE 'critical'
  END::text AS severity
FROM public.order_item_stock_sources oiss
JOIN public.order_items oi ON oi.id = oiss.order_item_id
LEFT JOIN order_sources os ON os.order_item_id = oi.id
LEFT JOIN public.product_variants pv ON pv.id = oi.variant_id
LEFT JOIN public.warehouses w ON w.id = oiss.warehouse_id

UNION ALL

SELECT
  'public_sale_items'::text AS signal_source,
  'public_sale_trace'::text AS signal_kind,
  psi.created_at AS event_at,
  'public_sale_item'::text AS reference_type,
  psi.id AS reference_id,
  'public_sale'::text AS parent_reference_type,
  psi.sale_id AS parent_reference_id,
  pv.product_id AS product_id,
  psi.variant_id,
  NULLIF(TRIM(COALESCE(psi.sold_size_normalized::text, '')), '') AS size,
  CASE
    WHEN COALESCE(psi.qty_venta_publico, 0) > 0 AND COALESCE(psi.qty_general, 0) = 0 THEN wvp.id
    WHEN COALESCE(psi.qty_general, 0) > 0 AND COALESCE(psi.qty_venta_publico, 0) = 0 THEN wg.id
    ELSE NULL::uuid
  END AS warehouse_id,
  CASE
    WHEN COALESCE(psi.qty_venta_publico, 0) > 0 AND COALESCE(psi.qty_general, 0) = 0 THEN 'venta-publico'
    WHEN COALESCE(psi.qty_general, 0) > 0 AND COALESCE(psi.qty_venta_publico, 0) = 0 THEN 'general'
    WHEN COALESCE(psi.qty_venta_publico, 0) > 0 AND COALESCE(psi.qty_general, 0) > 0 THEN 'mixed'
    ELSE NULL::text
  END AS warehouse_code,
  NULL::uuid AS from_warehouse_id,
  NULL::text AS from_warehouse_code,
  NULL::uuid AS to_warehouse_id,
  NULL::text AS to_warehouse_code,
  COALESCE(psi.qty, 0)::int AS qty,
  CASE
    WHEN ps.voided_at IS NOT NULL AND COALESCE(psi.is_return, false) THEN 'public_return_void'
    WHEN ps.voided_at IS NOT NULL THEN 'public_sale_void'
    WHEN COALESCE(psi.is_return, false) THEN 'public_return'
    ELSE 'public_sale'
  END::text AS change_type,
  CASE WHEN ps.voided_at IS NULL THEN 'active' ELSE 'voided' END::text AS document_status,
  ('Venta pública ' || psi.sale_id::text)::text AS reference_label,
  CASE
    WHEN ((psi.qty_venta_publico IS NULL) <> (psi.qty_general IS NULL)) THEN 'insufficient'
    WHEN (psi.qty_venta_publico IS NULL AND psi.qty_general IS NULL) THEN 'legacy'
    WHEN NULLIF(TRIM(COALESCE(psi.sold_size_normalized::text, '')), '') IS NULL THEN 'partial'
    ELSE 'exact'
  END::text AS trace_status,
  CASE
    WHEN ((psi.qty_venta_publico IS NULL) <> (psi.qty_general IS NULL)) THEN 'reference_missing_or_ambiguous'
    WHEN (psi.qty_venta_publico IS NULL AND psi.qty_general IS NULL) AND ps.voided_at IS NOT NULL THEN 'public_sale_void_fallback_legacy'
    WHEN (psi.qty_venta_publico IS NULL AND psi.qty_general IS NULL) THEN 'public_sale_legacy_null_breakdown'
    WHEN NULLIF(TRIM(COALESCE(psi.sold_size_normalized::text, '')), '') IS NULL THEN 'public_sale_missing_sold_size'
    ELSE 'public_sale_split_traced'
  END::text AS trace_reason,
  CASE
    WHEN ((psi.qty_venta_publico IS NULL) <> (psi.qty_general IS NULL)) THEN 'critical'
    WHEN (psi.qty_venta_publico IS NULL AND psi.qty_general IS NULL) THEN 'warning'
    WHEN NULLIF(TRIM(COALESCE(psi.sold_size_normalized::text, '')), '') IS NULL THEN 'warning'
    ELSE 'review'
  END::text AS severity
FROM public.public_sale_items psi
LEFT JOIN public.public_sales ps ON ps.id = psi.sale_id
LEFT JOIN public.product_variants pv ON pv.id = psi.variant_id
LEFT JOIN public.warehouses wvp ON wvp.code = 'venta-publico'
LEFT JOIN public.warehouses wg ON wg.code = 'general'
WHERE psi.variant_id IS NOT NULL;

COMMENT ON VIEW public.vw_stock_audit_reference_signals IS
  'V1 auditoria stock (readonly): senales de trazabilidad de stock_history, stock_movements, order_item_stock_sources y public_sale_items.';

SELECT pg_notify('pgrst', 'reload schema');
