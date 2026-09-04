# Buscador FYL — Fase 5 admin de vocabulario (2026-09-03)

**Estado:** implementación en `/nj/admin/search`. Migración `329_search_admin.sql`.

## Qué es

Herramienta de administración del diccionario (`search_keywords` / `search_aliases`) apoyada en `search_events`. **Analytics sugiere. Administrador decide. Buscador ejecuta.** No hay alta automática de aliases. No se tocan `tags`.

## Contratos

- Permiso frontend: `search` + `is_admin()` en DB (mismo patrón que productos / conciliación).
- Agregaciones solo en PostgreSQL (RPCs). El browser no descarga `search_events`.
- Uso de keyword: `resolutions` JSON + identity (`resolutions=[]` y `query_resolved = canonical`).
- Candidatos ignorados: `search_ignored_terms` (no mezclar con aliases). Restaurables.
- Cache del diccionario: `publishSearchDictionaryChange()` + SWR mutate. No esperar 60s.

## Rollback

`supabase/canonical/329_ROLLBACK_search_admin.sql` — dropea RPCs + `search_ignored_terms`. No toca 327/328.

## Eventos de prueba

Hay inserts de desarrollo en live (`xyzabc`, `pantubotas`, etc.). No borrar sin avisar. Excluir por término o por fecha de go-live.

## Próximo

Limpieza de tags duplicados, candidatos reales tras días de analytics, ranking por clicks.
