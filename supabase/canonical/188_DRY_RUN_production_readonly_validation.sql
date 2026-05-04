-- 188_DRY_RUN_production_readonly_validation.sql
--
-- Validación DRY-RUN en producción (o cualquier entorno): SOLO SELECT.
-- Simula el efecto agregado de un backfill al estilo 188 sobre el cohorte de
-- pedidos YA en estado final (sent / expired / devolución) que aún tienen
-- order_item_stock_sources.qty > 0, asumiendo ledger vacío (nunca liberado).
--
-- NO ejecuta migración 188, NO crea objetos, NO modifica datos.
--
-- Limitaciones del modelo agregado:
--   - 188 libera por PEDIDO (una vez por order_id). Si se procesaran N pedidos
--     en serie con GREATEST en cada UPDATE, el orden podría cambiar cuánto se
--     resta en casos límite cuando reserved_qty intermedio cae a 0 antes de
--     pedidos restantes. Aquí se muestra el agregado por variante (suma de
--     todas las liberaciones “teóricas”) frente al reserved_qty actual: sirve
--     para ver déficit y pinzar global; un script de backfill real debe ser
--     idempotente por pedido como en 188.
--
-- Estados excluyentes: coherente con release_reserved_qty_for_order (excluye
-- order_items.status = 'cancelled').


-- =============================================================================
-- 1) Pedidos que el backfill procesaría (estado final + fuentes > 0)
--     = cola histórica si hoy existiera 188 + ledger vacío
-- =============================================================================

SELECT
  o.id AS order_id,
  o.order_number,
  o.status AS order_status,
  o.updated_at,
  COUNT(DISTINCT oi.id) AS order_items_with_sources,
  SUM(COALESCE(s.qty, 0))::bigint AS oiss_units_on_order
FROM public.orders o
JOIN public.order_items oi ON oi.order_id = o.id
JOIN public.order_item_stock_sources s ON s.order_item_id = oi.id
WHERE o.status IN ('sent', 'expired', 'devolución')
  AND COALESCE(s.qty, 0) > 0
  AND COALESCE(oi.status, '') <> 'cancelled'
GROUP BY o.id, o.order_number, o.status, o.updated_at
ORDER BY o.updated_at DESC;


-- =============================================================================
-- 2) Pedidos closed con fuentes > 0 (NO entran al backfill; se liberarían al
--    pasar a sent/expired/devolución cuando exista el trigger 188)
-- =============================================================================

SELECT
  o.id AS order_id,
  o.order_number,
  o.status AS order_status,
  o.updated_at,
  SUM(COALESCE(s.qty, 0))::bigint AS oiss_units_on_order
FROM public.orders o
JOIN public.order_items oi ON oi.order_id = o.id
JOIN public.order_item_stock_sources s ON s.order_item_id = oi.id
WHERE o.status = 'closed'
  AND COALESCE(s.qty, 0) > 0
  AND COALESCE(oi.status, '') <> 'cancelled'
GROUP BY o.id, o.order_number, o.status, o.updated_at
ORDER BY o.updated_at DESC;


-- =============================================================================
-- 3) Cuánto se restaría de reserved_qty por variante (agregado backfill)
--     Suma sobre todos los pedidos del cohorte final de (1), por variant_id
-- =============================================================================

WITH cohort_orders AS (
  SELECT DISTINCT o.id AS order_id
  FROM public.orders o
  JOIN public.order_items oi ON oi.order_id = o.id
  JOIN public.order_item_stock_sources s ON s.order_item_id = oi.id
  WHERE o.status IN ('sent', 'expired', 'devolución')
    AND COALESCE(s.qty, 0) > 0
    AND COALESCE(oi.status, '') <> 'cancelled'
),
per_order_variant AS (
  SELECT
    oi.order_id,
    oi.variant_id,
    SUM(COALESCE(s.qty, 0))::int AS units
  FROM public.order_items oi
  JOIN public.order_item_stock_sources s ON s.order_item_id = oi.id
  JOIN cohort_orders c ON c.order_id = oi.order_id
  WHERE oi.variant_id IS NOT NULL
    AND COALESCE(s.qty, 0) > 0
    AND COALESCE(oi.status, '') <> 'cancelled'
  GROUP BY oi.order_id, oi.variant_id
)
SELECT
  pov.variant_id,
  pv.sku,
  pv.color,
  COUNT(DISTINCT pov.order_id) AS orders_contributing,
  SUM(pov.units)::bigint AS total_would_subtract_from_reserved
FROM per_order_variant pov
JOIN public.product_variants pv ON pv.id = pov.variant_id
GROUP BY pov.variant_id, pv.sku, pv.color
ORDER BY total_would_subtract_from_reserved DESC;


-- =============================================================================
-- 4) Variantes donde reserved_qty actual < resta agregada (pinchazo 188)
--     reserved_after_raw negativo => con GREATEST(0,...) la migración NO
--     “saca” del todo el fantasma agregado; hay sub-release respecto al total oiss
-- =============================================================================

WITH cohort_orders AS (
  SELECT DISTINCT o.id AS order_id
  FROM public.orders o
  JOIN public.order_items oi ON oi.order_id = o.id
  JOIN public.order_item_stock_sources s ON s.order_item_id = oi.id
  WHERE o.status IN ('sent', 'expired', 'devolución')
    AND COALESCE(s.qty, 0) > 0
    AND COALESCE(oi.status, '') <> 'cancelled'
),
per_order_variant AS (
  SELECT
    oi.order_id,
    oi.variant_id,
    SUM(COALESCE(s.qty, 0))::int AS units
  FROM public.order_items oi
  JOIN public.order_item_stock_sources s ON s.order_item_id = oi.id
  JOIN cohort_orders c ON c.order_id = oi.order_id
  WHERE oi.variant_id IS NOT NULL
    AND COALESCE(s.qty, 0) > 0
    AND COALESCE(oi.status, '') <> 'cancelled'
  GROUP BY oi.order_id, oi.variant_id
),
variant_subtract AS (
  SELECT variant_id, SUM(units)::bigint AS total_would_subtract
  FROM per_order_variant
  GROUP BY variant_id
)
SELECT
  v.variant_id,
  pv.sku,
  pv.color,
  COALESCE(pv.reserved_qty, 0)::int AS reserved_qty_now,
  v.total_would_subtract,
  (COALESCE(pv.reserved_qty, 0)::bigint - v.total_would_subtract) AS reserved_after_raw,
  GREATEST(COALESCE(pv.reserved_qty, 0)::bigint - v.total_would_subtract, 0::bigint)
    AS reserved_after_clamped_like_188,
  (v.total_would_subtract - COALESCE(pv.reserved_qty, 0)::bigint) AS deficit_if_subtract_all,
  CASE
    WHEN COALESCE(pv.reserved_qty, 0)::bigint < v.total_would_subtract THEN true
    ELSE false
  END AS variant_would_hit_clamp_on_aggregate_model
FROM variant_subtract v
JOIN public.product_variants pv ON pv.id = v.variant_id
WHERE COALESCE(pv.reserved_qty, 0)::bigint < v.total_would_subtract
ORDER BY deficit_if_subtract_all DESC;


-- =============================================================================
-- 5) Resumen cohorte backfill: conteos y unidades en fuentes
-- =============================================================================

SELECT
  COUNT(DISTINCT o.id) AS orders_final_with_positive_oiss,
  SUM(COALESCE(s.qty, 0))::bigint AS total_oiss_qty_sum_all_lines
FROM public.orders o
JOIN public.order_items oi ON oi.order_id = o.id
JOIN public.order_item_stock_sources s ON s.order_item_id = oi.id
WHERE o.status IN ('sent', 'expired', 'devolución')
  AND COALESCE(s.qty, 0) > 0
  AND COALESCE(oi.status, '') <> 'cancelled';


-- =============================================================================
-- 6) Cruce con auditoría actual (infladas que tocan variantes del cohorte)
-- =============================================================================

WITH cohort_orders AS (
  SELECT DISTINCT o.id AS order_id
  FROM public.orders o
  JOIN public.order_items oi ON oi.order_id = o.id
  JOIN public.order_item_stock_sources s ON s.order_item_id = oi.id
  WHERE o.status IN ('sent', 'expired', 'devolución')
    AND COALESCE(s.qty, 0) > 0
    AND COALESCE(oi.status, '') <> 'cancelled'
),
cohort_variants AS (
  SELECT DISTINCT oi.variant_id
  FROM public.order_items oi
  JOIN cohort_orders c ON c.order_id = oi.order_id
  WHERE oi.variant_id IS NOT NULL
)
SELECT
  d.variant_id,
  d.product_name,
  d.variant_sku,
  d.stored_reserved_qty,
  d.real_reserved_qty,
  d.delta,
  d.anomaly_type
FROM public.vw_stock_audit_reserved_qty_diff d
JOIN cohort_variants cv ON cv.variant_id = d.variant_id
WHERE d.anomaly_type = 'reserved_qty_inflated'
ORDER BY d.delta DESC;


-- =============================================================================
-- 7) Conteo global infladas (contexto; mismo KPI que stock-audit)
-- =============================================================================

SELECT
  count(*)::int AS inflated_variant_rows,
  coalesce(sum(delta), 0)::bigint AS sum_delta_inflated
FROM public.vw_stock_audit_reserved_qty_diff
WHERE anomaly_type = 'reserved_qty_inflated';


-- =============================================================================
-- 8) RIESGOS (lectura humana tras correr lo anterior)
-- =============================================================================
--
-- a) Pedidos expired por rpc_orders_daily_maintenance pueden tener oiss en 0
--    antes del cambio de estado: el trigger 188 vería suma 0 y no bajaría
--    reserved; el dry-run del cohorte (solo oiss>0) no los lista, pero pueden
--    seguir inflando la vista — revisar reconcile o migración 147.
--
-- b) Si la query (4) devuelve filas, reserved_qty actual no alcanza para absorber
--    la suma agregada de liberaciones: hay drift distinto de “solo pedidos
--    finales con oiss”, o orden de backfill/importancia de clamp.
--
-- c) Variantes compartidas por muchos pedidos finales acumulan total_would_subtract
--    alto; validar con (3) y con operación (órdenes reales de despacho).
--
-- d) Closed→sent futuro: lista en (2); al activar 188, esos pedidos liberarán al
--    enviar sin backfill manual de esas líneas.
--
-- e) Este script no simula tabla order_reserved_qty_released existente; si en
--    staging ya hubiera ledger, en prod pre-deploy no existe: el cohorte (1)
--    es el universo “pendiente” explícito.
