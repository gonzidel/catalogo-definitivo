# UX-005 — Cambio de categoría sin feedback inmediato → doble tap

- **Estado:** abierto
- **Severidad:** alto
- **Detectado:** 2026-05-12 durante smoke test [[../Roadmap/FASE-1A-Estabilizacion-UX-2026-05-12]]
- **Pantalla:** catálogo home — quick actions de categoría, bottom-nav, banner
- **Métrica afectada:** dead clicks percibidos, rage clicks, tasa de error en navegación
- **Asociado a:** [[../Roadmap/FASE-1B-Render-Feedback]] (placeholder)

## Síntoma

Al tappear un botón de categoría en mobile, **muchas veces parece necesario tocar más de una vez** para que cambie. El tap probablemente sí llega y la categoría sí cambia, pero:

- el botón no muestra estado pressed/loading visible,
- el grid de productos demora 0.5–2s en repintarse mientras el thread está ocupado renderizando,
- la usuaria interpreta "no respondió" y vuelve a tappear,
- el segundo tap reinicia `cambiarCategoria` desde cero, alargando todo.

**No es un bug de navegación roto.** Es un problema de **percepción de respuesta**.

## Reproducción

1. Cargar el catálogo en mobile 360–430px, throttle 4G.
2. Esperar que termine el boot.
3. Tappear un quick action de categoría (no Inicio).
4. Observar: el botón no marca selección, el grid no cambia inmediatamente, el listado queda igual unos cientos de ms.
5. Tap repetido frecuente.

## Causa raíz (confirmada en código)

### 1. Feedback de overlay **inconsistente** entre flujos

| Flujo | ¿Muestra overlay durante `cambiarCategoria`? |
|---|---|
| `mobile-nav.js #nav-inicio` (línea 111-119) | ✅ sí (`showCatalogBootOverlay` → `hideCatalogBootOverlay`) |
| `mobile-nav.js #nav-categorias` (línea 195-203) | ✅ sí |
| `quick-actions.js` action "all" / Inicio (línea 222-232) | ✅ sí |
| `quick-actions.js` action `"category"` (línea 247-248) | ❌ no |
| `quick-actions.js` action `"offer"` (línea 252-254) | ❌ no |
| `quick-actions.js` action `"tag"` → `"Otros"` (línea 282) | ❌ no |
| `banner.js` link a categoría (línea 114-116) | ❌ no |

Justamente los flujos **más usados** desde mobile (tappear una categoría concreta) son los que NO dan feedback.

### 2. Feedback del botón en sí: inexistente

El botón de quick action no recibe ninguna clase `is-loading` / `is-pressed` / `is-selected` en el momento del tap. El CSS `:active` puede dar un flash de 50–100ms, pero al soltar el dedo desaparece y deja al usuario sin pista de que pasó algo.

### 3. Main thread ocupado durante `cambiarCategoria`

`cambiarCategoria` en `scripts/main-supabase.js:5532` ejecuta (de forma síncrona en main thread):

- filtra `productosActualesMap` o re-paginación,
- limpia `#catalogo`,
- llama a `renderizarProductosPagina` → `insertAdjacentHTML` por card en loop ([[../Performance/PERF-007-Render-Card-A-Card]]),
- cada insert dispara el `MutationObserver` de `filtros.js` ([[../Performance/PERF-002-MutationObserver-Filtros]]) que reconstruye todo el menú,
- las nuevas imágenes entran al loop de [[../Performance/PERF-004-SetInterval-Imagenes-Lazy]].

Resultado: long task de **500–2000ms** en mobile medio. Durante esa long task, **cualquier `:active` o repintado del botón queda demorado**, porque CSS no se aplica hasta que termine el frame. La usuaria literalmente **no ve nada cambiar** mientras el thread está bloqueado.

### 4. Doble tap = doble ejecución

`cambiarCategoria` no es idempotente respecto al tap. Si la usuaria tappea dos veces:

- el primer tap arranca el render,
- el segundo tap reinicia el flujo (limpia DOM, vuelve a renderizar),
- termina tardando casi el doble.

## Impacto

- **Percepción de "app rota / lenta"** justo en la interacción más frecuente del catálogo (cambiar categoría).
- **Dead clicks aparentes** (Clarity los registra como tales).
- **Rage clicks** cuando se repite el tap.
- **Carga 2× innecesaria** si el segundo tap llega antes de que termine el primero.
- Crítico para la conversión: la usuaria mayorista típicamente navega entre 3–7 categorías por sesión. Cada cambio con esta fricción acumula bounce.

## Archivos afectados

- `scripts/main-supabase.js` — `cambiarCategoria` (línea 5532)
- `scripts/quick-actions.js` — `handleQuickAction` (líneas 222–298 aprox), botones generados (línea 141)
- `scripts/mobile-nav.js` — handlers de bottom-nav (líneas 111–119, 195–203)
- `scripts/banner.js` — handler de link a categoría (línea 114)
- `styles.css` — clases `.quick-action`, `.bottom-nav button`, `:active`, falta estado `is-loading` / `is-selected`

## Líneas de fix posibles (NO se elige todavía)

Cinco direcciones, no excluyentes. Ranking inicial por ratio impacto/esfuerzo y por **respeto al principio FYL** de cambios mínimos:

| # | Idea | Esfuerzo | Impacto | Notas |
|---|---|---|---|---|
| A | **Estado pressed/selected inmediato** en el botón de categoría (CSS class al `click`, antes de `cambiarCategoria`) | XS | medio | resuelve "el tap no respondió" sin tocar render; pinta antes del long task |
| B | **Unificar overlay** (`showCatalogBootOverlay`) en todos los flujos de `cambiarCategoria` (envolver internamente, no en cada caller) | S | alto | una llamada en `cambiarCategoria` → cubre quick-actions, banner, mobile-nav, hash router |
| C | **Skeleton de transición** en `#catalogo` (clear DOM + render skeleton genérico + `requestAnimationFrame` → render real) | M | alto | da feedback antes del long task; encadena con [[../Performance/PERF-007-Render-Card-A-Card]] |
| D | **Debounce / lock de re-entrada** en `cambiarCategoria` (si ya hay una en curso, ignorar el siguiente tap idéntico) | XS | medio | evita el "doble tap reinicia render"; cuidado con bloquear cambio rápido a otra categoría distinta |
| E | **Optimistic UI**: marcar la categoría seleccionada en URL y bottom-nav antes de empezar a renderizar, dejar el render asíncrono | S | alto | sensación inmediata de "elegiste esto"; depende parcialmente de A |

### Combinación recomendada para FASE 1B (a decidir formalmente)

Mínima viable: **A + D** (pressed state inmediato + lock de re-entrada).
Si se quiere ir un paso más allá: **A + B + D**.
Si se ataca render: **A + B + C + D + E** (combo completo, encaja con la Fase 2 del roadmap general).

## Riesgos por opción

- **A**: ninguno significativo. CSS puro o 1 línea de JS para toggle class.
- **B**: cuidado con el overlay full-screen ahora **no bloqueante** (T2): si lo unificamos durante cambio de categoría, hay que decidir si bloquea o no. Probablemente sí, porque es una transición intencional.
- **C**: requiere acordar diseño del skeleton; no debe causar CLS al reemplazar por cards reales.
- **D**: si lock es muy estricto, puede sentirse como "no responde" en el otro extremo. Lock con timeout (max 1500ms) o cancelable al cambiar de categoría destino.
- **E**: requiere que la URL refleje el estado antes del render; ya hay `updateURL` disponible.

## Métricas para validar la solución (cuando se implemente)

- Clarity dead clicks en zona `.quick-action` / `.bottom-nav`: debería bajar fuerte.
- Clarity rage clicks ídem.
- INP en interacción "tap categoría": medirlo antes y después.
- Sesiones por categoría: si la fricción cae, debería subir el promedio.

## Cruces

- [[../Performance/PERF-002-MutationObserver-Filtros]] — multiplicador del long task de render
- [[../Performance/PERF-007-Render-Card-A-Card]] — long task del render mismo
- [[../Performance/PERF-004-SetInterval-Imagenes-Lazy]] — ruido adicional en el thread
- [[../Roadmap/FASE-1A-Estabilizacion-UX-2026-05-12]] — fase en curso (no se ataca ahí)
- [[../Roadmap/FASE-1B-Render-Feedback]] — fase donde se decidirá la solución
- [[../Performance/2026-05-12-Auditoria-Inicial]] — auditoría madre
