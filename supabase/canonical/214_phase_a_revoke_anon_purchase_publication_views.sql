-- 214_phase_a_revoke_anon_purchase_publication_views.sql
-- =============================================================================
-- FASE A (incremental): corregir deriva de grants en 3 vistas.
--
-- Objetivo
--   Quitar acceso de rol anon (y revocar herencia via PUBLIC) sobre vistas que
--   en canon solo deben ser consultadas por authenticated + service_role:
--     - public.purchase_order_line_fulfillment  (181_purchase_suppliers_module)
--     - public.purchase_spend_by_season         (181_purchase_suppliers_module)
--     - public.vw_publication_events_performance (192_publication_events_and_performance)
--
-- NO modifica: catalog_public_available_view, vw_stock_*, RPCs, Edge, frontend.
--
-- Pre-deploy (obligatorio)
--   Ejecutar: scripts/phase-a-pre-grants-snapshot.sql y guardar resultado.
--
-- Post-deploy
--   SQL: scripts/phase-a-verify-post-migration.sql
--   Reporte consolidado: doc/phase-a-reporte-deploy-2026-05-15.md
--   HTTP real PostgREST (anon + JWT admin + JWT no-admin opcional):
--     node scripts/phase-a-verify-postgrest.mjs
--     Ver cabecera del script para FYL_POSTGREST_ADMIN_ACCESS_TOKEN,
--     FYL_POSTGREST_CUSTOMER_ACCESS_TOKEN y modo estricto no-admin.
--   Smoke ligero anon-only: node scripts/audit-edge-public-surface.mjs
--
-- Rollback (emergencia)
--   supabase/canonical/214_phase_a_ROLLBACK_revoke_anon_undo.sql
--
-- Impacto esperado
--   - anon / usuarios solo con anon key: pierden lectura indebida de compras y
--     métricas de publicación; catálogo público y snapshot sin cambios.
--   - authenticated (admin) y service_role: SELECT explícito reafirmado.
--
-- Límite explícito de esta fase (validación honesta)
--   Esta migración NO impide que un JWT authenticated lea otras vistas analíticas
--   globales (p. ej. vw_stock_fast_sellers) si siguen con GRANT a authenticated;
--   eso queda para fases posteriores (RPC / revokes selectivos / etc.).
--
-- -----------------------------------------------------------------------------
-- Evaluación Fase B (SIN aplicar): security_invoker en vistas stock audit
--
-- Vistas: vw_stock_audit_reserved_qty_diff, vw_stock_audit_variant_warehouse_diff,
--         vw_stock_audit_health_score, vw_stock_audit_release_gate,
--         vw_stock_audit_alerts_current
--
-- Riesgo de pérdida del flag security_invoker=true:
--   - 175_stock_audit_bloque2_gate_reserved_qty.sql hace
--       DROP VIEW IF EXISTS public.vw_stock_audit_health_score CASCADE;
--     CASCADE elimina vistas dependientes (p. ej. release_gate, alerts_current)
--     si se recrean en el mismo archivo sin WITH (security_invoker=true), vuelven
--     al modo por defecto (owner / "definer-like" para el linter).
--   - 146_rpc_reconcile_stock.sql usa CREATE OR REPLACE VIEW sobre health_score,
--     release_gate, alerts_current: en Postgres 17, OR REPLACE conserva muchos
--     atributos de la relación, pero la práctica segura es: tras cualquier
--     CREATE OR REPLACE o DROP/CREATE en cadena, volver a ejecutar:
--       ALTER VIEW public.<nombre> SET (security_invoker = true);
--     o incluir WITH (security_invoker = true) en el CREATE VIEW si la versión
--     lo admite en la sentencia CREATE.
-- Conclusión: re-aplicar ALTER VIEW ... SET (security_invoker = true) es seguro
--   en cuanto a intención (alinea con 151), pero cualquier migración futura que
--   haga DROP CASCADE / recreación sin la opción volverá a borrar el flag.
--   Recomendación: checklist en migraciones que toquen esas vistas + prueba con
--   pg_class.reloptions @> array['security_invoker=true'].
-- -----------------------------------------------------------------------------
-- Atomicidad: en Supabase CLI / Dashboard el archivo suele ejecutarse en una
-- transacción implícita. No usar BEGIN/COMMIT aquí para evitar conflicto con el runner.

DO $guard$
BEGIN
  IF to_regclass('public.purchase_order_line_fulfillment') IS NULL THEN
    RAISE EXCEPTION '214: falta vista public.purchase_order_line_fulfillment';
  END IF;
  IF to_regclass('public.purchase_spend_by_season') IS NULL THEN
    RAISE EXCEPTION '214: falta vista public.purchase_spend_by_season';
  END IF;
  IF to_regclass('public.vw_publication_events_performance') IS NULL THEN
    RAISE EXCEPTION '214: falta vista public.vw_publication_events_performance';
  END IF;
END
$guard$;

-- Quitar exposición anon / herencia PUBLIC (deriva respecto a 181 / 192).
REVOKE ALL PRIVILEGES ON TABLE public.purchase_order_line_fulfillment FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.purchase_order_line_fulfillment FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.purchase_spend_by_season FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.purchase_spend_by_season FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.vw_publication_events_performance FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.vw_publication_events_performance FROM PUBLIC;

-- Estado deseado (idempotente): alinear con grants explícitos del canon.
GRANT SELECT ON TABLE public.purchase_order_line_fulfillment TO authenticated;
GRANT SELECT ON TABLE public.purchase_order_line_fulfillment TO service_role;

GRANT SELECT ON TABLE public.purchase_spend_by_season TO authenticated;
GRANT SELECT ON TABLE public.purchase_spend_by_season TO service_role;

GRANT SELECT ON TABLE public.vw_publication_events_performance TO authenticated;
GRANT SELECT ON TABLE public.vw_publication_events_performance TO service_role;

SELECT pg_notify('pgrst', 'reload schema');
