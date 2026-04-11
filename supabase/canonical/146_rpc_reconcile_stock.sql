-- 146_rpc_reconcile_stock.sql
-- Stock Audit V2:
-- 1) Vista health score con conteos globales y estado de triggers críticos.
-- 2) RPC para reconciliar tablas derivadas desde variant_size_warehouse_stock.

CREATE OR REPLACE VIEW public.vw_stock_audit_health_score AS
SELECT
  (SELECT count(*)::int FROM public.vw_stock_audit_variant_sizes_diff) AS variant_sizes_diffs,
  (SELECT count(*)::int FROM public.vw_stock_audit_variant_warehouse_diff) AS variant_warehouse_diffs,
  (SELECT count(*)::int FROM public.vw_stock_audit_orphan_size_rows) AS orphan_rows,
  (SELECT count(*)::int FROM public.vw_stock_audit_reference_signals WHERE severity = 'critical') AS critical_signals,
  (SELECT count(*)::int FROM public.vw_stock_audit_reference_signals WHERE severity = 'warning') AS warning_signals,
  (SELECT count(*)::int FROM public.vw_stock_audit_reference_signals WHERE severity = 'review') AS review_signals,
  (
    SELECT count(*)::int
    FROM (
      SELECT DISTINCT variant_id
      FROM public.vw_stock_audit_variant_sizes_diff
      WHERE variant_id IS NOT NULL
      UNION
      SELECT DISTINCT variant_id
      FROM public.vw_stock_audit_variant_warehouse_diff
      WHERE variant_id IS NOT NULL
      UNION
      SELECT DISTINCT variant_id
      FROM public.vw_stock_audit_orphan_size_rows
      WHERE variant_id IS NOT NULL
      UNION
      SELECT DISTINCT variant_id
      FROM public.vw_stock_audit_reference_signals
      WHERE variant_id IS NOT NULL
    ) variants
  ) AS affected_variants,
  (EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trigger_sync_variant_sizes_on_warehouse_stock'
  ))::boolean AS trigger_84_active,
  (EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trigger_sync_variant_warehouse_stock'
  ))::boolean AS trigger_145_active,
  now() AS measured_at;

COMMENT ON VIEW public.vw_stock_audit_health_score IS
  'Stock Audit V2: conteos globales de salud + verificación de triggers 84/145.';

CREATE OR REPLACE VIEW public.vw_stock_audit_release_gate AS
WITH hs AS (
  SELECT *
  FROM public.vw_stock_audit_health_score
)
SELECT
  hs.*,
  (hs.variant_sizes_diffs = 0) AS kpi_variant_sizes_diffs_ok,
  (hs.variant_warehouse_diffs = 0) AS kpi_variant_warehouse_diffs_ok,
  (hs.orphan_rows = 0) AS kpi_orphan_rows_ok,
  (hs.critical_signals = 0) AS kpi_critical_signals_ok,
  (hs.trigger_84_active AND hs.trigger_145_active) AS kpi_triggers_ok,
  (
    hs.variant_sizes_diffs = 0
    AND hs.variant_warehouse_diffs = 0
    AND hs.orphan_rows = 0
    AND hs.critical_signals = 0
    AND hs.trigger_84_active
    AND hs.trigger_145_active
  ) AS go_live_ready,
  CASE
    WHEN (
      hs.variant_sizes_diffs = 0
      AND hs.variant_warehouse_diffs = 0
      AND hs.orphan_rows = 0
      AND hs.critical_signals = 0
      AND hs.trigger_84_active
      AND hs.trigger_145_active
    ) THEN 'go'
    ELSE 'no-go'
  END AS release_decision,
  ARRAY_REMOVE(
    ARRAY[
      CASE WHEN hs.variant_sizes_diffs <> 0 THEN 'variant_sizes_diffs' END,
      CASE WHEN hs.variant_warehouse_diffs <> 0 THEN 'variant_warehouse_diffs' END,
      CASE WHEN hs.orphan_rows <> 0 THEN 'orphan_rows' END,
      CASE WHEN hs.critical_signals <> 0 THEN 'critical_signals' END,
      CASE WHEN NOT hs.trigger_84_active THEN 'trigger_84_inactive' END,
      CASE WHEN NOT hs.trigger_145_active THEN 'trigger_145_inactive' END
    ],
    NULL
  )::text[] AS blocking_reasons
FROM hs;

COMMENT ON VIEW public.vw_stock_audit_release_gate IS
  'Gate final de lanzamiento: decision go/no-go con KPIs bloqueantes y razones de bloqueo.';

CREATE OR REPLACE VIEW public.vw_stock_audit_alerts_current AS
WITH gate AS (
  SELECT *
  FROM public.vw_stock_audit_release_gate
)
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
  'Alertas automáticas actuales del stock audit (critical/warning/review) para monitoreo operativo.';

CREATE OR REPLACE FUNCTION public.rpc_reconcile_stock()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_uid uuid;
  v_is_admin boolean := false;
  v_before_vs_diff int := 0;
  v_before_vws_diff int := 0;
  v_before_orphans int := 0;
  v_after_vs_diff int := 0;
  v_after_vws_diff int := 0;
  v_after_orphans int := 0;
  v_updated_variant_sizes int := 0;
  v_inserted_variant_sizes int := 0;
  v_zeroed_variant_sizes int := 0;
  v_updated_variant_warehouse int := 0;
  v_inserted_variant_warehouse int := 0;
  v_zeroed_variant_warehouse int := 0;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    -- Permitir service_role para tareas operativas automatizadas.
    v_is_admin := COALESCE(current_setting('request.jwt.claim.role', true), '') = 'service_role';
    IF NOT v_is_admin THEN
      RAISE EXCEPTION 'No autenticado';
    END IF;
  ELSE
    SELECT EXISTS (
      SELECT 1
      FROM public.admins a
      WHERE a.user_id = v_uid
    ) INTO v_is_admin;
  END IF;

  IF NOT v_is_admin THEN
    RAISE EXCEPTION 'Solo administradores pueden reconciliar stock';
  END IF;

  SELECT count(*)::int INTO v_before_vs_diff
  FROM public.vw_stock_audit_variant_sizes_diff;

  SELECT count(*)::int INTO v_before_vws_diff
  FROM public.vw_stock_audit_variant_warehouse_diff;

  SELECT count(*)::int INTO v_before_orphans
  FROM public.vw_stock_audit_orphan_size_rows;

  -- 1) Reconciliar variant_sizes desde variant_size_warehouse_stock
  UPDATE public.variant_sizes vs
  SET
    stock_qty = sub.total_qty,
    updated_at = now()
  FROM (
    SELECT
      variant_id,
      TRIM(COALESCE(size::text, '')) AS size_norm,
      COALESCE(SUM(stock_qty), 0)::int AS total_qty
    FROM public.variant_size_warehouse_stock
    GROUP BY variant_id, TRIM(COALESCE(size::text, ''))
  ) sub
  WHERE vs.variant_id = sub.variant_id
    AND TRIM(COALESCE(vs.size::text, '')) = sub.size_norm
    AND vs.stock_qty IS DISTINCT FROM sub.total_qty;
  GET DIAGNOSTICS v_updated_variant_sizes = ROW_COUNT;

  INSERT INTO public.variant_sizes (variant_id, size, stock_qty, updated_at)
  SELECT
    sw.variant_id,
    TRIM(COALESCE(sw.size::text, '')),
    COALESCE(SUM(sw.stock_qty), 0)::int,
    now()
  FROM public.variant_size_warehouse_stock sw
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.variant_sizes vs
    WHERE vs.variant_id = sw.variant_id
      AND TRIM(COALESCE(vs.size::text, '')) = TRIM(COALESCE(sw.size::text, ''))
  )
  GROUP BY sw.variant_id, TRIM(COALESCE(sw.size::text, ''))
  ON CONFLICT (variant_id, size)
  DO UPDATE SET stock_qty = EXCLUDED.stock_qty, updated_at = now();
  GET DIAGNOSTICS v_inserted_variant_sizes = ROW_COUNT;

  UPDATE public.variant_sizes vs
  SET
    stock_qty = 0,
    updated_at = now()
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.variant_size_warehouse_stock sw
    WHERE sw.variant_id = vs.variant_id
      AND TRIM(COALESCE(sw.size::text, '')) = TRIM(COALESCE(vs.size::text, ''))
  )
  AND vs.stock_qty <> 0;
  GET DIAGNOSTICS v_zeroed_variant_sizes = ROW_COUNT;

  -- 2) Reconciliar variant_warehouse_stock desde variant_size_warehouse_stock
  UPDATE public.variant_warehouse_stock vws
  SET
    stock_qty = sub.total_qty,
    updated_at = now()
  FROM (
    SELECT
      variant_id,
      warehouse_id,
      COALESCE(SUM(stock_qty), 0)::int AS total_qty
    FROM public.variant_size_warehouse_stock
    GROUP BY variant_id, warehouse_id
  ) sub
  WHERE vws.variant_id = sub.variant_id
    AND vws.warehouse_id = sub.warehouse_id
    AND vws.stock_qty IS DISTINCT FROM sub.total_qty;
  GET DIAGNOSTICS v_updated_variant_warehouse = ROW_COUNT;

  INSERT INTO public.variant_warehouse_stock (variant_id, warehouse_id, stock_qty, updated_at)
  SELECT
    sw.variant_id,
    sw.warehouse_id,
    COALESCE(SUM(sw.stock_qty), 0)::int,
    now()
  FROM public.variant_size_warehouse_stock sw
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.variant_warehouse_stock vws
    WHERE vws.variant_id = sw.variant_id
      AND vws.warehouse_id = sw.warehouse_id
  )
  GROUP BY sw.variant_id, sw.warehouse_id
  ON CONFLICT (variant_id, warehouse_id)
  DO UPDATE SET stock_qty = EXCLUDED.stock_qty, updated_at = now();
  GET DIAGNOSTICS v_inserted_variant_warehouse = ROW_COUNT;

  UPDATE public.variant_warehouse_stock vws
  SET
    stock_qty = 0,
    updated_at = now()
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.variant_size_warehouse_stock sw
    WHERE sw.variant_id = vws.variant_id
      AND sw.warehouse_id = vws.warehouse_id
  )
  AND vws.stock_qty <> 0;
  GET DIAGNOSTICS v_zeroed_variant_warehouse = ROW_COUNT;

  SELECT count(*)::int INTO v_after_vs_diff
  FROM public.vw_stock_audit_variant_sizes_diff;

  SELECT count(*)::int INTO v_after_vws_diff
  FROM public.vw_stock_audit_variant_warehouse_diff;

  SELECT count(*)::int INTO v_after_orphans
  FROM public.vw_stock_audit_orphan_size_rows;

  RETURN json_build_object(
    'ok', true,
    'before', json_build_object(
      'variant_sizes_diffs', v_before_vs_diff,
      'variant_warehouse_diffs', v_before_vws_diff,
      'orphan_rows', v_before_orphans
    ),
    'after', json_build_object(
      'variant_sizes_diffs', v_after_vs_diff,
      'variant_warehouse_diffs', v_after_vws_diff,
      'orphan_rows', v_after_orphans
    ),
    'rows_changed', json_build_object(
      'variant_sizes_updated', v_updated_variant_sizes,
      'variant_sizes_inserted', v_inserted_variant_sizes,
      'variant_sizes_zeroed', v_zeroed_variant_sizes,
      'variant_warehouse_updated', v_updated_variant_warehouse,
      'variant_warehouse_inserted', v_inserted_variant_warehouse,
      'variant_warehouse_zeroed', v_zeroed_variant_warehouse
    )
  );
END;
$$;

COMMENT ON FUNCTION public.rpc_reconcile_stock() IS
  'Stock Audit V2: reconciliación masiva de tablas derivadas desde variant_size_warehouse_stock.';

GRANT EXECUTE ON FUNCTION public.rpc_reconcile_stock() TO authenticated, service_role;

SELECT pg_notify('pgrst', 'reload schema');
