# PERF-AUDIT-2026-05-12 — Auditoría inicial frontend mobile-first

- **Fecha:** 2026-05-12
- **Scope:** catálogo home (`index.html`) y dependencias críticas de boot/interacción
- **Origen:** Microsoft Clarity reporta LCP ~10s, INP ~1300ms, CLS ~0.61, dead clicks y rage clicks
- **Modo:** diagnóstico estático sobre código en `main`. **No se modificó código.**

---

## Métricas reportadas (Clarity)

| Métrica | Valor reportado | Target Google | Estado |
|---|---|---|---|
| LCP | ~10s | < 2.5s | crítico |
| INP | ~1300ms | < 200ms | crítico |
| CLS | ~0.61 | < 0.1 | crítico |
| Dead clicks | "muchos" | bajo | crítico |
| Rage clicks | "muchos" | bajo | crítico |

> Falta confirmar con Clarity: heatmaps, browser breakdown, peor pantalla, peor país.

---

## Mapa rápido de causas raíz

| Métrica afectada | Causa principal estimada | Doc |
|---|---|---|
| LCP | 5+ round-trips Supabase secuenciales antes de pintar primer producto | [[PERF-001-LCP-Round-Trips-Supabase]] |
| LCP / INP | `MutationObserver` en `filtros.js` reconstruye menú entero en cada inserción de card | [[PERF-002-MutationObserver-Filtros]] |
| INP / CLS | `scroll.js` lee/escribe layout en cada scroll sin debounce y togglea sticky con threshold de 3px | [[PERF-003-Scroll-JS-Layout-Thrashing]] |
| INP | `setInterval(200ms)` recorriendo imágenes lazy con `getBoundingClientRect` | [[PERF-004-SetInterval-Imagenes-Lazy]] |
| INP | Filtro de talles dispara N queries Supabase secuenciales por producto visible | [[PERF-005-Apply-Size-Filter-N-Queries]] |
| LCP / CLS | `styles-desktop.css` render-blocking en mobile (sin `media`) | [[PERF-006-Styles-Desktop-Render-Blocking]] |
| LCP / INP | `insertAdjacentHTML` card-a-card en loop dispara reflow N veces | [[PERF-007-Render-Card-A-Card]] |
| Dead clicks | Overlay `#catalog-boot-overlay` bloquea taps hasta `fyl-catalog-boot-done` (10+s) | [[../UX/UX-001-Overlay-Boot-Bloquea-Interaccion]] |
| Dead clicks | Handlers de header avatar, WhatsApp FAB y notificaciones se atan en scripts diferidos | [[../UX/UX-002-Handlers-Diferidos-Header-FAB]] |
| Rage clicks | Onboarding modal aparece con delay de 3s tras boot, roba el primer tap | [[../UX/UX-003-Onboarding-Roba-Tap]] |
| Rage clicks | Color swatches 20×20px (touch target < 44px) | [[../UX/UX-004-Color-Swatches-Touch-Target]] |

---

## Hallazgos por severidad

### Críticos (bloquean métricas Core Web Vitals)

- [[PERF-001-LCP-Round-Trips-Supabase]] — cargar productos requiere 5+ requests secuenciales (`cargarDesdeSupabase` paginado + `enrichProductsWithStock`: products+variants → warehouses → variant_sizes → reserved → warehouse stock) antes de pintar el primer producto.
- [[PERF-002-MutationObserver-Filtros]] — `scripts/filtros.js` observa `#catalogo` con `subtree:true` y reconstruye el menú completo en cada mutación. Durante render del listado dispara cientos de reconstrucciones.
- [[PERF-003-Scroll-JS-Layout-Thrashing]] — `scripts/scroll.js` lee `offsetHeight`, `getBoundingClientRect`, `getComputedStyle` y escribe `transform/top/margin-top/padding-top/will-change` en cada `scroll` sin debounce. Threshold de 3px hace toggle constante del sticky header.
- [[PERF-004-SetInterval-Imagenes-Lazy]] — `setInterval(200ms)` global en `main-supabase.js` ejecuta `detectarImagenesCargando` que hace `querySelectorAll` + `getBoundingClientRect` sobre todas las imágenes lazy. Ruido continuo en main thread.
- [[PERF-005-Apply-Size-Filter-N-Queries]] — `applySizeFilter` itera cards y por cada una hace hasta 3 queries Supabase secuenciales (`checkProductHasSizes`). Con 200 productos → cientos de round-trips.
- [[PERF-006-Styles-Desktop-Render-Blocking]] — `styles-desktop.css` se incluye sin `media="(min-width: 1024px)"`, así que mobile lo descarga y parsea bloqueando render aunque internamente no aplique reglas.
- [[../UX/UX-001-Overlay-Boot-Bloquea-Interaccion]] — overlay full-screen con `z-index: 10040` que solo se quita al evento `fyl-catalog-boot-done`; mientras tanto, todo tap es dead click.

### Altos

- [[PERF-007-Render-Card-A-Card]] — `renderizarProductosPagina` hace `insertAdjacentHTML('beforeend', ...)` en `forEach`. Cada inserción dispara reflow + el `MutationObserver` de filtros.
- [[../UX/UX-002-Handlers-Diferidos-Header-FAB]] — `.cliente-link`, `#wa-toggle`, `#header-notifications` son visibles desde el primer paint pero su handler real lo ata un script diferido (`whatsapp.js`, dropdown, notificaciones). Ventana de varios segundos de dead clicks.
- [[../UX/UX-003-Onboarding-Roba-Tap]] — modal de bienvenida con `OPEN_DELAY_MS = 3000` tras `fyl-catalog-boot-done`. Llega cuando la usuaria ya está intentando interactuar.
- [[../UX/UX-004-Color-Swatches-Touch-Target]] — `.card-footer .colors .color-btn` 20×20px. WCAG / Android / iOS recomiendan ≥44×44px.

### Medios

- `will-change: transform; backface-visibility: hidden` permanente en `.main-image` (duplicado en `styles.css`). Promueve cada imagen a capa GPU innecesariamente.
- `backdrop-filter: blur(10px)` en `.bottom-nav` — costoso en mobile durante scroll.
- `aspect-ratio` inconsistente entre vistas (`6/7` listado vs `4/5` PDP vs `1/1` compact) — CLS al cambiar de vista.
- Listeners `resize` y `focus` en `cart-persistent.js` sin debounce; `focus` dispara `loadCartFromSupabase`.
- `fyl-originals-banner.js` y `custom-banner.js` agregan listeners `scroll` sin `{ passive: true }`.
- `popstate`/`hashchange` patcheado para Clarity + Meta Pixel + GA. Cada navegación SPA hace varios trabajos en cadena.

### Bajos / oportunidad

- Inline `<style>` extenso en `index.html` (~190 líneas). Aumenta peso del HTML.
- Inline `<script>` con lógica de boot (telemetría, overlay, vendor deferred). Cuesta diagnóstico y review.
- `MutationObserver` en `scripts/bottom-sheet.js` para gestionar `overflow:hidden` en `<body>` — innecesario, basta con llamadas directas.
- `quick-actions.js` consulta `quick_actions` + `hasActiveOffersForQuickActions` con `.limit(4000)` solo para saber si hay ofertas activas.

---

## Confirmaciones pendientes con Clarity

Pedir / revisar en Clarity:
- [ ] Heatmaps de dead clicks por pantalla
- [ ] Browser/OS breakdown (Safari iOS suele empeorar INP)
- [ ] País más afectado
- [ ] Sesiones con rage en sticky cart vs onboarding vs swatches
- [ ] LCP por elemento (¿la primera imagen del producto? ¿el banner?)

Resultado en [[../Clarity/2026-05-12-Metricas-Iniciales]].

---

## Conclusión

El problema es **boot pesado bloqueante + main thread saturado por loops y observers globales + targets táctiles deficientes**. No es un problema de arquitectura: cada causa raíz se puede atacar con fixes locales y reversibles. **Ningún fix propuesto requiere reestructurar el frontend.**

---

## Próximos pasos

- [ ] Confirmar lectura Clarity → [[../Clarity/2026-05-12-Metricas-Iniciales]]
- [ ] Priorizar fixes → [[../Roadmap/00-Roadmap-Performance-Q2-2026]]
- [ ] No tocar código hasta cerrar plan de fixes con el equipo

## Seguimiento

- **2026-05-23:** Re-auditoría LCP enfocada en `/catalogo` (Clarity 7.9s LCP) → [[2026-05-23-Auditoria-LCP-Catalogo-Clarity]]
- Espejo `doc/`: `doc/catalogo/auditoria-lcp-2026-05-23.md`

## Cruces

- Arquitectura actual: [[../Arquitectura/01-Boot-Sequence-Catalogo]]
- Métricas / KPIs vivos: [[../Metricas/00-KPIs-Catalogo]]
- Vault técnico: [[../../06-FLUJO-CATALOGO]] · [[../../21-CONTEXTO-AGENTE-HARDENING-2026-04]]
- [[2026-05-23-Auditoria-LCP-Catalogo-Clarity]]
