-- Fix puntual y seguro
-- Caso: FYL-85-CH / size 36 / warehouse general
-- Objetivo: setear stock_qty = 50 en variant_size_warehouse_stock
-- Alcance: UNA sola fila objetivo (si existe)
-- Incluye: backup previo + update + verificacion

-- ============================================================================
-- 0) Parametros del fix puntual
-- ============================================================================
WITH params AS (
  SELECT
    'FYL-85-CH'::text AS target_sku,
    '36'::text AS target_size,
    'general'::text AS target_warehouse_code,
    50::int AS target_stock_qty,
    'Fix puntual validado por negocio: FYL-85-CH talle 36 debe quedar en 50'::text AS reason
)
SELECT * FROM params;

-- ============================================================================
-- 1) Tabla de backup (persistente)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.variant_size_warehouse_stock_manual_fix_backup (
  id bigserial PRIMARY KEY,
  backup_at timestamptz NOT NULL DEFAULT now(),
  fix_tag text NOT NULL,
  reason text NOT NULL,
  variant_id uuid NOT NULL,
  variant_sku text NOT NULL,
  product_id uuid NULL,
  product_name text NULL,
  variant_color text NULL,
  size text NOT NULL,
  warehouse_id uuid NOT NULL,
  warehouse_code text NOT NULL,
  stock_qty_before int NOT NULL,
  updated_at_before timestamptz NULL,
  changed_by text NULL DEFAULT 'manual_sql'
);

CREATE INDEX IF NOT EXISTS idx_vsws_manual_fix_backup_fix_tag
  ON public.variant_size_warehouse_stock_manual_fix_backup (fix_tag, backup_at DESC);

-- ============================================================================
-- 2) Preview de la fila objetivo (read-only)
-- ============================================================================
WITH params AS (
  SELECT
    'FYL-85-CH'::text AS target_sku,
    '36'::text AS target_size,
    'general'::text AS target_warehouse_code,
    50::int AS target_stock_qty
),
target AS (
  SELECT
    pv.id AS variant_id,
    pv.sku AS variant_sku,
    pv.color AS variant_color,
    p.id AS product_id,
    p.name AS product_name,
    w.id AS warehouse_id,
    w.code AS warehouse_code,
    pa.target_size,
    pa.target_stock_qty
  FROM params pa
  JOIN public.product_variants pv ON pv.sku = pa.target_sku
  JOIN public.products p ON p.id = pv.product_id
  JOIN public.warehouses w ON w.code = pa.target_warehouse_code
)
SELECT
  t.product_name,
  t.variant_color,
  t.variant_sku,
  t.variant_id,
  t.target_size AS size,
  t.warehouse_code,
  vsws.stock_qty AS stock_qty_current,
  t.target_stock_qty AS stock_qty_target,
  (t.target_stock_qty - COALESCE(vsws.stock_qty, 0))::int AS delta_to_apply,
  vsws.updated_at AS row_updated_at
FROM target t
LEFT JOIN public.variant_size_warehouse_stock vsws
  ON vsws.variant_id = t.variant_id
 AND TRIM(COALESCE(vsws.size::text, '')) = t.target_size
 AND vsws.warehouse_id = t.warehouse_id;

-- ============================================================================
-- 3) Backup previo de la fila afectada
-- ============================================================================
-- Nota:
--   Este INSERT hace backup SOLO si la fila objetivo existe.
WITH params AS (
  SELECT
    'FYL-85-CH'::text AS target_sku,
    '36'::text AS target_size,
    'general'::text AS target_warehouse_code,
    'fix_fyl_85_ch_size36_general_to_50_v1'::text AS fix_tag,
    'Fix puntual validado por negocio: FYL-85-CH talle 36 debe quedar en 50'::text AS reason
),
target_row AS (
  SELECT
    pa.fix_tag,
    pa.reason,
    pv.id AS variant_id,
    pv.sku AS variant_sku,
    p.id AS product_id,
    p.name AS product_name,
    pv.color AS variant_color,
    pa.target_size AS size,
    w.id AS warehouse_id,
    w.code AS warehouse_code,
    vsws.stock_qty AS stock_qty_before,
    vsws.updated_at AS updated_at_before
  FROM params pa
  JOIN public.product_variants pv ON pv.sku = pa.target_sku
  JOIN public.products p ON p.id = pv.product_id
  JOIN public.warehouses w ON w.code = pa.target_warehouse_code
  JOIN public.variant_size_warehouse_stock vsws
    ON vsws.variant_id = pv.id
   AND TRIM(COALESCE(vsws.size::text, '')) = pa.target_size
   AND vsws.warehouse_id = w.id
)
INSERT INTO public.variant_size_warehouse_stock_manual_fix_backup (
  fix_tag,
  reason,
  variant_id,
  variant_sku,
  product_id,
  product_name,
  variant_color,
  size,
  warehouse_id,
  warehouse_code,
  stock_qty_before,
  updated_at_before,
  changed_by
)
SELECT
  tr.fix_tag,
  tr.reason,
  tr.variant_id,
  tr.variant_sku,
  tr.product_id,
  tr.product_name,
  tr.variant_color,
  tr.size,
  tr.warehouse_id,
  tr.warehouse_code,
  tr.stock_qty_before,
  tr.updated_at_before,
  'manual_sql'::text
FROM target_row tr;

-- Ver backup recién creado:
SELECT
  id,
  backup_at,
  fix_tag,
  variant_sku,
  size,
  warehouse_code,
  stock_qty_before,
  reason
FROM public.variant_size_warehouse_stock_manual_fix_backup
WHERE fix_tag = 'fix_fyl_85_ch_size36_general_to_50_v1'
ORDER BY id DESC;

-- ============================================================================
-- 4) Update puntual (solo SKU + talle + deposito general)
-- ============================================================================
BEGIN;

WITH params AS (
  SELECT
    'FYL-85-CH'::text AS target_sku,
    '36'::text AS target_size,
    'general'::text AS target_warehouse_code,
    50::int AS target_stock_qty
),
target AS (
  SELECT
    pv.id AS variant_id,
    w.id AS warehouse_id,
    pa.target_size AS target_size,
    pa.target_stock_qty AS target_stock_qty
  FROM params pa
  JOIN public.product_variants pv ON pv.sku = pa.target_sku
  JOIN public.warehouses w ON w.code = pa.target_warehouse_code
)
UPDATE public.variant_size_warehouse_stock vsws
SET
  stock_qty = t.target_stock_qty,
  updated_at = now()
FROM target t
WHERE vsws.variant_id = t.variant_id
  AND TRIM(COALESCE(vsws.size::text, '')) = t.target_size
  AND vsws.warehouse_id = t.warehouse_id;

COMMIT;

-- ============================================================================
-- 5) Verificacion post-fix
-- ============================================================================
-- 5.1 Confirmar nuevo valor en variant_size_warehouse_stock (fila puntual)
WITH params AS (
  SELECT
    'FYL-85-CH'::text AS target_sku,
    '36'::text AS target_size,
    'general'::text AS target_warehouse_code,
    50::int AS expected_qty
)
SELECT
  p.name AS product_name,
  pv.color AS variant_color,
  pv.sku AS variant_sku,
  TRIM(COALESCE(vsws.size::text, '')) AS size,
  w.code AS warehouse_code,
  vsws.stock_qty,
  vsws.updated_at,
  CASE WHEN vsws.stock_qty = pa.expected_qty THEN 'ok' ELSE 'mismatch' END AS check_result
FROM params pa
JOIN public.product_variants pv ON pv.sku = pa.target_sku
JOIN public.products p ON p.id = pv.product_id
JOIN public.warehouses w ON w.code = pa.target_warehouse_code
LEFT JOIN public.variant_size_warehouse_stock vsws
  ON vsws.variant_id = pv.id
 AND TRIM(COALESCE(vsws.size::text, '')) = pa.target_size
 AND vsws.warehouse_id = w.id;

-- 5.2 Comparar vs variant_sizes para talle 36
WITH params AS (
  SELECT
    'FYL-85-CH'::text AS target_sku,
    '36'::text AS target_size,
    'general'::text AS target_warehouse_code
),
vs_qty AS (
  SELECT
    pv.id AS variant_id,
    COALESCE(vs.stock_qty, 0)::int AS variant_sizes_qty
  FROM params pa
  JOIN public.product_variants pv ON pv.sku = pa.target_sku
  LEFT JOIN public.variant_sizes vs
    ON vs.variant_id = pv.id
   AND TRIM(COALESCE(vs.size::text, '')) = pa.target_size
),
vsws_qty AS (
  SELECT
    pv.id AS variant_id,
    COALESCE(vsws.stock_qty, 0)::int AS size_wh_qty_general
  FROM params pa
  JOIN public.product_variants pv ON pv.sku = pa.target_sku
  JOIN public.warehouses w ON w.code = pa.target_warehouse_code
  LEFT JOIN public.variant_size_warehouse_stock vsws
    ON vsws.variant_id = pv.id
   AND TRIM(COALESCE(vsws.size::text, '')) = pa.target_size
   AND vsws.warehouse_id = w.id
)
SELECT
  p.name AS product_name,
  pv.color AS variant_color,
  pv.sku AS variant_sku,
  '36'::text AS size,
  vq.variant_sizes_qty,
  wq.size_wh_qty_general,
  (vq.variant_sizes_qty - wq.size_wh_qty_general)::int AS delta_variant_sizes_vs_general
FROM vs_qty vq
JOIN vsws_qty wq ON wq.variant_id = vq.variant_id
JOIN public.product_variants pv ON pv.id = vq.variant_id
JOIN public.products p ON p.id = pv.product_id;

-- 5.3 Confirmar en vista de auditoría que desaparece la diferencia para ese talle
SELECT
  product_name,
  variant_color,
  variant_sku,
  size,
  variant_sizes_qty,
  sum_size_warehouse_qty,
  delta,
  anomaly_type
FROM public.vw_stock_audit_variant_sizes_diff
WHERE variant_sku = 'FYL-85-CH'
  AND TRIM(COALESCE(size::text, '')) = '36';

-- Si la query 5.3 no devuelve filas, la diferencia para ese talle quedó resuelta.

