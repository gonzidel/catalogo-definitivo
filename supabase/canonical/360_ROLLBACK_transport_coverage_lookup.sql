-- 360_ROLLBACK_transport_coverage_lookup.sql
-- Revierte 360_transport_coverage_lookup.sql
--
-- IMPORTANTE: NO borra public.fn_canonicalize_transport_name ni
-- public.fn_normalize_transport_key — son funciones preexistentes del
-- módulo COD, esta migración solo las reutiliza, no las creó.

DROP FUNCTION IF EXISTS public.fn_transportes_disponibles(text, text);
DROP FUNCTION IF EXISTS public.fn_transport_coverage_normalize_locality(text);
DROP TABLE IF EXISTS public.transport_coverage;
