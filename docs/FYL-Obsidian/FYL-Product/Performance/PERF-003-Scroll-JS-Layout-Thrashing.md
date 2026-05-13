# PERF-003 — `scroll.js` provoca layout thrashing en cada scroll

- **Estado:** abierto
- **Severidad:** crítico
- **Detectado:** 2026-05-12 — [[2026-05-12-Auditoria-Inicial]]
- **Métrica afectada:** INP, CLS, scroll jank
- **Área:** sticky header + botón scroll-to-top

## Síntoma

Scroll "trabado" en mobile. Header oscila visible/oculto con micro-scrolls. CLS alto en el viewport superior. Interacciones (tap en card, sticky cart, filtros) tardan más mientras la usuaria está scrolleando.

## Causa raíz (confirmada por código)

`scripts/scroll.js`:

- `window.addEventListener("scroll", ...)` **sin debounce ni throttle, sin `{ passive: true }` explícito**.
- En cada scroll ejecuta `adjustAfterScroll()` y `handleHeaderVisibility()`, que:
  - **leen** `offsetHeight`, `getBoundingClientRect()`, `getComputedStyle()` de varios elementos,
  - **escriben** inline `transform`, `top`, `margin-top`, `padding-top`, `will-change` en el header y zonas adyacentes.
- Lectura → escritura → lectura → escritura en el mismo frame = layout forzado.
- `scrollThreshold = 3` (px). Con 3px de scroll el header ya togglea visibilidad → toggle muy frecuente.
- `will-change: transform, top` se setea por JS y **no se quita** → cada elemento queda promovido a capa GPU de forma permanente.
- En `DOMContentLoaded` hay varios `setTimeout(adjustStickyPositions, ...)` con tiempos distintos → reflows escalonados.

## Impacto

- INP: handler de scroll bloquea el main thread justo cuando la usuaria intenta tappear → tap delayed.
- CLS: header se mueve / aparece / desaparece con micro-scrolls.
- Batería / fluidez: capas GPU permanentes inútiles.

## Archivos afectados

- `scripts/scroll.js` — handler `scroll`, `adjustAfterScroll`, `handleHeaderVisibility`, `adjustStickyPositions`
- `styles.css` — sticky header / sticky cart (interactúan con los inline styles que pone `scroll.js`)

## Workaround

Ninguno.

## Plan de fix (propuesto, no implementado)

1. **Pasar el listener a `{ passive: true }`** y **debounce / `requestAnimationFrame` coalescer**: una lectura por frame, no por evento.
2. **Separar lectura y escritura** dentro del mismo `rAF`: primero todos los reads, luego todos los writes.
3. **Subir el threshold del toggle** del sticky header (ej. 24–32px) o aplicar histeresis (mostrar al scroll-up, ocultar al scroll-down con margen).
4. **Mover `will-change` a CSS condicional** (`.header.is-scrolling { will-change: transform }`) y limpiarlo después.
5. **Remover los `setTimeout` escalonados** en `DOMContentLoaded`; un único ajuste post-load.
6. Si el sticky cart necesita altura dinámica, usar `ResizeObserver` en lugar de recalcular en cada scroll.

## Riesgos del fix

- Subir el threshold cambia la sensación del sticky. Validar con mobile real.
- Quitar `will-change` puede mostrar jank breve en transform — testear en Android medio.

## Verificación post-fix

- DevTools Performance: scroll de 5s en home, 0 long tasks > 50ms.
- Métrica "Total Blocking Time" mejora en Lighthouse.
- Clarity 7 días: caída del rage click en zona header.

## Cruces

- [[../UX/UX-002-Handlers-Diferidos-Header-FAB]] (el header y sus controles son el mismo área conflictiva)
- [[PERF-004-SetInterval-Imagenes-Lazy]] (otro emisor de trabajo en main thread)
