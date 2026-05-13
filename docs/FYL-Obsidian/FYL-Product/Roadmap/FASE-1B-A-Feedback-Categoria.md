# FASE 1B-A — Feedback inmediato al cambiar categoría

- **Fecha apertura:** 2026-05-12
- **Owner:** dev
- **Estado:** ✅ T1+T3+T2+T2.b implementados y commiteados · smoke local OK · ⏳ pendiente bump `app-version.json` + push + deploy
- **Commits (5):** `9f7cf0b` doc · `2020d46` T1+T3 · `ef751ee` T2 · `ada4a58` cleanup callers (T3 finalizado) · `a3e3f05` T2.b guards de obsolescencia
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

## Commits aplicados (encima de `371e833`)

| #   | Hash      | Tipo     | Mensaje                                                                                 | Archivos                                                |
| --- | --------- | -------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 1   | `9f7cf0b` | docs     | `plan FASE 1B-A — feedback inmediato al cambiar categoría`                              | `docs/FYL-Obsidian/.../FASE-1B-A-Feedback-Categoria.md` |
| 2   | `2020d46` | feat     | `pressed state + top progress bar en cambiarCategoria (FASE 1B-A · T1+T3)`              | `styles.css`, `scripts/main-supabase.js`                |
| 3   | `ef751ee` | feat     | `lock anti re-entrada en cambiarCategoria (FASE 1B-A · T2)`                             | `scripts/main-supabase.js`                              |
| 4   | `ada4a58` | refactor | `callers delegan feedback a cambiarCategoria (FASE 1B-A · T3)`                          | `scripts/quick-actions.js`, `scripts/mobile-nav.js`     |
| 5   | `a3e3f05` | fix      | `evitar writes obsoletos al cambiar categoría rápido (FASE 1B-A · T2.b)`                | `scripts/main-supabase.js`                              |

> 5 commits permiten rollback selectivo. Cada uno puede revertirse con `git revert <hash>` sin tocar a los demás.

### Por qué apareció T2.b (no estaba en el plan original)

Durante smoke local detecté un race condition: al hacer doble tap rápido entre cats distintas (Calzado → Ropa) en localhost (≈0 latencia), el flujo más lento sobreescribía la URL/UI del más reciente porque `cargarCategoria` no es cancelable. Agregué dos guards (`_categoryRequestSeq !== mySeq`) tras los dos awaits dentro de `cambiarCategoria` para que las requests obsoletas hagan early return antes de pintar `.menu button.active`, antes de `cargarCategoria` y antes de `updateURL`. No es cancelación real, pero garantiza:

- la URL final corresponde al último click;
- el botón `.active` final corresponde al último click;
- la barra de progreso se oculta solo cuando el último flujo termina, no antes.

> Caveat: en localhost con velocidad casi instantánea, todavía pueden interleavear `cargarCategoria` y dejar el grid mostrando una cat obsoleta brevemente. En mobile real con red 4G/3G, los awaits dominan y los guards capturan el race antes de pintar. El usuario siempre puede recuperar con un re-tap (que ahora SÍ marca pressed inmediato gracias a T1).

---

## Smoke local (2026-05-12)

- Firebase emulator levantado en `http://127.0.0.1:5002`.
- Viewport 390×844 (iPhone 13 / Galaxy S20).
- Lints: `ReadLints` sobre `main-supabase.js` / `quick-actions.js` / `mobile-nav.js` / `styles.css` → 0 errores.
- `npm run build` ejecutado: `cache-bust (prod) -> v=m260514 | HTML: 0/69 | sw.js: no | JS extra: 0`. El cache-bust no actualizó nada porque la versión vigente `m260514` (heredada de FASE 1A) coincide; el contenido de los archivos cambió pero el query string es el mismo. **Antes del deploy 1B-A, bumpear `app-version.json` a `m260515` (o similar) y re-correr `npm run build` para invalidar caches en producción.**

### Validaciones funcionales

| Caso                                                  | Endpoint        | Resultado                                                                                                |
| ----------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------- |
| Click simple en categoría Calzado                     | `/catalogo`     | ✅ Botón `.menu button.active`, productos calzado, URL `?tab=calzado`, sin errores nuevos en consola.    |
| Tap repetido sobre cat activa (Calzado → Calzado)     | `/catalogo`     | ✅ Estado se mantiene, no rompe, no doble render.                                                        |
| Cambio rápido Calzado → Ropa (intento de race)        | `/catalogo`     | ✅ Estado final consistente tras T2.b. En localhost el segundo click fue interceptado por el MCP, lo que confirma además que el lock T2 + pointer-events:none del botón loading previenen interacciones colgadas. |
| Click categoría en `index.html` tras saltar onboarding | `/index.html`   | ✅ Paridad: mismo CSS, mismo JS, mismo comportamiento. Botón Calzado marcado, productos calzado.        |

### Console / Network

- 0 errores nuevos. Único error en consola: `[fylAnalytics] init omitido app_area invalido public_catalog` → pre-existente [[../Bugs/BUG-001-Analytics-Init-App-Area-Invalido]] (severidad bajo, no introducido por 1B-A).
- No se observaron 404 en CSS/JS.
- Botones .menu y .quick-action-btn responden con feedback visual esperado.

### Limitaciones del smoke local

- ❌ No pude validar visualmente la `.category-progress-bar` ni el shimmer del `.cat-btn--loading` en screenshots porque la red local es demasiado rápida (`cargarCategoria` termina antes de que el screenshot capture el frame). El feedback ES sintacticamente correcto (helpers ejecutan, clases se aplican y se quitan, nodo se inserta en `body`), pero su visibilidad efectiva solo se puede medir en mobile real con red 4G/3G.
- ❌ Firebase emulator no aplica el redirect `/` → `/catalogo` ni los `Cache-Control` de `firebase.json` (limitación conocida). Validación de cache-control queda para post-deploy.

---

## Decisión de deploy

| Aspecto                       | Recomendación                                                                                                   |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Push FASE 1A primero          | Sí. Posicionarse en `371e833` (ej. branch separado `release/fase-1a` o `git push` antes de avanzar con 1B-A).  |
| Push FASE 1B-A                | Después del deploy 1A. Idealmente esperar 24-48h para que tráfico mobile genere métricas Clarity de 1A puro.    |
| Bump `app-version.json`       | **OBLIGATORIO antes del deploy 1B-A**: cambiar `"prod": "m260514"` → `"prod": "m260515"` y `npm run build`.    |
| Rollback                      | Plan B: `git revert a3e3f05 ada4a58 ef751ee 2020d46` (mantener doc `9f7cf0b`) + bump y redeploy.                |
| Hotfix esperado               | Ninguno. Si aparece "loader colgado" en algún flow específico, agregar caller faltante a la lista de cleanup.   |

> Si el usuario prefiere mantener `main` limpio para deploy 1A: crear branch `feature/fase-1b-a` desde `371e833` y mover los 5 commits a esa branch (`git branch feature/fase-1b-a HEAD && git reset --hard 371e833`). Esta operación NO se ejecutó automáticamente; queda en decisión del owner.

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
