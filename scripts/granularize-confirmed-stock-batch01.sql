-- FYL — Granularización controlada de stock real confirmado (PILOTO)
--
-- Objetivo:
--   Sembrar soporte granular en variant_size_warehouse_stock (solo warehouse general)
--   para variantes confirmadas donde variant_sizes tiene stock real y falta granularidad.
--
-- Importante:
--   - NO toca variant_sizes
--   - NO toca variant_warehouse_stock
--   - NO corrige huérfanos ni reserved_qty
--   - Ejecutar por secciones (no todo junto) y validar cada paso
--
-- Piloto:
--   - 155 / FYL-155-NEG
--   - 85 / FYL-85-CH
--   - KNU / PA-KNU-NB
--   - Z97 / SU-Z97-BLA

-- ============================================================================
-- 0) Parámetros del lote
-- ============================================================================
WITH params AS (
  SELECT
    'granularize_confirmed_batch01'::text AS batch_id,
    'general'::text AS target_warehouse_code
)
SELECT * FROM params;

-- ============================================================================
-- 1) Tabla staging (persistente)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.variant_sizes_granularization_staging (
  id bigserial PRIMARY KEY,
  batch_id text NOT NULL,
  variant_id uuid NOT NULL,
  size text NOT NULL,
  target_warehouse_code text NOT NULL DEFAULT 'general',
  confirmed_stock_qty int NOT NULL CHECK (confirmed_stock_qty >= 0),
  confirmation_source text NOT NULL,
  confirmation_note text NULL,
  confirmed_by text NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','applied','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(batch_id, variant_id, size, target_warehouse_code)
);

CREATE INDEX IF NOT EXISTS idx_vs_gran_stage_batch
  ON public.variant_sizes_granularization_staging (batch_id, status);

CREATE INDEX IF NOT EXISTS idx_vs_gran_stage_variant
  ON public.variant_sizes_granularization_staging (variant_id);

-- ============================================================================
-- 2) Carga manual a staging (piloto)
-- ============================================================================
-- Opción recomendada para el piloto:
--   levantar desde variant_sizes (stock > 0) solo de las 4 variantes confirmadas.
--   Esto no ejecuta apply; solo prepara staging para revisión.
--
-- Si necesitás cargar valores manuales distintos, usar INSERT explícito por talla.
WITH params AS (
  SELECT
    'granularize_confirmed_batch01'::text AS batch_id,
    'general'::text AS target_warehouse_code
),
pilot_skus AS (
  SELECT * FROM (VALUES
    ('FYL-155-NEG'),
    ('FYL-85-CH'),
    ('PA-KNU-NB'),
    ('SU-Z97-BLA')
  ) AS t(variant_sku)
),
candidate_sizes AS (
  SELECT
    pv.id AS variant_id,
    pv.sku AS variant_sku,
    vs.size,
    COALESCE(vs.stock_qty, 0)::int AS confirmed_stock_qty
  FROM public.product_variants pv
  JOIN pilot_skus ps ON ps.variant_sku = pv.sku
  JOIN public.variant_sizes vs ON vs.variant_id = pv.id
  WHERE COALESCE(vs.stock_qty, 0) > 0
)
INSERT INTO public.variant_sizes_granularization_staging (
  batch_id,
  variant_id,
  size,
  target_warehouse_code,
  confirmed_stock_qty,
  confirmation_source,
  confirmation_note,
  confirmed_by,
  status
)
SELECT
  p.batch_id,
  c.variant_id,
  c.size,
  p.target_warehouse_code,
  c.confirmed_stock_qty,
  'manual_business_confirmation'::text,
  'Piloto inicial: stock real confirmado sin soporte granular'::text,
  'admin'::text,
  'approved'::text
FROM candidate_sizes c
CROSS JOIN params p
WHERE NOT EXISTS (
  SELECT 1
  FROM public.variant_sizes_granularization_staging s
  WHERE s.batch_id = p.batch_id
    AND s.variant_id = c.variant_id
    AND s.size = c.size
    AND s.target_warehouse_code = p.target_warehouse_code
);

-- Ver rápidamente qué quedó cargado en staging:
SELECT
  s.batch_id,
  p.name AS product_name,
  pv.color AS variant_color,
  pv.sku AS variant_sku,
  s.variant_id,
  s.size,
  s.confirmed_stock_qty,
  s.target_warehouse_code,
  s.status,
  s.confirmed_at
FROM public.variant_sizes_granularization_staging s
JOIN public.product_variants pv ON pv.id = s.variant_id
JOIN public.products p ON p.id = pv.product_id
WHERE s.batch_id = 'granularize_confirmed_batch01'
ORDER BY p.name, pv.color, s.size;

-- ============================================================================
-- 3) Preview del impacto (sin escribir stock)
-- ============================================================================
-- action_class:
--   - insert_missing_row
--   - fill_zero_row
--   - review_partial_existing
--   - skip_already_equal
WITH params AS (
  SELECT
    'granularize_confirmed_batch01'::text AS batch_id,
    'general'::text AS target_warehouse_code
),
wh AS (
  SELECT id, code
  FROM public.warehouses
  WHERE code = (SELECT target_warehouse_code FROM params)
  LIMIT 1
),
stage AS (
  SELECT
    s.*,
    CASE
      WHEN TRIM(COALESCE(s.size::text, '')) ~ '^\d+(\.\d+)?$'
        THEN split_part(TRIM(COALESCE(s.size::text, '')), '.', 1)
      ELSE TRIM(COALESCE(s.size::text, ''))
    END AS size_norm
  FROM public.variant_sizes_granularization_staging s
  WHERE s.batch_id = (SELECT batch_id FROM params)
    AND s.target_warehouse_code = (SELECT target_warehouse_code FROM params)
    AND s.status IN ('pending','approved')
),
current_granular AS (
  SELECT
    vsws.variant_id,
    CASE
      WHEN TRIM(COALESCE(vsws.size::text, '')) ~ '^\d+(\.\d+)?$'
        THEN split_part(TRIM(COALESCE(vsws.size::text, '')), '.', 1)
      ELSE TRIM(COALESCE(vsws.size::text, ''))
    END AS size_norm,
    vsws.stock_qty::int AS existing_granular_qty
  FROM public.variant_size_warehouse_stock vsws
  JOIN wh ON wh.id = vsws.warehouse_id
)
SELECT
  st.id AS staging_id,
  st.batch_id,
  p.name AS product_name,
  pv.color AS variant_color,
  pv.sku AS variant_sku,
  st.variant_id,
  st.size AS staging_size,
  st.size_norm,
  st.target_warehouse_code,
  st.confirmed_stock_qty,
  cg.existing_granular_qty AS existing_granular_qty_in_target_warehouse,
  (st.confirmed_stock_qty - COALESCE(cg.existing_granular_qty, 0))::int AS delta_to_seed,
  CASE
    WHEN cg.existing_granular_qty IS NULL THEN 'insert_missing_row'
    WHEN COALESCE(cg.existing_granular_qty, 0) = 0 AND st.confirmed_stock_qty > 0 THEN 'fill_zero_row'
    WHEN COALESCE(cg.existing_granular_qty, 0) = st.confirmed_stock_qty THEN 'skip_already_equal'
    ELSE 'review_partial_existing'
  END AS action_class
FROM stage st
JOIN public.product_variants pv ON pv.id = st.variant_id
JOIN public.products p ON p.id = pv.product_id
LEFT JOIN current_granular cg
  ON cg.variant_id = st.variant_id
 AND cg.size_norm = st.size_norm
ORDER BY
  CASE
    WHEN cg.existing_granular_qty IS NULL THEN 0
    WHEN COALESCE(cg.existing_granular_qty, 0) = 0 AND st.confirmed_stock_qty > 0 THEN 1
    WHEN COALESCE(cg.existing_granular_qty, 0) = st.confirmed_stock_qty THEN 3
    ELSE 2
  END,
  p.name, pv.color, st.size_norm;

-- ============================================================================
-- 4) Resumen del preview por clase de acción
-- ============================================================================
WITH params AS (
  SELECT
    'granularize_confirmed_batch01'::text AS batch_id,
    'general'::text AS target_warehouse_code
),
wh AS (
  SELECT id, code
  FROM public.warehouses
  WHERE code = (SELECT target_warehouse_code FROM params)
  LIMIT 1
),
stage AS (
  SELECT
    s.*,
    CASE
      WHEN TRIM(COALESCE(s.size::text, '')) ~ '^\d+(\.\d+)?$'
        THEN split_part(TRIM(COALESCE(s.size::text, '')), '.', 1)
      ELSE TRIM(COALESCE(s.size::text, ''))
    END AS size_norm
  FROM public.variant_sizes_granularization_staging s
  WHERE s.batch_id = (SELECT batch_id FROM params)
    AND s.target_warehouse_code = (SELECT target_warehouse_code FROM params)
    AND s.status IN ('pending','approved')
),
current_granular AS (
  SELECT
    vsws.variant_id,
    CASE
      WHEN TRIM(COALESCE(vsws.size::text, '')) ~ '^\d+(\.\d+)?$'
        THEN split_part(TRIM(COALESCE(vsws.size::text, '')), '.', 1)
      ELSE TRIM(COALESCE(vsws.size::text, ''))
    END AS size_norm,
    vsws.stock_qty::int AS existing_granular_qty
  FROM public.variant_size_warehouse_stock vsws
  JOIN wh ON wh.id = vsws.warehouse_id
),
preview AS (
  SELECT
    st.confirmed_stock_qty,
    CASE
      WHEN cg.existing_granular_qty IS NULL THEN 'insert_missing_row'
      WHEN COALESCE(cg.existing_granular_qty, 0) = 0 AND st.confirmed_stock_qty > 0 THEN 'fill_zero_row'
      WHEN COALESCE(cg.existing_granular_qty, 0) = st.confirmed_stock_qty THEN 'skip_already_equal'
      ELSE 'review_partial_existing'
    END AS action_class
  FROM stage st
  LEFT JOIN current_granular cg
    ON cg.variant_id = st.variant_id
   AND cg.size_norm = st.size_norm
)
SELECT
  action_class,
  COUNT(*)::int AS rows_count,
  SUM(confirmed_stock_qty)::int AS confirmed_stock_qty_total
FROM preview
GROUP BY action_class
ORDER BY action_class;

-- ============================================================================
-- 5) Apply transaccional (acotado a warehouse general y batch_id)
-- ============================================================================
-- Reglas:
--   - Solo action_class IN ('insert_missing_row','fill_zero_row')
--   - No tocar review_partial_existing
--   - No tocar skip_already_equal
--   - No tocar variant_sizes ni variant_warehouse_stock
--
-- Recomendación operativa:
--   correr primero preview + resumen, revisar manualmente, luego apply.
BEGIN;

WITH params AS (
  SELECT
    'granularize_confirmed_batch01'::text AS batch_id,
    'general'::text AS target_warehouse_code
),
wh AS (
  SELECT id, code
  FROM public.warehouses
  WHERE code = (SELECT target_warehouse_code FROM params)
  LIMIT 1
),
stage AS (
  SELECT
    s.id AS staging_id,
    s.batch_id,
    s.variant_id,
    s.size,
    CASE
      WHEN TRIM(COALESCE(s.size::text, '')) ~ '^\d+(\.\d+)?$'
        THEN split_part(TRIM(COALESCE(s.size::text, '')), '.', 1)
      ELSE TRIM(COALESCE(s.size::text, ''))
    END AS size_norm,
    s.confirmed_stock_qty
  FROM public.variant_sizes_granularization_staging s
  WHERE s.batch_id = (SELECT batch_id FROM params)
    AND s.target_warehouse_code = (SELECT target_warehouse_code FROM params)
    AND s.status = 'approved'
),
current_granular AS (
  SELECT
    vsws.variant_id,
    CASE
      WHEN TRIM(COALESCE(vsws.size::text, '')) ~ '^\d+(\.\d+)?$'
        THEN split_part(TRIM(COALESCE(vsws.size::text, '')), '.', 1)
      ELSE TRIM(COALESCE(vsws.size::text, ''))
    END AS size_norm,
    vsws.stock_qty::int AS existing_granular_qty
  FROM public.variant_size_warehouse_stock vsws
  JOIN wh ON wh.id = vsws.warehouse_id
),
to_apply AS (
  SELECT
    st.staging_id,
    st.variant_id,
    st.size_norm AS size_to_write,
    st.confirmed_stock_qty,
    CASE
      WHEN cg.existing_granular_qty IS NULL THEN 'insert_missing_row'
      WHEN COALESCE(cg.existing_granular_qty, 0) = 0 AND st.confirmed_stock_qty > 0 THEN 'fill_zero_row'
      WHEN COALESCE(cg.existing_granular_qty, 0) = st.confirmed_stock_qty THEN 'skip_already_equal'
      ELSE 'review_partial_existing'
    END AS action_class
  FROM stage st
  LEFT JOIN current_granular cg
    ON cg.variant_id = st.variant_id
   AND cg.size_norm = st.size_norm
),
upserted AS (
  INSERT INTO public.variant_size_warehouse_stock (
    variant_id,
    size,
    warehouse_id,
    stock_qty
  )
  SELECT
    ta.variant_id,
    ta.size_to_write,
    wh.id AS warehouse_id,
    ta.confirmed_stock_qty
  FROM to_apply ta
  CROSS JOIN wh
  WHERE ta.action_class IN ('insert_missing_row', 'fill_zero_row')
  ON CONFLICT (variant_id, size, warehouse_id)
  DO UPDATE SET
    stock_qty = EXCLUDED.stock_qty,
    updated_at = now()
  RETURNING variant_id, size, warehouse_id
)
UPDATE public.variant_sizes_granularization_staging s
SET
  status = 'applied'
WHERE s.id IN (
  SELECT ta.staging_id
  FROM to_apply ta
  WHERE ta.action_class IN ('insert_missing_row', 'fill_zero_row')
);

COMMIT;

-- ============================================================================
-- 6) Verify post-apply
-- ============================================================================
-- 6.1 Verificar cobertura del batch en warehouse general
WITH params AS (
  SELECT
    'granularize_confirmed_batch01'::text AS batch_id,
    'general'::text AS target_warehouse_code
),
wh AS (
  SELECT id
  FROM public.warehouses
  WHERE code = (SELECT target_warehouse_code FROM params)
  LIMIT 1
),
stage AS (
  SELECT
    s.id AS staging_id,
    s.batch_id,
    s.variant_id,
    s.size,
    CASE
      WHEN TRIM(COALESCE(s.size::text, '')) ~ '^\d+(\.\d+)?$'
        THEN split_part(TRIM(COALESCE(s.size::text, '')), '.', 1)
      ELSE TRIM(COALESCE(s.size::text, ''))
    END AS size_norm,
    s.confirmed_stock_qty,
    s.status
  FROM public.variant_sizes_granularization_staging s
  WHERE s.batch_id = (SELECT batch_id FROM params)
),
gran AS (
  SELECT
    vsws.variant_id,
    CASE
      WHEN TRIM(COALESCE(vsws.size::text, '')) ~ '^\d+(\.\d+)?$'
        THEN split_part(TRIM(COALESCE(vsws.size::text, '')), '.', 1)
      ELSE TRIM(COALESCE(vsws.size::text, ''))
    END AS size_norm,
    vsws.stock_qty::int AS granular_qty
  FROM public.variant_size_warehouse_stock vsws
  JOIN wh ON wh.id = vsws.warehouse_id
)
SELECT
  p.name AS product_name,
  pv.color AS variant_color,
  pv.sku AS variant_sku,
  st.size,
  st.confirmed_stock_qty,
  gr.granular_qty,
  (COALESCE(st.confirmed_stock_qty, 0) - COALESCE(gr.granular_qty, 0))::int AS delta_after_apply,
  st.status AS staging_status
FROM stage st
JOIN public.product_variants pv ON pv.id = st.variant_id
JOIN public.products p ON p.id = pv.product_id
LEFT JOIN gran gr
  ON gr.variant_id = st.variant_id
 AND gr.size_norm = st.size_norm
ORDER BY p.name, pv.color, st.size;

-- 6.2 Resumen por variante del batch
WITH params AS (
  SELECT
    'granularize_confirmed_batch01'::text AS batch_id,
    'general'::text AS target_warehouse_code
),
wh AS (
  SELECT id
  FROM public.warehouses
  WHERE code = (SELECT target_warehouse_code FROM params)
  LIMIT 1
),
stage AS (
  SELECT
    s.variant_id,
    CASE
      WHEN TRIM(COALESCE(s.size::text, '')) ~ '^\d+(\.\d+)?$'
        THEN split_part(TRIM(COALESCE(s.size::text, '')), '.', 1)
      ELSE TRIM(COALESCE(s.size::text, ''))
    END AS size_norm,
    s.confirmed_stock_qty
  FROM public.variant_sizes_granularization_staging s
  WHERE s.batch_id = (SELECT batch_id FROM params)
),
gran AS (
  SELECT
    vsws.variant_id,
    CASE
      WHEN TRIM(COALESCE(vsws.size::text, '')) ~ '^\d+(\.\d+)?$'
        THEN split_part(TRIM(COALESCE(vsws.size::text, '')), '.', 1)
      ELSE TRIM(COALESCE(vsws.size::text, ''))
    END AS size_norm,
    vsws.stock_qty::int AS granular_qty
  FROM public.variant_size_warehouse_stock vsws
  JOIN wh ON wh.id = vsws.warehouse_id
),
joined AS (
  SELECT
    st.variant_id,
    st.size_norm,
    st.confirmed_stock_qty,
    COALESCE(gr.granular_qty, 0)::int AS granular_qty
  FROM stage st
  LEFT JOIN gran gr
    ON gr.variant_id = st.variant_id
   AND gr.size_norm = st.size_norm
)
SELECT
  p.name AS product_name,
  pv.color AS variant_color,
  pv.sku AS variant_sku,
  COUNT(*)::int AS sizes_in_batch,
  SUM(joined.confirmed_stock_qty)::int AS confirmed_stock_total,
  SUM(joined.granular_qty)::int AS granular_stock_total_in_general,
  SUM(joined.confirmed_stock_qty - joined.granular_qty)::int AS total_delta
FROM joined
JOIN public.product_variants pv ON pv.id = joined.variant_id
JOIN public.products p ON p.id = pv.product_id
GROUP BY p.name, pv.color, pv.sku
ORDER BY p.name, pv.color;

-- 6.3 Rechequeo del grupo unsupported_stock para variantes del batch
WITH params AS (
  SELECT
    'granularize_confirmed_batch01'::text AS batch_id
),
batch_variants AS (
  SELECT DISTINCT variant_id
  FROM public.variant_sizes_granularization_staging
  WHERE batch_id = (SELECT batch_id FROM params)
),
sws AS (
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
  vs.size,
  COALESCE(vs.stock_qty, 0)::int AS variant_sizes_qty,
  COALESCE(sws.sum_size_warehouse_qty, 0)::int AS sum_size_warehouse_qty,
  (COALESCE(vs.stock_qty, 0)::int - COALESCE(sws.sum_size_warehouse_qty, 0)::int) AS delta
FROM public.variant_sizes vs
JOIN batch_variants bv ON bv.variant_id = vs.variant_id
JOIN public.product_variants pv ON pv.id = vs.variant_id
JOIN public.products p ON p.id = pv.product_id
LEFT JOIN sws
  ON sws.variant_id = vs.variant_id
 AND sws.size_norm = TRIM(COALESCE(vs.size::text, ''))
WHERE COALESCE(vs.stock_qty, 0)::int > 0
  AND COALESCE(sws.sum_size_warehouse_qty, 0)::int = 0
ORDER BY p.name, pv.color, vs.size;

