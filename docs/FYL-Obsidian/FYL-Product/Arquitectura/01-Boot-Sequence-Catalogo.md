# 01 — Secuencia de boot del catálogo (estado actual 2026-05-12)

Descripción **descriptiva, no prescriptiva** de lo que pasa al cargar `index.html` hoy. Sirve como referencia para diagnosticar performance, dead clicks y CLS.

> Nada de lo que está acá es "como debería ser". Es como está. Las recomendaciones viven en notas PERF-NNN / UX-NNN.

---

## 0. HTML + CSS bloqueante

- HTML parseado.
- `<link rel="stylesheet" href="styles.css">` — bloqueante (esperado).
- `<link rel="stylesheet" href="styles-desktop.css">` — bloqueante en mobile sin `media`. Ver [[../Performance/PERF-006-Styles-Desktop-Render-Blocking]].
- Fuente Google Poppins inyectada con `media="print" onload="this.media='all'"` (trick non-blocking).
- ~190 líneas de `<style>` inline para header / dropdown / modal login / banner promo.

## 1. Overlay de boot

- Se renderiza `<div id="catalog-boot-overlay">` con `z-index: 10040`, full screen.
- Bloquea toda interacción hasta `fyl-catalog-boot-done`.
- Hay timeout de fallback en JS inline.
- Ver [[../UX/UX-001-Overlay-Boot-Bloquea-Interaccion]].

## 2. Scripts críticos sincrónicos

- `scripts/filtros.js` — incluido **sincrónico** (sin `defer`). Bloquea parsing del HTML hasta que descarga. Ver [[../Performance/PERF-002-MutationObserver-Filtros]].
- Pequeños inline `<script>` con telemetría (`boot-telemetry.js`), helpers de primer interaction, registro de `fyl-catalog-boot-done`.

## 3. Carga de Supabase y catálogo

Sucede tras los scripts críticos:

1. `scripts/supabase-client.js` + bundle vendor — IIFE same-origin (post-hardening Safari iOS 2026-05-08, ver [[../../11-DECISIONES-TECNICAS]]).
2. `scripts/main-supabase.js` → `inicializarCatalogo`:
   - `cargarDesdeSupabase` — paginado de `catalog_public_available_view` (1000 por página, secuencial).
   - `enrichProductsWithStock`:
     - `products` + `product_variants`
     - `warehouses`
     - `variant_sizes`
     - `rpc_get_variant_size_reserved`
     - stock por warehouse
   - Ver [[../Performance/PERF-001-LCP-Round-Trips-Supabase]].
3. `scripts/quick-actions.js` → `loadQuickActions`:
   - `quick_actions`
   - `hasActiveOffersForQuickActions` con `.limit(4000)`
   - tags "Otros"

## 4. Render del listado

- `renderizarProductosPagina` itera productos.
- Por cada producto: `container.insertAdjacentHTML('beforeend', html)`.
- Cada insert dispara el `MutationObserver` de `filtros.js` (reconstrucción completa del menú).
- Cada insert agrega imágenes que entran al loop de [[../Performance/PERF-004-SetInterval-Imagenes-Lazy]].
- Inline `onclick` en cards depende de `window.BottomSheet`, `window.productosActualesMap`, `window.cambiarCategoria` (pueden no estar cargados).

## 5. Evento `fyl-catalog-boot-done`

- Emitido cuando el catálogo terminó de renderizar.
- Consumidores:
  - Overlay se retira (UX-001).
  - Onboarding modal se programa para abrir +3000ms ([[../UX/UX-003-Onboarding-Roba-Tap]]).
  - Vendor diferido se carga (analytics, pixel, etc.).
  - Banners (`fyl-originals-banner.js`, `custom-banner.js`) se activan.

## 6. Scripts diferidos (post-boot)

Atan handlers tarde:

- `whatsapp.js` → click `#wa-toggle`.
- dropdown del avatar → click `.cliente-link`.
- `cart-persistent.js` → carrito, listener `resize`, listener `focus` con `loadCartFromSupabase`.
- `scroll.js` → handler `scroll` con layout thrashing. Ver [[../Performance/PERF-003-Scroll-JS-Layout-Thrashing]].
- `size-filter.js` → modal de filtro de talles.
- `analytics.js` → patches a `pushState/replaceState`, listeners de `hashchange/popstate`.

## 7. Loops permanentes

- `setInterval(detectarImagenesCargando, 200)` en `main-supabase.js`. Ver [[../Performance/PERF-004-SetInterval-Imagenes-Lazy]].
- `MutationObserver` en `filtros.js` (vive toda la sesión).
- `MutationObserver` en `bottom-sheet.js` para `overflow:hidden` en `<body>`.

---

## Diagrama mental

```
HTML ──── styles.css (block)
       └─ styles-desktop.css (block, debería no)
       └─ overlay z=10040  ←─ aquí mueren los taps tempranos
       └─ filtros.js (sync) ←─ MutationObserver global
       └─ main-supabase.js
             ├─ cargarDesdeSupabase (paginated, serial)
             └─ enrichProductsWithStock (5+ round-trips serial)
                   └─ renderizarProductosPagina (insertAdjacentHTML × N)
                         └─ MutationObserver dispara × N
                         └─ setInterval(200ms) ya empezó
       └─ fyl-catalog-boot-done
             ├─ overlay sale
             ├─ onboarding +3s
             ├─ scripts diferidos atan handlers (header, FAB, carrito)
             └─ banners
```

## Pain points concentrados

- Entre paso 1 y paso 5 hay **una ventana de 8–12s en mobile real** donde:
  - Overlay bloquea taps.
  - O bien handlers no están atados.
  - O bien el menú de filtros se reconstruye en loop.
  - O bien el thread está saturado.

## Cruces

- [[../Performance/2026-05-12-Auditoria-Inicial]]
- [[../UX/UX-001-Overlay-Boot-Bloquea-Interaccion]]
- [[../UX/UX-002-Handlers-Diferidos-Header-FAB]]
- [[../../06-FLUJO-CATALOGO]] (backend)
- [[../../11-DECISIONES-TECNICAS]] (decisiones Safari iOS / vendor IIFE)
