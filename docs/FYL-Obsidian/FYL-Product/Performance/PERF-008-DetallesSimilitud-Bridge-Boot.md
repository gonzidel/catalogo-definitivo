# PERF-008 — Bridge `DetallesSimilitud` en boot por SELECT incompleto

- **Estado:** abierto
- **Severidad:** crítico (si migración 219 aplicada en prod)
- **Detectado:** 2026-05-23 — [[2026-05-23-Auditoria-LCP-Catalogo-Clarity]]
- **Métrica afectada:** LCP
- **Área:** boot Home, `fetchCatalogPublicRowsBoot`

## Síntoma

Cold load de `/catalogo` dispara requests extra a `product_tag_details` + `products` aunque la vista de catálogo ya podría traer `DetallesSimilitud`.

## Causa raíz

`CATALOG_PUBLIC_SELECT` en `scripts/main-supabase.js` L117–118 **no incluye** `"DetallesSimilitud"` (comentario: “Sin DetallesSimilitud hasta migración 219”).

`enrichCatalogRowsWithDetallesSimilitud` (`scripts/commercial-tags.js` L225–228) usa:

```js
catalogRowsExposeDetallesSimilitud(rows) // Object.hasOwnProperty(row, "DetallesSimilitud")
```

PostgREST no devuelve propiedades no pedidas en `.select()` → `hasFromView === false` → `fetchDetallesSimilitudByArticulo()` L240–241 (múltiples páginas).

Migraciones con columna en vista: `supabase/canonical/219_add_detalles_similitud_to_catalog_views.sql`, `222_snapshot_parity_detalles_similitud.sql`.

## Impacto LCP

**Directo** si el bridge corre en el await del boot (L733). Estimado +0.5–2 s en 4G/WebView.

## Plan de fix

1. Añadir `"DetallesSimilitud"` a `CATALOG_PUBLIC_SELECT`.
2. Verificar en Network: `fylPerf("commercial_early_return")` y **cero** `commercial_bridge` en boot.
3. Si la columna no existe en prod → aplicar migración 219 antes (producción: SQL con aprobación explícita).

```javascript
const CATALOG_PUBLIC_SELECT = '..., "SupplierCode", "DetallesSimilitud"';
```

## Verificación

- `window.__FYL_DETALLES_SIMILITUD_IN_VIEW === true` tras primer fetch.
- Sin inflight `__FYL_COMMERCIAL_TAGS_INFLIGHT` en Home boot.

## Cruces

- [[PERF-001-LCP-Round-Trips-Supabase]]
- [[2026-05-23-Auditoria-LCP-Catalogo-Clarity]]
- `doc/catalogo/auditoria-lcp-2026-05-23.md`
