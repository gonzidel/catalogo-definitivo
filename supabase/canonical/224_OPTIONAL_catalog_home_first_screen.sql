-- OPTIONAL (Fase 5): primera pantalla del catálogo sin full-scan.
-- NO aplicar en producción sin aprobación explícita y plan de rollback.
--
-- Objetivo: RPC/view que devuelva ~50–120 filas ordenadas para Home (LCP),
-- mientras el cliente sigue cargando el catálogo completo en idle.
--
-- Ver: docs/FYL-Obsidian/FYL-Product/Performance/2026-05-18-Implementacion-CWV.md

-- Placeholder documental — implementar cuando HI-2 requiera server-side slice.
