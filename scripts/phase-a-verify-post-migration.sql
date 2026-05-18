-- 214 Fase A — Verificación post-migración (lectura).
-- Esperado: anon sin SELECT; authenticated y service_role con SELECT.
-- Complemento HTTP real: node scripts/phase-a-verify-postgrest.mjs

SELECT
  v.view_name,
  has_table_privilege('anon', format('public.%I', v.view_name), 'SELECT') AS anon_can_select,
  has_table_privilege('authenticated', format('public.%I', v.view_name), 'SELECT') AS authenticated_can_select,
  has_table_privilege('service_role', format('public.%I', v.view_name), 'SELECT') AS service_role_can_select
FROM (
  VALUES
    ('purchase_order_line_fulfillment'),
    ('purchase_spend_by_season'),
    ('vw_publication_events_performance')
) AS v(view_name);

-- Debe devolver 0 filas (anon no debe tener privilegios explícitos en estas vistas)
SELECT g.table_name, g.grantee, g.privilege_type
FROM information_schema.role_table_grants g
WHERE g.table_schema = 'public'
  AND g.table_name IN (
    'purchase_order_line_fulfillment',
    'purchase_spend_by_season',
    'vw_publication_events_performance'
  )
  AND g.grantee = 'anon'
ORDER BY 1, 3;

-- Catálogo público (no tocado por 214): snapshot sigue accesible a anon
SELECT has_table_privilege('anon', 'public.catalog_public_snapshot', 'SELECT') AS anon_snapshot_select;
