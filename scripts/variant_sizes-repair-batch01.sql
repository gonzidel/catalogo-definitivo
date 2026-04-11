-- FYL — Repair operativo acotado para:
-- variant_sizes_vs_sum_size_warehouse
--
-- Objetivo:
--   Corregir SOLO variant_sizes.stock_qty cuando no coincide con la suma real por talle
--   en variant_size_warehouse_stock.
--
-- Alcance:
--   - NO toca variant_size_warehouse_stock
--   - NO toca variant_warehouse_stock
--   - NO corrige huérfanos
--   - NO corrige reserved_qty
--
-- Recomendación:
--   Ejecutar por secciones y validar cada paso antes del siguiente.
--   Este archivo separa explícitamente:
--     A) PREVIEW GENERAL
--     B) PREVIEW PRIMER BATCH CONSERVADOR
--     C) BACKUP
--     D) UPDATE CONTROLADO
--     E) VERIFICACIÓN

-- ============================================================================
-- Parámetros del primer batch conservador
-- Editar repair_batch_id antes de usar backup/update reales.
-- ============================================================================
WITH repair_params AS (
  SELECT
    'repair_variant_sizes_batch01_manual'::text AS repair_batch_id,
    5::int AS max_abs_delta,
    2::int AS max_affected_sizes_per_variant
)
SELECT * FROM repair_params;

-- ============================================================================
-- Helper base (copiar en las consultas siguientes)
-- ============================================================================
-- - diff_base: universo general de diferencias variant_sizes vs suma real
-- - orphan_variants: variantes con talles huérfanos (excluir del batch)
-- - variant_affected: cantidad de talles afectados por variante

-- ============================================================================
-- A) PREVIEW GENERAL
-- Universo completo de la anomalía, con clasificación sugerida general.
-- NO usar este resultado directamente para el primer update conservador.
-- ============================================================================
WITH sws AS (
  SELECT
    sw.variant_id,
    TRIM(COALESCE(sw.size::text, '')) AS size_norm,
    SUM(COALESCE(sw.stock_qty, 0))::int AS expected_stock_qty
  FROM public.variant_size_warehouse_stock sw
  GROUP BY sw.variant_id, TRIM(COALESCE(sw.size::text, ''))
),
diff_base AS (
  SELECT
    p.id AS product_id,
    p.name AS product_name,
    pv.id AS variant_id,
    pv.color AS variant_color,
    pv.sku AS variant_sku,
    vs.id AS variant_size_id,
    vs.size,
    TRIM(COALESCE(vs.size::text, '')) AS size_norm,
    COALESCE(vs.stock_qty, 0)::int AS current_stock_qty,
    COALESCE(sws.expected_stock_qty, 0)::int AS expected_stock_qty,
    (COALESCE(vs.stock_qty, 0)::int - COALESCE(sws.expected_stock_qty, 0)::int) AS delta
  FROM public.variant_sizes vs
  JOIN public.product_variants pv ON pv.id = vs.variant_id
  JOIN public.products p ON p.id = pv.product_id
  LEFT JOIN sws
    ON sws.variant_id = vs.variant_id
   AND sws.size_norm = TRIM(COALESCE(vs.size::text, ''))
  WHERE COALESCE(vs.stock_qty, 0)::int IS DISTINCT FROM COALESCE(sws.expected_stock_qty, 0)::int
),
variant_affected AS (
  SELECT
    variant_id,
    COUNT(*)::int AS affected_sizes_count
  FROM diff_base
  GROUP BY variant_id
),
orphan_variants AS (
  SELECT DISTINCT sws.variant_id
  FROM public.variant_size_warehouse_stock sws
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.variant_sizes vs
    WHERE vs.variant_id = sws.variant_id
      AND TRIM(COALESCE(vs.size::text, '')) = TRIM(COALESCE(sws.size::text, ''))
  )
)
SELECT
  d.product_id,
  d.product_name,
  d.variant_id,
  d.variant_color,
  d.variant_sku,
  d.variant_size_id,
  d.size,
  d.current_stock_qty,
  d.expected_stock_qty,
  d.delta,
  va.affected_sizes_count,
  CASE
    WHEN d.expected_stock_qty = 0 AND d.current_stock_qty > 0 THEN 'historical_or_legacy_review'
    WHEN d.size_norm = '' THEN 'review_before_fix'
    WHEN d.size_norm !~ '^[A-Za-z0-9 .\-/]+$' THEN 'review_before_fix'
    WHEN ABS(d.delta) > 5 THEN 'review_before_fix'
    WHEN COALESCE(va.affected_sizes_count, 0) > 3 THEN 'review_before_fix'
    WHEN EXISTS (
      SELECT 1
      FROM orphan_variants ov
      WHERE ov.variant_id = d.variant_id
    ) THEN 'review_before_fix'
    ELSE 'safe_auto_fix'
  END AS suggested_fix_class
FROM diff_base d
LEFT JOIN variant_affected va
  ON va.variant_id = d.variant_id
ORDER BY
  ABS(d.delta) DESC,
  d.product_name,
  d.variant_color,
  d.size;

-- ============================================================================
-- B) PREVIEW PRIMER BATCH CONSERVADOR
-- Este es el subconjunto que SÍ puede entrar al primer lote.
-- Criterios:
--   - ABS(delta) <= 5
--   - sum_size_warehouse_qty > 0
--   - max 2 talles afectados por variante
--   - sin huérfanos
--   - sin talle vacío o formato sospechoso
-- ============================================================================
WITH repair_params AS (
  SELECT
    'repair_variant_sizes_batch01_manual'::text AS repair_batch_id,
    5::int AS max_abs_delta,
    2::int AS max_affected_sizes_per_variant
),
sws AS (
  SELECT
    sw.variant_id,
    TRIM(COALESCE(sw.size::text, '')) AS size_norm,
    SUM(COALESCE(sw.stock_qty, 0))::int AS expected_stock_qty
  FROM public.variant_size_warehouse_stock sw
  GROUP BY sw.variant_id, TRIM(COALESCE(sw.size::text, ''))
),
diff_base AS (
  SELECT
    p.name AS product_name,
    pv.color AS variant_color,
    pv.sku AS variant_sku,
    vs.id AS variant_size_id,
    vs.variant_id,
    vs.size,
    TRIM(COALESCE(vs.size::text, '')) AS size_norm,
    COALESCE(vs.stock_qty, 0)::int AS current_stock_qty,
    COALESCE(sws.expected_stock_qty, 0)::int AS expected_stock_qty,
    (COALESCE(vs.stock_qty, 0)::int - COALESCE(sws.expected_stock_qty, 0)::int) AS delta
  FROM public.variant_sizes vs
  JOIN public.product_variants pv ON pv.id = vs.variant_id
  JOIN public.products p ON p.id = pv.product_id
  LEFT JOIN sws
    ON sws.variant_id = vs.variant_id
   AND sws.size_norm = TRIM(COALESCE(vs.size::text, ''))
  WHERE COALESCE(vs.stock_qty, 0)::int IS DISTINCT FROM COALESCE(sws.expected_stock_qty, 0)::int
),
variant_affected AS (
  SELECT variant_id, COUNT(*)::int AS affected_sizes_count
  FROM diff_base
  GROUP BY variant_id
),
orphan_variants AS (
  SELECT DISTINCT sws.variant_id
  FROM public.variant_size_warehouse_stock sws
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.variant_sizes vs
    WHERE vs.variant_id = sws.variant_id
      AND TRIM(COALESCE(vs.size::text, '')) = TRIM(COALESCE(sws.size::text, ''))
  )
)
SELECT
  d.product_name,
  d.variant_color,
  d.variant_sku,
  d.size,
  d.current_stock_qty,
  d.expected_stock_qty,
  d.delta
FROM diff_base d
CROSS JOIN repair_params rp
LEFT JOIN variant_affected va
  ON va.variant_id = d.variant_id
WHERE d.size_norm <> ''
  AND d.size_norm ~ '^[A-Za-z0-9 .\-/]+$'
  AND d.expected_stock_qty > 0
  AND ABS(d.delta) <= rp.max_abs_delta
  AND COALESCE(va.affected_sizes_count, 0) <= rp.max_affected_sizes_per_variant
  AND NOT EXISTS (
    SELECT 1
    FROM orphan_variants ov
    WHERE ov.variant_id = d.variant_id
  )
ORDER BY ABS(d.delta) DESC, d.product_name, d.variant_color, d.size;

-- ============================================================================
-- C) BACKUP PERSISTENTE PREVIO
-- 1. Crear tabla de respaldo (una sola vez)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.variant_sizes_stock_repair_backup (
  id bigserial PRIMARY KEY,
  repair_batch_id text NOT NULL,
  backup_at timestamptz NOT NULL DEFAULT now(),
  variant_size_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  product_id uuid,
  product_name text,
  variant_color text,
  variant_sku text,
  size text NOT NULL,
  current_stock_qty int NOT NULL,
  expected_stock_qty int NOT NULL,
  delta int NOT NULL,
  suggested_fix_class text NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_variant_sizes_stock_repair_backup_batch
  ON public.variant_sizes_stock_repair_backup (repair_batch_id);

-- ============================================================================
-- C) BACKUP PERSISTENTE PREVIO
-- 2. Insertar SOLO el primer batch conservador
-- Ejecutar esto solo después de revisar el preview del batch.
-- ============================================================================
WITH repair_params AS (
  SELECT
    'repair_variant_sizes_batch01_manual'::text AS repair_batch_id,
    5::int AS max_abs_delta,
    2::int AS max_affected_sizes_per_variant
),
sws AS (
  SELECT
    sw.variant_id,
    TRIM(COALESCE(sw.size::text, '')) AS size_norm,
    SUM(COALESCE(sw.stock_qty, 0))::int AS expected_stock_qty
  FROM public.variant_size_warehouse_stock sw
  GROUP BY sw.variant_id, TRIM(COALESCE(sw.size::text, ''))
),
diff_base AS (
  SELECT
    p.id AS product_id,
    p.name AS product_name,
    pv.id AS variant_id,
    pv.color AS variant_color,
    pv.sku AS variant_sku,
    vs.id AS variant_size_id,
    vs.size,
    TRIM(COALESCE(vs.size::text, '')) AS size_norm,
    COALESCE(vs.stock_qty, 0)::int AS current_stock_qty,
    COALESCE(sws.expected_stock_qty, 0)::int AS expected_stock_qty,
    (COALESCE(vs.stock_qty, 0)::int - COALESCE(sws.expected_stock_qty, 0)::int) AS delta
  FROM public.variant_sizes vs
  JOIN public.product_variants pv ON pv.id = vs.variant_id
  JOIN public.products p ON p.id = pv.product_id
  LEFT JOIN sws
    ON sws.variant_id = vs.variant_id
   AND sws.size_norm = TRIM(COALESCE(vs.size::text, ''))
  WHERE COALESCE(vs.stock_qty, 0)::int IS DISTINCT FROM COALESCE(sws.expected_stock_qty, 0)::int
),
variant_affected AS (
  SELECT variant_id, COUNT(*)::int AS affected_sizes_count
  FROM diff_base
  GROUP BY variant_id
),
orphan_variants AS (
  SELECT DISTINCT sws.variant_id
  FROM public.variant_size_warehouse_stock sws
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.variant_sizes vs
    WHERE vs.variant_id = sws.variant_id
      AND TRIM(COALESCE(vs.size::text, '')) = TRIM(COALESCE(sws.size::text, ''))
  )
),
batch_preview AS (
  SELECT
    d.product_id,
    d.product_name,
    d.variant_id,
    d.variant_color,
    d.variant_sku,
    d.variant_size_id,
    d.size,
    d.current_stock_qty,
    d.expected_stock_qty,
    d.delta,
    'safe_auto_fix'::text AS suggested_fix_class
  FROM diff_base d
  CROSS JOIN repair_params rp
  LEFT JOIN variant_affected va
    ON va.variant_id = d.variant_id
  WHERE d.size_norm <> ''
    AND d.size_norm ~ '^[A-Za-z0-9 .\-/]+$'
    AND d.expected_stock_qty > 0
    AND ABS(d.delta) <= rp.max_abs_delta
    AND COALESCE(va.affected_sizes_count, 0) <= rp.max_affected_sizes_per_variant
    AND NOT EXISTS (
      SELECT 1
      FROM orphan_variants ov
      WHERE ov.variant_id = d.variant_id
    )
)
INSERT INTO public.variant_sizes_stock_repair_backup (
  repair_batch_id,
  variant_size_id,
  variant_id,
  product_id,
  product_name,
  variant_color,
  variant_sku,
  size,
  current_stock_qty,
  expected_stock_qty,
  delta,
  suggested_fix_class
)
SELECT
  rp.repair_batch_id,
  bp.variant_size_id,
  bp.variant_id,
  bp.product_id,
  bp.product_name,
  bp.variant_color,
  bp.variant_sku,
  bp.size,
  bp.current_stock_qty,
  bp.expected_stock_qty,
  bp.delta,
  bp.suggested_fix_class
FROM batch_preview bp
CROSS JOIN repair_params rp
WHERE NOT EXISTS (
  SELECT 1
  FROM public.variant_sizes_stock_repair_backup b
  WHERE b.repair_batch_id = rp.repair_batch_id
    AND b.variant_size_id = bp.variant_size_id
);

-- ============================================================================
-- D) REVISIÓN HUMANA FINAL DEL BACKUP
-- Validar el lote respaldado exacto antes de correr el update.
-- ============================================================================
SELECT
  product_name,
  variant_color,
  variant_sku,
  size,
  current_stock_qty,
  expected_stock_qty,
  delta
FROM public.variant_sizes_stock_repair_backup
WHERE repair_batch_id = 'repair_variant_sizes_batch01_manual'
ORDER BY ABS(delta) DESC, product_name, variant_color, size;

-- ============================================================================
-- E) UPDATE CONTROLADO
-- Ejecutar solo después de validar:
--   1. preview batch
--   2. backup insertado
--   3. revisión humana final del backup
-- ============================================================================
BEGIN;

UPDATE public.variant_sizes vs
SET
  stock_qty = b.expected_stock_qty,
  updated_at = now()
FROM public.variant_sizes_stock_repair_backup b
WHERE b.repair_batch_id = 'repair_variant_sizes_batch01_manual'
  AND b.suggested_fix_class = 'safe_auto_fix'
  AND vs.id = b.variant_size_id
  AND vs.stock_qty IS DISTINCT FROM b.expected_stock_qty;

COMMIT;

-- ============================================================================
-- F) VERIFICACIÓN POST-FIX DEL LOTE
-- 1. Estado del lote ya corregido
-- ============================================================================
SELECT
  b.repair_batch_id,
  COUNT(*) AS rows_in_batch,
  COUNT(*) FILTER (
    WHERE vs.stock_qty = b.expected_stock_qty
  ) AS resolved_rows,
  COUNT(*) FILTER (
    WHERE vs.stock_qty IS DISTINCT FROM b.expected_stock_qty
  ) AS still_misaligned_rows
FROM public.variant_sizes_stock_repair_backup b
JOIN public.variant_sizes vs
  ON vs.id = b.variant_size_id
WHERE b.repair_batch_id = 'repair_variant_sizes_batch01_manual'
GROUP BY b.repair_batch_id;

-- ============================================================================
-- F) VERIFICACIÓN POST-FIX DEL LOTE
-- 2. Rechequeo global de la anomalía
-- ============================================================================
WITH sws AS (
  SELECT
    variant_id,
    size,
    SUM(stock_qty)::int AS sum_qty
  FROM public.variant_size_warehouse_stock
  GROUP BY variant_id, size
)
SELECT
  vs.variant_id,
  vs.size,
  vs.stock_qty AS variant_sizes_qty,
  COALESCE(sws.sum_qty, 0) AS sum_size_warehouse_qty,
  vs.stock_qty - COALESCE(sws.sum_qty, 0) AS delta
FROM public.variant_sizes vs
LEFT JOIN sws
  ON sws.variant_id = vs.variant_id
 AND sws.size = vs.size
WHERE vs.stock_qty IS DISTINCT FROM COALESCE(sws.sum_qty, 0)
ORDER BY ABS(vs.stock_qty - COALESCE(sws.sum_qty, 0)) DESC;

-- ============================================================================
-- G) REAPARICIÓN
-- Recomendación:
--   - correr el preview batch nuevamente después del fix
--   - volver a correrlo tras una ventana operativa normal
-- Si reaparecen filas, investigar el flujo que vuelve a desalinear variant_sizes.
-- ============================================================================

-- ============================================================================
-- H) CASOS HISTÓRICOS/LEGACY FUERA DEL AUTO-FIX
-- Definición:
--   - sum_size_warehouse_qty = 0
--   - variant_sizes_qty > 0
-- Estos casos NO entran al batch 01 y se tratan por circuito separado.
-- ============================================================================

-- H.1 Detalle de casos historical_or_legacy_review
WITH sws AS (
  SELECT
    sw.variant_id,
    TRIM(COALESCE(sw.size::text, '')) AS size_norm,
    SUM(COALESCE(sw.stock_qty, 0))::int AS sum_size_warehouse_qty
  FROM public.variant_size_warehouse_stock sw
  GROUP BY sw.variant_id, TRIM(COALESCE(sw.size::text, ''))
)
SELECT
  p.name AS product_name,
  pv.color AS variant_color,
  pv.sku AS variant_sku,
  vs.variant_id,
  vs.size,
  COALESCE(vs.stock_qty, 0)::int AS variant_sizes_qty,
  COALESCE(sws.sum_size_warehouse_qty, 0)::int AS sum_size_warehouse_qty,
  (COALESCE(vs.stock_qty, 0)::int - COALESCE(sws.sum_size_warehouse_qty, 0)::int) AS delta,
  'historical_or_legacy_review'::text AS suggested_fix_class
FROM public.variant_sizes vs
JOIN public.product_variants pv ON pv.id = vs.variant_id
JOIN public.products p ON p.id = pv.product_id
LEFT JOIN sws
  ON sws.variant_id = vs.variant_id
 AND sws.size_norm = TRIM(COALESCE(vs.size::text, ''))
WHERE COALESCE(sws.sum_size_warehouse_qty, 0)::int = 0
  AND COALESCE(vs.stock_qty, 0)::int > 0
ORDER BY COALESCE(vs.stock_qty, 0)::int DESC, p.name, pv.color, vs.size;

-- H.2 Resumen: cuántos casos hay y qué variantes/productos concentran más
WITH sws AS (
  SELECT
    sw.variant_id,
    TRIM(COALESCE(sw.size::text, '')) AS size_norm,
    SUM(COALESCE(sw.stock_qty, 0))::int AS sum_size_warehouse_qty
  FROM public.variant_size_warehouse_stock sw
  GROUP BY sw.variant_id, TRIM(COALESCE(sw.size::text, ''))
),
legacy_cases AS (
  SELECT
    p.id AS product_id,
    p.name AS product_name,
    pv.id AS variant_id,
    pv.color AS variant_color,
    pv.sku AS variant_sku,
    vs.size,
    COALESCE(vs.stock_qty, 0)::int AS variant_sizes_qty
  FROM public.variant_sizes vs
  JOIN public.product_variants pv ON pv.id = vs.variant_id
  JOIN public.products p ON p.id = pv.product_id
  LEFT JOIN sws
    ON sws.variant_id = vs.variant_id
   AND sws.size_norm = TRIM(COALESCE(vs.size::text, ''))
  WHERE COALESCE(sws.sum_size_warehouse_qty, 0)::int = 0
    AND COALESCE(vs.stock_qty, 0)::int > 0
)
SELECT
  product_id,
  product_name,
  variant_id,
  variant_color,
  variant_sku,
  COUNT(*)::int AS affected_sizes_count,
  SUM(variant_sizes_qty)::int AS total_variant_sizes_qty_without_granular_support
FROM legacy_cases
GROUP BY product_id, product_name, variant_id, variant_color, variant_sku
ORDER BY total_variant_sizes_qty_without_granular_support DESC, affected_sizes_count DESC, product_name;

-- ============================================================================
-- I) FASE 2 DE ANÁLISIS (SIN UPDATE)
-- Grupo histórico/manual:
--   variant_sizes_qty > 0
--   sum_size_warehouse_qty = 0
-- ============================================================================

-- I.1 Clasificación en subgrupos por variante
-- Subgrupos:
--   - much_stock_without_support
--   - few_sizes_affected
--   - repeated_model_pattern
--   - isolated_variant
--
-- Umbrales sugeridos (ajustables):
--   - much_stock_threshold = 20 unidades sin soporte granular por variante
--   - repeated_model_threshold = 3 variantes con el mismo model_key
WITH params AS (
  SELECT
    20::int AS much_stock_threshold,
    3::int AS repeated_model_threshold
),
sws AS (
  SELECT
    sw.variant_id,
    TRIM(COALESCE(sw.size::text, '')) AS size_norm,
    SUM(COALESCE(sw.stock_qty, 0))::int AS sum_size_warehouse_qty
  FROM public.variant_size_warehouse_stock sw
  GROUP BY sw.variant_id, TRIM(COALESCE(sw.size::text, ''))
),
legacy_rows AS (
  SELECT
    p.id AS product_id,
    p.name AS product_name,
    pv.id AS variant_id,
    pv.color AS variant_color,
    pv.sku AS variant_sku,
    vs.size,
    COALESCE(vs.stock_qty, 0)::int AS variant_sizes_qty
  FROM public.variant_sizes vs
  JOIN public.product_variants pv ON pv.id = vs.variant_id
  JOIN public.products p ON p.id = pv.product_id
  LEFT JOIN sws
    ON sws.variant_id = vs.variant_id
   AND sws.size_norm = TRIM(COALESCE(vs.size::text, ''))
  WHERE COALESCE(vs.stock_qty, 0)::int > 0
    AND COALESCE(sws.sum_size_warehouse_qty, 0)::int = 0
),
legacy_variant AS (
  SELECT
    lr.product_id,
    lr.product_name,
    lr.variant_id,
    lr.variant_color,
    lr.variant_sku,
    COUNT(*)::int AS affected_sizes_count,
    SUM(lr.variant_sizes_qty)::int AS unsupported_stock_total,
    array_agg(lr.size ORDER BY lr.size) AS affected_sizes
  FROM legacy_rows lr
  GROUP BY lr.product_id, lr.product_name, lr.variant_id, lr.variant_color, lr.variant_sku
),
variant_with_model AS (
  SELECT
    lv.*,
    array_to_string((regexp_split_to_array(lower(trim(lv.product_name)), '\s+'))[1:3], ' ') AS model_key
  FROM legacy_variant lv
),
model_stats AS (
  SELECT
    model_key,
    COUNT(DISTINCT variant_id)::int AS variants_in_model,
    COUNT(DISTINCT product_id)::int AS products_in_model,
    SUM(unsupported_stock_total)::int AS model_unsupported_stock_total
  FROM variant_with_model
  GROUP BY model_key
)
SELECT
  vwm.product_id,
  vwm.product_name,
  vwm.variant_id,
  vwm.variant_color,
  vwm.variant_sku,
  vwm.affected_sizes_count,
  vwm.unsupported_stock_total,
  vwm.affected_sizes,
  vwm.model_key,
  ms.variants_in_model,
  ms.products_in_model,
  ms.model_unsupported_stock_total,
  CASE
    WHEN vwm.unsupported_stock_total >= p.much_stock_threshold THEN 'much_stock_without_support'
    WHEN ms.variants_in_model >= p.repeated_model_threshold THEN 'repeated_model_pattern'
    WHEN vwm.affected_sizes_count <= 2 THEN 'few_sizes_affected'
    ELSE 'isolated_variant'
  END AS subgroup
FROM variant_with_model vwm
JOIN model_stats ms ON ms.model_key = vwm.model_key
CROSS JOIN params p
ORDER BY
  vwm.unsupported_stock_total DESC,
  ms.variants_in_model DESC,
  vwm.product_name,
  vwm.variant_color;

-- I.2 Resumen por producto/modelo (familias completas afectadas)
-- Esto ayuda a detectar concentración del problema por familia/modelo.
WITH sws AS (
  SELECT
    sw.variant_id,
    TRIM(COALESCE(sw.size::text, '')) AS size_norm,
    SUM(COALESCE(sw.stock_qty, 0))::int AS sum_size_warehouse_qty
  FROM public.variant_size_warehouse_stock sw
  GROUP BY sw.variant_id, TRIM(COALESCE(sw.size::text, ''))
),
legacy_rows AS (
  SELECT
    p.id AS product_id,
    p.name AS product_name,
    pv.id AS variant_id,
    pv.color AS variant_color,
    pv.sku AS variant_sku,
    vs.size,
    COALESCE(vs.stock_qty, 0)::int AS variant_sizes_qty
  FROM public.variant_sizes vs
  JOIN public.product_variants pv ON pv.id = vs.variant_id
  JOIN public.products p ON p.id = pv.product_id
  LEFT JOIN sws
    ON sws.variant_id = vs.variant_id
   AND sws.size_norm = TRIM(COALESCE(vs.size::text, ''))
  WHERE COALESCE(vs.stock_qty, 0)::int > 0
    AND COALESCE(sws.sum_size_warehouse_qty, 0)::int = 0
),
legacy_variant AS (
  SELECT
    lr.product_id,
    lr.product_name,
    lr.variant_id,
    lr.variant_color,
    lr.variant_sku,
    COUNT(*)::int AS affected_sizes_count,
    SUM(lr.variant_sizes_qty)::int AS unsupported_stock_total
  FROM legacy_rows lr
  GROUP BY lr.product_id, lr.product_name, lr.variant_id, lr.variant_color, lr.variant_sku
),
variant_with_model AS (
  SELECT
    lv.*,
    array_to_string((regexp_split_to_array(lower(trim(lv.product_name)), '\s+'))[1:3], ' ') AS model_key
  FROM legacy_variant lv
)
SELECT
  model_key,
  COUNT(DISTINCT product_id)::int AS products_affected,
  COUNT(DISTINCT variant_id)::int AS variants_affected,
  SUM(affected_sizes_count)::int AS affected_sizes_total,
  SUM(unsupported_stock_total)::int AS unsupported_stock_total,
  MIN(product_name) AS sample_product_name
FROM variant_with_model
GROUP BY model_key
ORDER BY unsupported_stock_total DESC, variants_affected DESC, products_affected DESC;

-- I.3 Detalle por variante (vista operativa)
-- Columnas solicitadas:
--   - producto
--   - color
--   - sku
--   - cantidad de talles afectados
--   - stock total sin soporte granular
WITH sws AS (
  SELECT
    sw.variant_id,
    TRIM(COALESCE(sw.size::text, '')) AS size_norm,
    SUM(COALESCE(sw.stock_qty, 0))::int AS sum_size_warehouse_qty
  FROM public.variant_size_warehouse_stock sw
  GROUP BY sw.variant_id, TRIM(COALESCE(sw.size::text, ''))
),
legacy_rows AS (
  SELECT
    p.name AS product_name,
    pv.color AS variant_color,
    pv.sku AS variant_sku,
    pv.id AS variant_id,
    vs.size,
    COALESCE(vs.stock_qty, 0)::int AS variant_sizes_qty
  FROM public.variant_sizes vs
  JOIN public.product_variants pv ON pv.id = vs.variant_id
  JOIN public.products p ON p.id = pv.product_id
  LEFT JOIN sws
    ON sws.variant_id = vs.variant_id
   AND sws.size_norm = TRIM(COALESCE(vs.size::text, ''))
  WHERE COALESCE(vs.stock_qty, 0)::int > 0
    AND COALESCE(sws.sum_size_warehouse_qty, 0)::int = 0
)
SELECT
  lr.product_name,
  lr.variant_color,
  lr.variant_sku,
  COUNT(*)::int AS affected_sizes_count,
  SUM(lr.variant_sizes_qty)::int AS unsupported_stock_total
FROM legacy_rows lr
GROUP BY lr.product_name, lr.variant_color, lr.variant_sku
ORDER BY unsupported_stock_total DESC, affected_sizes_count DESC, lr.product_name, lr.variant_color;
