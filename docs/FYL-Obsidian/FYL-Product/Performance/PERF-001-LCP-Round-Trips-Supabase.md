# PERF-001 — LCP: 5+ round-trips Supabase secuenciales antes de pintar

- **Estado:** abierto
- **Severidad:** crítico
- **Detectado:** 2026-05-12 — [[2026-05-12-Auditoria-Inicial]]
- **Métrica afectada:** LCP (~10s reportado por Clarity)
- **Área:** boot del catálogo

## Síntoma

El primer producto tarda muchos segundos en aparecer. En 3G/4G real (zona usuaria mayorista) el catálogo queda en skeleton durante casi todo el LCP medido.

## Causa raíz (confirmada por código)

`inicializarCatalogo` en `scripts/main-supabase.js` ejecuta en serie:

1. `cargarDesdeSupabase()` — paginado de productos (`from('catalog_public_available_view')`) con páginas de 1000. Mientras haya `data.length === 1000` sigue pidiendo más páginas, todas secuenciales.
2. `enrichProductsWithStock()` — antes de renderizar, hace:
   - query `products` con relación a `product_variants`
   - query `warehouses`
   - query `variant_sizes`
   - RPC `rpc_get_variant_size_reserved`
   - lectura de stock por warehouse

Es decir, **el primer paint útil depende de que terminen todas las queries**. En paralelo `quick-actions.js` levanta `get_active_offers_with_images` y un `quick_actions` con `.limit(4000)` solo para chequear si hay ofertas activas.

## Impacto

- UX: skeleton durante 8–10s en mobile. La usuaria abandona, intenta tappear elementos del header → dead clicks ([[../UX/UX-001-Overlay-Boot-Bloquea-Interaccion]]).
- Performance: LCP 4–5× peor que target.
- Conversión: cada segundo extra de LCP en e-commerce mobile cuesta. No tenemos número propio aún → ver [[../Metricas/00-KPIs-Catalogo]].

## Archivos afectados

- `scripts/main-supabase.js` — `inicializarCatalogo`, `cargarDesdeSupabase`, `enrichProductsWithStock`
- `scripts/quick-actions.js` — `loadQuickActions`, `hasActiveOffersForQuickActions`

## Workaround

Ninguno desde producto. Cliente con red lenta = espera larga.

## Plan de fix (propuesto, no implementado)

Opciones, sin reestructurar:

1. **Pintar antes el primer batch.** Renderizar los primeros N productos con los datos básicos del view canónico (que ya trae lo necesario para el card) y diferir `enrichProductsWithStock` a un segundo paso post-paint. El stock detallado solo es necesario para PDP / sticky cart / size filter; el card no lo muestra.
2. **Paralelizar lo que sí necesita el card.** `warehouses` + `variant_sizes` se pueden lanzar en paralelo (`Promise.all`) en lugar de en serie.
3. **Cortar la sobrecarga de quick-actions.** Reemplazar el `.limit(4000)` por un `count` o por un único `rpc_has_active_offers` dedicado.
4. **Página inicial más chica.** Primera página de 50 productos, paginación lazy. El view ya soporta paginación.

## Riesgos del fix

- (1) requiere validar que ningún consumidor del card lee stock detallado en el primer paint (revisar `cart-persistent.js` y `bottom-sheet.js`).
- (3) requiere RPC nueva → entra en [[../../04-RPCS-CRITICAS]].

## Verificación post-fix

- Medir LCP en Lighthouse mobile (Moto G4, 3G slow): target ≤ 3.5s como milestone, ≤ 2.5s ideal.
- Network panel: ≤ 2 queries Supabase críticas en el camino del LCP.
- Clarity 7 días: caída de dead clicks en zona "header" durante boot.

## Estado parcial en código (2026-05-23)

Re-auditoría [[2026-05-23-Auditoria-LCP-Catalogo-Clarity]] — Clarity LCP **7.9s** (mejor que ~10s baseline, sigue crítico):

| Mitigación ya en `main-supabase.js` | Referencia |
|---|---|
| Boot Home acotado a 120 filas + full catalog en background | L298, L728–756, L781–790 |
| Primer render 14 cards con `deferEnrich: true` (stock post-paint idle) | L1528–1535, L2116–2122 |
| `releaseBootOverlayOnFirstPaint` tras primer chunk | L1538–1541 |

**Sigue abierto:**

- RPC `get_active_offers_with_images` **antes** del render → [[PERF-009-Offers-RPC-Before-First-Paint]]
- Bridge `DetallesSimilitud` si SELECT incompleto → [[PERF-008-DetallesSimilitud-Bridge-Boot]]
- ~600 KB JS CSR antes de cualquier fetch → [[PERF-010-CSR-JS-Critical-Path-Catalogo]]
- Overlay tapa LCP hasta fin de boot → [[../UX/UX-001-Overlay-Boot-Bloquea-Interaccion]]

## Cruces

- [[PERF-007-Render-Card-A-Card]] (efecto multiplicador del coste de render)
- [[../Arquitectura/01-Boot-Sequence-Catalogo]]
- [[../../06-FLUJO-CATALOGO]] (flujo backend)
