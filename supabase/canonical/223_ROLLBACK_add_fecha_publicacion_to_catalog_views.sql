-- 223_ROLLBACK_add_fecha_publicacion_to_catalog_views.sql
-- Restaura catalog_public_available_view sin "FechaPublicacion" (estado 221).
-- Tras apply: select public.fyl_rebuild_catalog_public_snapshot_parity(true);

\i 221_catalog_public_available_view_add_variant_id.sql

-- Nota: la columna "FechaPublicacion" en snapshot puede quedar orphan; 222 rebuild la alinea.
