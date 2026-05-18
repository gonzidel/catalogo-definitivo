-- 219_add_detalles_similitud_to_catalog_views.sql
-- Añade columna "DetallesSimilitud" (product_tag_details) a vistas de catálogo.
--
-- DEPLOY: ejecutar en orden el SQL completo de:
--   1) supabase/canonical/04_catalog_public_view.sql
--   2) supabase/canonical/193_catalog_public_available_view.sql
--   3) el bloque ALTER snapshot de este archivo (legacy; preferir 222 tras 221 para paridad orden/tipos).
--
-- Rollback: 219_ROLLBACK_add_detalles_similitud_to_catalog_views.sql

ALTER TABLE public.catalog_public_snapshot
  ADD COLUMN IF NOT EXISTS "DetallesSimilitud" text DEFAULT '';

-- Tras aplicar 04+193, refrescar snapshot (admin):
-- SELECT public.rpc_refresh_catalog_public_snapshot();

select pg_notify('pgrst', 'reload schema');
