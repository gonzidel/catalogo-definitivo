-- 379_arq05_fase0_public_cost_exposure.sql
--
-- ARQ-05 Fase 0 (SQL): quita a anon el acceso a costos y datos internos.
-- NO aplicada. Requiere autorización explícita, ensayo con rollback forzado
-- (379_arq05_fase0_public_cost_exposure_tests.sql) y deploy previo del NJ
-- sin lecturas de costo (rama hotfix/arq-05-exposicion-costos).
--
-- Alcance:
--   0b products            anon pasa de SELECT de tabla a SELECT por columna,
--                          sin cost / cost_is_estimated / price_percentage /
--                          logistic_amount. Filas sin cambios (RLS anon_select_products).
--   0c category_pricing_defaults
--                          anon sin privilegios; authenticated solo lee vía la
--                          política super_admin_write_pricing_defaults (ALL, super_admin).
--   0d suppliers           anon solo lee id y code (todas las filas).
--
-- Restricciones verificadas (2026-10-09, solo lectura):
--   * catalog_public_view es security_invoker y hace
--     LEFT JOIN suppliers s ON s.id = p.supplier_id -> anon necesita
--     products.supplier_id y suppliers(id, code) en TODAS las filas, si no
--     la vista falla (permiso de columna) o pierde "SupplierCode".
--   * get_meta_feed (invoker) usa products.supplier_id/last_published_at y
--     suppliers(id, code).
--   * find_similar_products / compute_similarity (invoker) usan id, name,
--     category, status.
--   * Ninguna lectura pública hace select('*') ni products(*) sobre products.
--   * Los codes de proveedor ya son públicos (SKUs y "SupplierCode" del snapshot).
--
-- Fuera de alcance (Fase 1): authenticated (clientes logueados) sigue leyendo
-- costos y nombres de proveedor; el rol es compartido con admins.
--
-- Columnas nuevas de products (p. ej. size_chart_id de 378) NO quedan
-- visibles para anon salvo GRANT explícito.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- 0b products
REVOKE SELECT ON public.products FROM anon;
GRANT SELECT (
  id,
  handle,
  name,
  description,
  status,
  category,
  supplier_id,
  created_at,
  updated_at,
  last_published_at,
  publication_status,
  pack_size,
  nuevos_ingresos_highlight_at,
  season,
  target_audience,
  width_cm,
  height_cm,
  length_cm,
  weight_kg
) ON public.products TO anon;

-- 0c category_pricing_defaults
REVOKE ALL ON public.category_pricing_defaults FROM anon;
DROP POLICY IF EXISTS authenticated_select_pricing_defaults ON public.category_pricing_defaults;

-- 0d suppliers
REVOKE ALL ON public.suppliers FROM anon;
GRANT SELECT (id, code) ON public.suppliers TO anon;

NOTIFY pgrst, 'reload schema';

COMMIT;
