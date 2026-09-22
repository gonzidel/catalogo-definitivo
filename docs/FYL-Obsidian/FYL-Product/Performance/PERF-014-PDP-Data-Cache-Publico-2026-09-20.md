# PERF-014 — PDP Data Cache (producto público) — 2026-09-20

## Qué cambió

SSR parcial del PDP conserva HTML dinámico (`searchParams`). La consulta costosa del **producto público** (artículo, descripción, precio, colores, imágenes, SKU→artículo/color) pasa por **Data Cache** (`unstable_cache`, Next 15) con:

- Cliente anon dedicado: `nj/lib/supabase/public-catalog.ts` (sin cookies, sin persistencia Auth, sin service role).
- Base cacheada: `getCachedPdpProductBase(sku)` → `loadPdpProductBase`.
- Color de URL **fuera** de la caché: `loadPdpProductForSku(sku, colorFromUrl)`.
- `revalidate: 60`, tags `catalog-products` + `catalog-product:{sku}`.
- `neutralizePdpStockFlags` en la base; sellable sigue en cliente (`useSellableStock`).

## Clave de caché

```
keyParts: ['pdp-product-base', skuNormalizado]
argumento: skuNormalizado (trim)
```

`colorFromUrl` / `?color=` no forman parte de la clave.

## Evidencia local (127.0.0.1:3018, `ALLOW_PDP_CACHE_STATS=1`)

| SKU  | Fase | TTFB   | Contador        |
|------|------|--------|-----------------|
| 2676 | MISS | ~939–1416 ms | misses++ |
| 2676 | HIT  | ~99 ms | hits++ |
| HBI1 | MISS | ~675–707 ms | |
| HBI1 | HIT  | ~101–122 ms | |
| 840  | MISS | ~687–711 ms | |
| 840  | HIT  | ~97–100 ms | |

Logs: `[pdp-cache] MISS|HIT {sku}`. Mismo SKU con otro `?color=` → HIT (sin nueva query base).

## Lighthouse móvil (simulate; 2 runs/ruta; reportar hot)

Tras Data Cache caliente (lab localhost):

| SKU  | Perf | TTFB LH | FCP  | LCP  | CLS   |
|------|------|---------|------|------|-------|
| 2676 | 90   | ~18 ms  | 1.5s | 3.5s | 0.009 |
| HBI1 | 87   | ~9 ms   | 2.3s | 3.7s | 0.009 |
| 840  | 87   | ~10 ms  | 2.2s | 3.7s | 0.011 |

Baseline previo (lab): LCP ~6.0–6.3 s. Mejora principal de TTFB real medida por stopwatch (~7–14× en HIT).

## No cacheado

- Stock sellable / talles comprables
- Carrito, sesión, cookies, headers
- HTML completo de la página

## Cierre pre-deploy (2026-09-20)

- Eliminada instrumentación temporal (`pdp-cache-stats`, contadores HIT/MISS, exports debug).
- Fallback `products` integrado en `loadPdpProductBase` (SSR + cliente) con status `active` | `pending_stock`.
- Evidencia SSR RMAT: HTML incluye `Articulo":"RMAT"`, `DetalleColor`, sin `hasStock:true/false` embebido.
- Stock sellable solo en cliente (`useSellableStock`).

## Lighthouse final (móvil, Data Cache caliente, 2 runs; reportar hot)

| SKU | hot Perf | hot FCP | hot LCP | hot CLS |
|-----|----------|---------|---------|---------|
| 2676 | 75 | 2.2 s | 6.2 s | 0.009 |
| RMAT | 91 | 1.5 s | 3.5 s | 0.031 |

Nota lab: en 2676 el 1.er run post-warm HTTP suele dar LCP ~3.5 s; el 2.º (hot descartando warm) oscila a ~6.2 s en localhost simulate. RMAT hot estable ~3.5 s.

## Riesgos / deuda

- `revalidate: 60`: precio/imágenes pueden ir hasta 60s desfasados.
- Entradas `null` (SKU inexistente) también se cachean 60s → flash skeleton hasta fetch cliente → “Producto no encontrado”.
- Invalidación on-demand por tag aún no cableada a admin/CMS.
- Stub no incluye `draft`/`archived`; productos solo `draft` siguen “no encontrado”.
- Precio stub con `cost` null usa fórmula de catálogo; enrich puede completar precio de variante.
