# PERF-013 — Cache SWR local del payload de boot (Fase 1)

- **Estado:** implementado (2026-06-07)
- **Severidad:** alta (segunda visita / navegación repetida)
- **Área:** boot del catálogo (`cat === "all"`)
- **Relacionado:** [[PERF-001-LCP-Round-Trips-Supabase]]

## Problema

Cada visita a `/index` o `/catalogo` consultaba Supabase antes del primer paint, incluso en la segunda visita. En mobile/3G la demora era perceptible.

## Solución (Fase 1 aprobada)

Patrón **stale-while-revalidate (SWR)** en `localStorage`:

1. **Camino crítico (sync, cero red):** si hay cache válida → pintar al instante.
2. **Background (async):** revalidar boot fetch + `catalog_version` opcional; re-render suave si difiere.
3. **No se cachea:** stock detallado, catálogo completo, HTML, Service Worker.

### Restricciones de diseño

| Regla | Implementación |
|---|---|
| Cache hit sin red | `isUsableOnCriticalPath()` solo valida `FYL_VERSION` + TTL 15 min + shape |
| `catalog_version` en background | `getCatalogVersion()` solo en `scheduleBootCacheRevalidation` |
| TTL | 15 minutos (`CATALOG_BOOT_CACHE_TTL_MS`) |
| Guard de tamaño | `CATALOG_BOOT_CACHE_MAX_BYTES` = 1.5 MB — no escribe si excede |
| Fallback silencioso | try/catch en read/write; sin toast |
| SW | `sw.js` no modificado |

## Archivos

| Archivo | Rol |
|---|---|
| `scripts/catalog-cache.js` | read/write/TTL/guard/fingerprint |
| `scripts/main-supabase.js` | hook en `cargarDesdeSupabaseAllLike`, `scheduleBootCacheRevalidation` |
| `scripts/catalog-source.js` | `getCatalogVersion()` (RPC o meta; solo background) |
| `supabase/canonical/232_expose_catalog_snapshot_version_anon.sql` | Fase 1.5 preparada — **no aplicada en prod sin aprobación** |

## Clave de cache

- Key: `fyl_catalog_boot_v1`
- Payload: `{ appVersion, catalogVersion, savedAt, rows, count }`
- Alcance: ~120 filas del boot home (`fetchCatalogPublicRowsBoot`), filtradas por `Mostrar`

## Métricas (`fylPerf`)

- `catalog_cache_hit` / `catalog_cache_miss`
- `catalog_render_from_cache`
- `catalog_revalidate_done` / `catalog_revalidate_error`
- `catalog_version_diff`
- `catalog_cache_storage_error` (quota/parse/oversized)

## Verificación

1. **1ª visita:** miss → fetch Supabase → escribe cache (si pasa guard).
2. **2ª visita:** hit → **cero requests Supabase antes del primer render**; revalidación arranca después.
3. Network panel en cache hit: no fetch de boot ni `catalog_version` antes del paint.
4. Carrito, PDP por SKU, filtros, checkout: sin regresiones.
5. Stock inválido: enrich + checkout impiden compra (sin cambios en esas capas).

## Rollback

- Revertir imports y hook en `main-supabase.js`.
- Eliminar `scripts/catalog-cache.js`.
- Opcional: `localStorage.removeItem('fyl_catalog_boot_v1')` en consola para usuarias afectadas.

## Deuda / Fase 1.5

- Aplicar `232_expose_catalog_snapshot_version_anon.sql` en prod (con aprobación) para invalidación precisa por `refreshed_at` en background.
- Sin Fase 1.5: invalidación local por `FYL_VERSION` + TTL 15 min; diff de filas en revalidación background.

## Cruces

- [[PERF-001-LCP-Round-Trips-Supabase]]
- [[../Arquitectura/01-Boot-Sequence-Catalogo]]
- [[../../36-CATALOGO-SNAPSHOT-REFRESH-2026-05-15]]
