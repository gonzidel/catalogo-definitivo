# UX-001 — Overlay de boot bloquea toda interacción durante el LCP

- **Estado:** abierto
- **Severidad:** crítico
- **Detectado:** 2026-05-12 — [[../Performance/2026-05-12-Auditoria-Inicial]]
- **Pantalla:** home / catálogo
- **Métrica afectada:** dead clicks, rage clicks, INP percibido

## Síntoma

Durante los primeros segundos del catálogo, la usuaria puede ver el header y el body parcial detrás del overlay y tappea sobre lo que cree interactivo. **Ningún tap llega.** Tras varios intentos aparece la página y el primer tap útil ya está "frustrado".

## Causa raíz (confirmada por código)

`index.html`:

```html
<div id="catalog-boot-overlay" ...></div>
```

con `z-index: 10040` cubriendo toda la pantalla. La JS de boot solo lo retira al evento `fyl-catalog-boot-done`, que depende de [[../Performance/PERF-001-LCP-Round-Trips-Supabase]] (5+ round-trips Supabase). En 3G real el overlay puede vivir 8–12 segundos.

Además tiene timeout de fallback que retira el overlay incluso si el boot no terminó — pero **la ventana de dead clicks ya ocurrió**.

## Impacto

- Cada sesión mobile con red lenta = ráfaga de dead clicks en los primeros segundos.
- Las usuarias tappean el avatar, las quick actions, el FAB WhatsApp — todo eso queda registrado en Clarity como "dead click" / "rage".

## Archivos afectados

- `index.html` — `<div id="catalog-boot-overlay">` y la JS inline que lo controla
- `styles.css` — estilos del overlay
- `scripts/main-supabase.js` — emisor del evento `fyl-catalog-boot-done`

## Opciones consideradas

| Opción | Pro | Contra |
|---|---|---|
| A — Retirar el overlay apenas haya primer paint del catálogo (no esperar al enrich completo) | Mata dead clicks rápido. Encadena con [[../Performance/PERF-001]] | Hay que asegurar que los handlers críticos ya estén atados |
| B — Cambiar el overlay por skeleton no-bloqueante (sin `pointer-events: all`) | Permite scroll y tap aún en boot. Mejora INP percibido | Visual menos "limpio" si los datos llegan lento |
| C — Mantener overlay pero acortar LCP | Mejora natural una vez que [[../Performance/PERF-001]] esté arreglado | No resuelve la ventana actual |

## Decisión sugerida

Combinar **A + B**: el overlay se convierte en skeleton transparente al tap (no bloquea pointer events) y se retira en el primer paint útil. La carga "pesada" detrás (enrich, stock) sucede sin bloquear UX.

## Detalle de implementación UX (a definir)

- `pointer-events: none` en el overlay desde el momento que el catálogo es navegable, incluso si seguimos mostrando spinner.
- El primer batch de cards debería ser tap-able antes de retirar el overlay.
- Footer y header con sus handlers ya atados al `DOMContentLoaded`, no diferidos (ver [[UX-002-Handlers-Diferidos-Header-FAB]]).

## Riesgos

- Si el catálogo es tap-able pero el carrito todavía no inicializó, "agregar al carrito" puede fallar. Mitigación: el botón de la card valida estado o muestra spinner local.

## Verificación

- Clarity: caída de dead clicks en los primeros 10s de sesión.
- Lighthouse "Speed Index" similar o mejor.
- Repro manual en throttled mobile: tap en filtro a los 2s debe funcionar.

## Cruces

- [[../Performance/PERF-001-LCP-Round-Trips-Supabase]]
- [[UX-002-Handlers-Diferidos-Header-FAB]]
- [[UX-003-Onboarding-Roba-Tap]]
