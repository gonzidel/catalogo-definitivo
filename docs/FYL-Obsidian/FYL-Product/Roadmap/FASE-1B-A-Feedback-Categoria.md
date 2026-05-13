# FASE 1B-A — Feedback inmediato al cambiar categoría

- **Fecha apertura:** 2026-05-12
- **Owner:** dev
- **Estado:** 🟡 plan aprobado · listo para implementar (commits atómicos separados de FASE 1A)
- **Origen:** [[../UX/UX-005-Cambio-Categoria-Sin-Feedback]] · feedback usuaria post-FASE 1A: "todavía al seleccionar una categoría queda cargando en la nada, no muestra icono de carga ni nada y genera la sensación de que el botón no funciona"
- **Sub-fase de:** [[FASE-1B-Render-Feedback]] (1B madre cubre render pesado; 1B-A solo ataca **percepción** sin tocar render)
- **Branch:** `main` (commits locales separados de FASE 1A)
- **Regla aplicada:** [[../Decisiones/DEC-001-Paridad-Catalogo-Index]] · cambios en `scripts/main-supabase.js` y `styles.css` llegan automáticamente a `index.html` Y `catalogo.html`.

---

## Por qué se separa de FASE 1B madre

| FASE 1B madre                                    | FASE 1B-A (esta)                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------- |
| Resuelve el long task del render                 | Resuelve la **percepción de respuesta** mientras dura el long task |
| Toca render pipeline, MutationObserver, batching | Solo toca feedback visual + lock                                    |
| Esfuerzo: M-L · riesgo medio                     | Esfuerzo: S · riesgo bajo                                           |
| Necesita medición previa                         | Evidencia ya suficiente: dead clicks, taps repetidos, UX-005        |

> 1B-A se deploya antes que 1B madre porque el costo es mínimo y el alivio percibido es alto. 1B madre queda abierta para atacar el long task real cuando haya ventana.

---

## Decisión de orden (opción C aprobada por usuario)

1. Deploy FASE 1A independiente (commits ya en local: `ea494c9`, `d2c6ab5`, `3cb7f70` + T1 absorbido por `371e833`).
2. **En paralelo**, implementar FASE 1B-A en commits separados encima de HEAD.
3. Deploy FASE 1B-A separado (no mezclado con 1A) → permite atribuir cualquier regresión a la fase correcta.

> No esperamos los 7 días de Clarity para 1A: la evidencia cualitativa (UX-005 + feedback directo) ya justifica 1B-A.

---

## Tareas

| ID  | Descripción                                                  | Esfuerzo | Riesgo | Rollback                                       |
| --- | ------------------------------------------------------------ | -------- | ------ | ---------------------------------------------- |
| T1  | Pressed/loading state inmediato en botón de categoría        | XS       | bajo   | revertir CSS + helpers `markCategoryButtons*` |
| T2  | Lock anti re-entrada en `cambiarCategoria` (mismo cat)       | XS       | bajo   | quitar `_categoryInFlight` early return        |
| T3  | Centralizar feedback dentro de `cambiarCategoria()`          | S        | medio  | restaurar overlay manual en callers            |

> T1 y T3 se commitean juntos porque T1 (pressed state) **vive dentro** de T3 (helpers centralizados). T2 va aparte porque es lógica de control distinta.

---

## Diseño UX (premium · app-like · mobile-first)

Dos capas de feedback, ambas síncronas y ambas activadas desde la **primera línea** de `cambiarCategoria()` (antes de cualquier `await`):

### Capa 1 — Pressed state en el botón tappeado

Botón target recibe clase `.cat-btn--loading`:

- `transform: scale(0.97)` (GPU, sin reflow)
- `opacity: 0.85`
- shimmer leve barriendo el background con `::after`
- `pointer-events: none` (refuerzo del lock T2 a nivel CSS — el botón no acepta más taps mientras carga)

Selectores afectados: `.menu button` (desktop tab bar) y `.quick-action-btn` (chips horizontales mobile). El matching cat→botón replica el algoritmo existente de `cambiarCategoria` (líneas 5565–5581 de `main-supabase.js`).

### Capa 2 — Top progress bar app-like

Barra slim (2px) `position: fixed; top: 0; left: 0; right: 0; z-index: 10050; pointer-events: none`.

- Aparece desde `scaleX(0)`, salta a `scaleX(0.8)` con `cubic-bezier(0.22, 0.61, 0.36, 1)` (320 ms).
- Mientras está visible, gradient con `background-position` animado → shimmer sutil.
- Al `finally` de `cambiarCategoria`, salta a `scaleX(1)` y fade-out 180 ms.
- No bloquea taps. No genera CLS (fixed). No requiere markup en `index.html`/`catalogo.html` (se inserta dinámicamente en `body`).

> Estilo de referencia: barras de carga de YouTube / Linear / Vercel — la usuaria reconoce el patrón "estoy navegando" sin overlay pesado.

### `prefers-reduced-motion`

- Botón loading: sin shimmer ni scale, solo opacity 0.75.
- Progress bar: sin animación, solo opacidad.

---

## Diseño técnico

### API interna nueva en `scripts/main-supabase.js`

```js
let _categoryInFlight = null;        // T2: cat string actualmente en vuelo
let _categoryRequestSeq = 0;         // T2: contador para detectar last-wins
let _categoryProgressBarEl = null;   // T1+T3: lazy-init del nodo

function showCategoryFeedback(cat) {
  markCategoryButtonsLoading(cat);   // capa 1
  showCategoryProgressBar();         // capa 2
}

function hideCategoryFeedback() {
  unmarkCategoryButtonsLoading();
  hideCategoryProgressBar();
}
```

### Modificación de `cambiarCategoria`

```js
async function cambiarCategoria(cat) {
  // [FASE 1B-A · T2] Lock anti re-entrada: tap repetido sobre la MISMA cat en vuelo se ignora.
  // Tap sobre OTRA cat sí se permite (last-wins) para no congelar la UI.
  if (_categoryInFlight === cat) {
    fylCatalogDbg("⛔ cambiarCategoria: tap repetido sobre cat en vuelo, ignorado:", cat);
    return;
  }
  const mySeq = ++_categoryRequestSeq;
  _categoryInFlight = cat;

  // [FASE 1B-A · T1+T3] Feedback inmediato síncrono ANTES de cualquier await.
  showCategoryFeedback(cat);

  try {
    fylCatalogDbg("🔄 Cambiando a categoría:", cat);
    persistCurrentScrollInHistory();
    // ... resto idéntico al actual ...
    await runWithViewTransition(() => cargarCategoria(cat));
    updateURL({ tab: cat, sku: undefined }, { mode: 'replace' });
  } finally {
    // T2: solo limpiamos si seguimos siendo la última request.
    // Si otra cat tomó el lock mientras esperábamos, dejamos que ese flujo limpie.
    if (_categoryRequestSeq === mySeq) {
      _categoryInFlight = null;
      hideCategoryFeedback();
    }
  }
}
```

### Limpieza de callers (parte de T3)

`quick-actions.js` y `mobile-nav.js` envuelven hoy ciertos `cambiarCategoria("all")` con `showCatalogBootOverlay()` / `hideCatalogBootOverlay()` manual. Esa duplicación se elimina: `cambiarCategoria` es la única fuente de verdad.

| Caller                                  | Antes                                                              | Después                                          |
| --------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------ |
| `quick-actions.js:222-232` (action all) | `showCatalogBootOverlay` + `await cambiarCategoria` + `hide`       | `await cambiarCategoria("all")`                  |
| `mobile-nav.js:111-119` (#nav-inicio)   | `showCatalogBootOverlay` + `Promise.resolve(cambiarCategoria)`     | `cambiarCategoria("all")` (fire-and-forget)      |
| `mobile-nav.js:195-203` (#nav-categorias) | igual al anterior                                                  | igual                                            |
| `quick-actions.js:248,253` (category, offer) | sin overlay (ya inconsistente)                                     | sin cambios — feedback ahora viene central      |
| `banner.js:114-116`                     | sin overlay                                                        | sin cambios — feedback central                   |

> El overlay de boot inicial (`#catalog-boot-overlay`) **no se toca**. Sigue funcionando exactamente igual para el primer paint del catálogo. Solo dejamos de reusarlo para "transiciones de categoría".

---

## Restricciones (lo que NO hacemos en 1B-A)

- ❌ Skeleton complejo del grid de productos.
- ❌ Render por lotes con `requestAnimationFrame`.
- ❌ Refactor de filtros / `applySizeFilter`.
- ❌ Cambios en `MutationObserver` de filtros.
- ❌ Optimistic routing (cambiar URL antes del render).
- ❌ Cambios Supabase / RPCs / negocio.
- ❌ Cambios en HTML de `index.html` o `catalogo.html`.
- ❌ Reemplazar `runWithViewTransition`.
- ❌ Tocar el overlay de boot inicial.

> Si alguna de estas tentaciones aparece, parar y reabrir como FASE 1B madre.

---

## Estabilidad visual (pre-condiciones)

- ❌ Sin flash blanco: no usamos overlay full screen.
- ❌ Sin reseteo de scroll: no movemos `window.scrollY`.
- ❌ Sin reflow agresivo: solo `transform` y `opacity` en el botón; progress bar es `position: fixed` fuera del flujo.
- ❌ Sin saltos: el botón no cambia de tamaño visible (scale 0.97 imperceptible) ni el header reserva espacio nuevo.
- ❌ Sin CLS: nuevo nodo `body > .category-progress-bar` es fixed, no afecta layout.

---

## Plan de validación local

1. Cargar `catalogo.html` y `index.html` con DevTools en mobile 360–430px, throttle 4G.
2. Tap rápido sobre `Calzado` → ver pressed state ≤ 16 ms + barra top que arranca de inmediato.
3. Tap repetido sobre `Calzado` mientras está cargando → ignorado (verificar `fylCatalogDbg` log).
4. Tap sobre `Calzado` → mientras carga, tap sobre `Ropa` → cambia a Ropa (no se queda colgado en Calzado), barra y pressed reflejan Ropa.
5. Tap "Inicio" desde quick-actions → barra top + pressed en chip "Inicio" (sin overlay full).
6. Tap "Inicio" desde bottom-nav → mismo comportamiento.
7. Click banner con `link_type="category"` → mismo comportamiento.
8. `prefers-reduced-motion: reduce` activado → sin shimmer, sin scale, solo opacity.
9. Verificar que ninguna acción genera scroll involuntario, flash blanco ni overlap con header.

## Plan de validación post-deploy

- Android Chrome (360px y 430px).
- Instagram WebView (Android e iOS).
- Samsung Internet.
- iOS Safari.
- Validar en `https://fyl.com.ar/` (catalogo) **y** en futuros deploys de `index.html`.

Verificar:
- ✅ no doble render
- ✅ no categorías "trabadas"
- ✅ no loaders colgados (la barra siempre desaparece tras finally)
- ✅ no overlays huérfanos (no usamos overlay)
- ✅ Clarity: caída de dead clicks y rage clicks sobre `.quick-action-btn` y `.menu button`

---

## Riesgos

| Riesgo                                                                     | Severidad | Mitigación                                                                       |
| -------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------- |
| Lock T2 deja `_categoryInFlight` colgado si `cargarCategoria` lanza        | medio     | `try/finally` con guard `_categoryRequestSeq === mySeq` garantiza limpieza       |
| Botón con `pointer-events: none` queda "muerto" si finally no corre        | medio     | mismo `try/finally`; además al re-render del catálogo el botón se reescribe limpio |
| Race entre cambios rápidos: progreso visual del último gana, pero render del primero podría sobrescribir | bajo-medio | already exists today; T2 no lo empeora; `runWithViewTransition` aplica el último callback |
| Conflicto de selector `.menu button` con `.menu` de otra pantalla         | bajo      | `.menu` solo existe en catálogo home (chequeado en grep)                          |
| Top progress bar visible durante cargas muy rápidas (< 200ms) → flicker    | bajo      | transición de salida 180ms suaviza; aceptable para perceived performance         |
| Prefijo `cat-btn--loading` colisiona con clase existente                   | bajo      | grep confirma que no existe en codebase                                          |

---

## Métricas esperadas (post-deploy 7 días)

> Llenar tras 7 días de tráfico Clarity / GA4. Comparación contra baseline de [[../Clarity/2026-05-12-Metricas-Iniciales]].

| Métrica                                       | Baseline | Objetivo 1B-A |
| --------------------------------------------- | -------- | ------------- |
| Dead clicks `.quick-action-btn`                | TBD      | -40% mínimo  |
| Dead clicks `.menu button`                     | TBD      | -40% mínimo  |
| Rage clicks `.quick-action-btn`                | TBD      | -50% mínimo  |
| INP en interacción "tap categoría" (P75)      | TBD      | sin cambio (no tocamos render) — la mejora es percepción, no real |
| Tasa de "doble tap" sobre misma cat            | TBD      | -60% mínimo  |

> INP no debería bajar (no atacamos el long task aún). Lo que cambia es la **percepción**: dead/rage clicks sí deberían caer.

---

## Plan de commits atómicos

1. `docs(roadmap): plan FASE 1B-A — feedback inmediato al cambiar categoría` → solo este `.md`.
2. `feat(catalog): pressed state + top progress bar en cambiarCategoria (FASE 1B-A · T1+T3)` → `styles.css` + `scripts/main-supabase.js` (helpers + integración en cambiarCategoria, sin lock todavía).
3. `feat(catalog): lock anti re-entrada en cambiarCategoria (FASE 1B-A · T2)` → `scripts/main-supabase.js` (early return + secuencia).
4. `refactor(catalog): callers delegan feedback a cambiarCategoria (FASE 1B-A · T3)` → `scripts/quick-actions.js` + `scripts/mobile-nav.js`.
5. `chore: build cache-bust FASE 1B-A` → `app-version.json` + cache-bust de scripts/HTML afectados (lo aplica `npm run build`).

> 5 commits permiten rollback selectivo si alguna capa molesta sin tirar todo abajo.

---

## Cruces

- [[../UX/UX-005-Cambio-Categoria-Sin-Feedback]] — hallazgo origen (causa raíz)
- [[FASE-1A-Estabilizacion-UX-2026-05-12]] — fase anterior (overlay no bloqueante)
- [[FASE-1B-Render-Feedback]] — fase madre (atacará el long task real)
- [[../Decisiones/DEC-001-Paridad-Catalogo-Index]] — regla arquitectónica
- [[../Performance/PERF-007-Render-Card-A-Card]] — long task no resuelto en esta fase
- [[../Performance/PERF-002-MutationObserver-Filtros]] — long task no resuelto en esta fase
- [[../Clarity/2026-05-12-Metricas-Iniciales]] — baseline de medición
- [[00-Roadmap-Performance-Q2-2026]] — roadmap general
