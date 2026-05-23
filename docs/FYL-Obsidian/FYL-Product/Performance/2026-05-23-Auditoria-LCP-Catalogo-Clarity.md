# PERF-AUDIT-2026-05-23 — Auditoría LCP `/catalogo` (Clarity)

- **Fecha:** 2026-05-23
- **Scope:** `catalogo.html` (producción: `fylmoda.com.ar/catalogo`), boot Home (`categoriaActual === 'all'`)
- **Origen:** Microsoft Clarity (Core Web Vitals), auditoría estática de código en repo
- **Tráfico relevante:** ~61% WebView Instagram/Facebook mobile
- **Modo:** diagnóstico + plan de fix concreto (sin deploy en esta sesión)

---

## Métricas medidas (Clarity)

| Métrica | Valor Clarity | Target Google | Score global |
|---|---|---|---|
| LCP | **7.9 s** | < 2.5 s | — |
| INP | **500 ms** | < 200 ms | — |
| CLS | **1.2** | < 0.1 | — |
| Performance (Lighthouse/Clarity) | **33/100** | — | crítico |

> Comparar con baseline [[../Clarity/2026-05-12-Metricas-Iniciales]] (LCP ~10s). Mejora parcial posible por PERF-001 parcial; sigue muy lejos del target.

---

## Cadena crítica del LCP (resumen)

El LCP medido en Clarity **no puede ser la foto del primer producto** mientras el overlay de boot cubre el viewport (`z-index: 10040`). El candidato LCP real suele ser:

1. Dots del overlay, o
2. Tras ocultar overlay (~todo el boot JS + red): **primera `.main-image`** desde Cloudinary.

```text
HTML+CSS (Firebase static, sin SSR)
  → config.prod.js (bloqueante)
  → supabase bundle 164 KB + modules (~600 KB total)
  → DOMContentLoaded → inicializarCatalogo()
  → Supabase: 120 filas boot + enrichCatalogRowsWithDetallesSimilitud
  → RPC get_active_offers_with_images (await antes de render)
  → agruparProductos + render 14 cards (deferEnrich)
  → releaseBootOverlayOnFirstPaint (+ mín. 380 ms)
  → descarga imagen Cloudinary w_480 f_auto → LCP
```

---

## Hallazgos por bloque (auditoría solicitada)

### 1. TTFB y rendering inicial

| Qué | Evidencia | Impacto LCP |
|---|---|---|
| HTML con shell parcial, **sin productos** en `#catalogo` | `catalogo.html` L806–809 | **Directo** |
| **CSR puro**; Firebase Hosting estático, sin SSR/SSG | `firebase.json` hosting | **Directo** |
| Overlay full-screen hasta primer chunk JS | `catalogo.html` L578–583, `styles.css` L886–896 | **Directo** |
| CSS bloqueante ~200 KB | `styles.css` | Secundario |
| `styles-desktop.css` con `media="(min-width: 1024px)"` | `catalogo.html` L17 | OK (no bloquea mobile) |

**Bundles JS críticos (tamaño en disco, sin gzip):**

| Archivo | KB |
|---|---|
| `scripts/main-supabase.js` | 301.7 |
| `scripts/vendor/supabase-js.bundle.min.js` | 164.4 |
| `scripts/fyl-originals-banner.js` | 37 |
| `scripts/curated-banner.js` | 28.9 |
| Otros modules en `catalogo.html` L1124–1145 | ~50+ |
| **Total aprox.** | **~600 KB** minificado |

**Entry:** `inicializarCatalogo` en `main-supabase.js` L6911; escucha `DOMContentLoaded` L7219.

**Docs:** [[PERF-010-CSR-JS-Critical-Path-Catalogo]] · [[../UX/UX-001-Overlay-Boot-Bloquea-Interaccion]]

---

### 2. Llamadas API que bloquean el render

| Qué | Evidencia | Impacto LCP |
|---|---|---|
| Fetch productos **después** de cargar modules | `main-supabase.js` L7219, L1338+ | **Directo** |
| Boot Home: **120 filas** (`CATALOG_BOOT_INITIAL_ROWS`) | L298, L728–735, L781–790 | Secundario (mejor que full catalog) |
| `enrichProductsWithStock` **no** bloquea primer paint si `deferEnrich: true` | L1528–1535, L2116–2122 | Mitigado (PERF-001 parcial) |
| RPC **`get_active_offers_with_images` await antes de render** | L1488–1490 | **Directo** → [[PERF-009-Offers-RPC-Before-First-Paint]] |
| Bridge **`fetchDetallesSimilitudByArticulo`** si falta columna en SELECT | `CATALOG_PUBLIC_SELECT` L117–118 sin `DetallesSimilitud`; `commercial-tags.js` L218–242 | **Directo** (si prod tiene migración 219) → [[PERF-008-DetallesSimilitud-Bridge-Boot]] |
| Sin `<link rel="preload">` API/imagen en `<head>` | `catalogo.html` (ausente) | **Directo** → [[PERF-011-LCP-Preload-Preconnect-Gaps]] |
| `fylPreloadLcpImage` solo **post-render** | `main-supabase.js` L1820–1832, L2021–2022 | Secundario (tarde para LCP) |

**Mejoras ya en código (vs auditoría 2026-05-12):**

- Boot 120 filas + full catalog en background (`scheduleFullCatalogBackgroundFetch` L740–756).
- Primer render 14 productos con `deferEnrich: true` (L1528–1535).
- Render por `<template>` + un `appendChild` (PERF-007 mitigado en código actual L2110–2113).

---

### 3. Imágenes de productos

| Qué | Evidencia | Impacto |
|---|---|---|
| Formato | Cloudinary `f_auto,q_auto,c_scale,w_{N}` | OK |
| CDN | `res.cloudinary.com` + preconnect L11 | OK |
| Mobile card width | `w_480` si `innerWidth <= 430` L2069–2070 | OK |
| `width`/`height` en `<img>` | **No** en cards; `aspect-ratio: 4/5` en CSS `styles.css` L592–597 | Secundario (CLS) |
| Primera imagen | Primeras **4** cards: `loading="eager"` + `fetchpriority="high"` L2088–2091 | Bien (ideal: solo 1 con `high`) |
| Lazy resto | `loading="lazy"` por defecto | OK |
| Preload en head | **No** | **Directo LCP** |

---

### 4. Scripts bloqueantes en `<head>`

| Script | Bloquea parse | Notas |
|---|---|---|
| Varios inline (gtag/fbq/clarity **stubs**) | Mínimo | Carga externa **diferida** (interacción / boot-done+2s / 15s) `catalogo.html` L358–516 |
| `scripts/fyl-clarity-env-tags.js` | Sí (~1.6 KB) | Sin defer L494 |
| **`/config.prod.js`** al final del body **sin defer** | **Sí** | L1100 → [[PERF-012-Config-Prod-Render-Blocking]] |
| `scripts/filtros.js` clásico (sin module) | Competencia con modules | L1137 |
| 15+ `type="module"` al boot | Waterfall de imports | Incluye banners no críticos L1140–1145 |

**Pixels:** Meta/GA/Clarity **no** suelen bloquear LCP en cold load (diferidos). No son la causa principal de 7.9s.

---

### 5. Fuentes web

| Qué | Evidencia | Impacto LCP |
|---|---|---|
| Google Fonts Poppins 400/600 | `catalogo.html` L9–13 | Bajo |
| `display=optional` + carga no bloqueante (`media="print"` onload) | L12–13 | Bien |
| Fallback `system-ui` en inline/CSS | L38 | Bien |

Impacto principal en **CLS** de textos si hay swap; no explica 7.9s LCP.

---

## Mapa hallazgos → notas PERF/UX

| ID | Severidad | Resumen | Doc |
|---|---|---|---|
| PERF-001 | crítico | Round-trips Supabase (parcialmente mitigado 2026-05) | [[PERF-001-LCP-Round-Trips-Supabase]] |
| PERF-008 | crítico | Bridge commercial-tags si falta `DetallesSimilitud` en SELECT | [[PERF-008-DetallesSimilitud-Bridge-Boot]] |
| PERF-009 | alto | RPC ofertas antes del primer paint | [[PERF-009-Offers-RPC-Before-First-Paint]] |
| PERF-010 | crítico | CSR + ~600 KB JS antes del fetch | [[PERF-010-CSR-JS-Critical-Path-Catalogo]] |
| PERF-011 | alto | Sin preload imagen LCP / preconnect Supabase | [[PERF-011-LCP-Preload-Preconnect-Gaps]] |
| PERF-012 | medio | `config.prod.js` sin defer | [[PERF-012-Config-Prod-Render-Blocking]] |
| UX-001 | crítico | Overlay tapa viewport → LCP y dead clicks | [[../UX/UX-001-Overlay-Boot-Bloquea-Interaccion]] |
| PERF-006 | medio | Mitigado en `catalogo.html` | [[PERF-006-Styles-Desktop-Render-Blocking]] |
| PERF-007 | medio | Mitigado (template batch) | [[PERF-007-Render-Card-A-Card]] |

---

## Top 3 causas raíz (LCP 7.9s)

1. **CSR + monolito JS (~600 KB)** en WebView IG/FB: el fetch de productos no empieza hasta parse/compile/ejecutar `main-supabase` y dependencias.
2. **Overlay de boot** impide que el LCP sea la imagen del producto hasta completar Supabase + render (+ delay mínimo 380 ms).
3. **Camino de red post-JS:** boot 120 filas + posible bridge `DetallesSimilitud` + RPC ofertas en serie, luego descarga Cloudinary sin preload en `<head>`.

---

## Prioridad de fixes (solo LCP — primer producto visible)

| # | Acción | Impacto est. | Esfuerzo | Nota |
|---|---|---|---|---|
| 1 | SSG/inline 1ª card + preload imagen en `<head>` | −2 a −4 s | Alto | Máximo ROI |
| 2 | Overlay off en cold load (skeleton visible) | −0.4 a −1.5 s | Bajo | UX-001 |
| 3 | Añadir `DetallesSimilitud` a `CATALOG_PUBLIC_SELECT` | −0.5 a −2 s | Bajo | PERF-008 |
| 4 | RPC ofertas **después** del primer paint | −0.2 a −0.8 s | Bajo | PERF-009 |
| 5 | Early fetch + `preconnect` Supabase | −0.5 a −1.5 s | Medio | PERF-011 |
| 6 | Code-split boot vs PDP/banners | −1 a −3 s WebView | Alto | PERF-010 |
| 7 | `defer` en `config.prod.js` | −0.2 a −0.5 s | Bajo | PERF-012 |
| 8 | Una sola imagen `fetchpriority="high"` | −0.1 a −0.3 s | Bajo | Imágenes |

---

## INP / CLS (referencia rápida, fuera de scope LCP)

- **INP 500 ms:** `main-supabase` monolítico; init pesado en boot (`initModalEvents`, `initGridEvents` L6947–6951); ver [[PERF-002-MutationObserver-Filtros]] (mitigado en `filtros.js` 2026-05).
- **CLS 1.2:** `home-top-dynamic-slot` reserva 240px pero banners FYL/curated se inyectan después; badges de talle con `deferEnrich`; slots de banner en grid (`styles.css` L6745–6766).

---

## Verificación post-fix

- Clarity 7 días: LCP element = primera `.main-image` (no dots del overlay).
- Network (WebView simulado): ≤ 2 requests críticas antes del primer paint; sin `commercial_bridge` en boot.
- `markBootStage` (`boot-telemetry.js`) vs timestamp LCP en sesiones IG.
- Lighthouse mobile en `catalogo.html`: milestone ≤ 3.5 s LCP, ideal ≤ 2.5 s.
- Paridad `catalogo.html` / `index.html`: [[../Decisiones/DEC-001-Paridad-Catalogo-Index]].

---

## Próximos pasos

- [ ] Implementar quick wins PERF-008, PERF-009, PERF-012, PERF-011 (parcial)
- [ ] Spike SSG primera card (build/deploy)
- [ ] Actualizar [[PERF-001-LCP-Round-Trips-Supabase]] con estado 2026-05-23
- [ ] Re-medir Clarity → nueva nota en [[../Clarity/]]
- [ ] Priorizar en [[../Roadmap/00-Roadmap-Performance-Q2-2026]]

---

## Cruces

- Auditoría anterior: [[2026-05-12-Auditoria-Inicial]]
- Espejo operativo: `doc/catalogo/auditoria-lcp-2026-05-23.md`
- Clarity baseline: [[../Clarity/2026-05-12-Metricas-Iniciales]]
- Fase 1A: [[../Roadmap/FASE-1A-Estabilizacion-UX-2026-05-12]]
- Paridad entrypoints: [[../Decisiones/DEC-001-Paridad-Catalogo-Index]]
