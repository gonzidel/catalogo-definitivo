-- 214 Fase A — Snapshot SOLO LECTURA.
-- Uso típico: ejecutar ANTES de aplicar 214 y guardar salida (evidencia BEFORE).
-- También puede ejecutarse DESPUÉS como línea base / evidencia AFTER.
-- Objetos: purchase_order_line_fulfillment, purchase_spend_by_season, vw_publication_events_performance
-- Guardar salida (CSV o copiar/pegar) para diff antes/después.

SELECT
  table_schema,
  table_name,
  grantee,
  string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privileges
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name IN (
    'purchase_order_line_fulfillment',
    'purchase_spend_by_season',
    'vw_publication_events_performance'
  )
  AND grantee IN ('anon', 'authenticated', 'service_role', 'PUBLIC')
GROUP BY table_schema, table_name, grantee
ORDER BY table_name, grantee;

-- Complemento: flags security_invoker (referencia; Fase A no los modifica)
SELECT
  c.relname AS view_name,
  c.reloptions
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'v'
  AND c.relname IN (
    'purchase_order_line_fulfillment',
    'purchase_spend_by_season',
    'vw_publication_events_performance'
  )
ORDER BY 1;
