-- Fase B — SOLO evaluación (lectura). No aplica ALTER VIEW.
-- Comprueba el flag security_invoker actual en las vistas stock audit afectadas.

SELECT
  c.relname AS view_name,
  CASE
    WHEN c.reloptions @> ARRAY['security_invoker=true'] THEN 'invoker'
    ELSE 'owner_default'
  END AS security_mode,
  c.reloptions
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'v'
  AND c.relname IN (
    'vw_stock_audit_reserved_qty_diff',
    'vw_stock_audit_variant_warehouse_diff',
    'vw_stock_audit_health_score',
    'vw_stock_audit_release_gate',
    'vw_stock_audit_alerts_current'
  )
ORDER BY 1;
