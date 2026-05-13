# FASE 1A — Estabilización UX / Percepción de carga

- **Fecha inicio:** 2026-05-12
- **Owner:** dev
- **Estado:** ✅ T1 · T2 · T3 · T4 aplicados en ambos entrypoints · ✅ `npm run build` + smoke post-build validados · ⏳ pendiente push/deploy + medición
- **Alcance:** sólo dead clicks, rage clicks y percepción mobile. **No** se toca render, scroll, Supabase ni filtros.
- **Origen:** [[../Performance/2026-05-12-Auditoria-Inicial]]
- **Branch:** `main` (commits locales no pusheados)
- **Regla arquitectónica derivada:** [[../Decisiones/DEC-001-Paridad-Catalogo-Index]] — descubierta mientras se cerraba FASE 1A. Toda mejora UX/perf debe aplicarse a `index.html` Y `catalogo.html` (los dos entrypoints del catálogo).
- **Bitácora predeploy:** [[../Deploys/DEP-2026-05-12-v01-FASE-1A-Predeploy]]

> Regla: cambios mínimos, aislados, reversibles. Un solo deploy por tarea idealmente. Si una tarea se complica más de su esfuerzo estimado, parar y reabrir plan.

---

## Tareas


| ID                                    | Doc origen                                                 | Esfuerzo | Riesgo | Estado                                                                                                              |
| ------------------------------------- | ---------------------------------------------------------- | -------- | ------ | ------------------------------------------------------------------------------------------------------------------- |
| T1 — `styles-desktop.css` con `media` | [[../Performance/PERF-006-Styles-Desktop-Render-Blocking]] | XS       | bajo   | 🟡 en disco en ambos archivos · sin commit · ver nota T1 abajo                                                      |
| T2 — Overlay boot no-bloqueante       | [[../UX/UX-001-Overlay-Boot-Bloquea-Interaccion]]          | S        | medio  | ✅ commit `d2c6ab5` · vía `styles.css` compartido · llega a ambos entrypoints                                        |
| T3 — Handlers críticos no diferidos   | [[../UX/UX-002-Handlers-Diferidos-Header-FAB]]             | S        | medio  | ✅ `index.html` commit `3cb7f70` · `catalogo.html` cumplido por construcción (ver nota paridad)                      |
| T4 — Onboarding respeta interacción   | [[../UX/UX-003-Onboarding-Roba-Tap]]                       | XS       | bajo   | ✅ `scripts/catalog-onboarding.js` commit `ea494c9` · `catalogo.html` cumplido por construcción (no carga el script) |


## Paridad index.html ↔ catalogo.html (FASE 1A)

> Regla maestra: [[../Decisiones/DEC-001-Paridad-Catalogo-Index]].

Estado real de FASE 1A en cada entrypoint, validado contra el código al 2026-05-12:


| Tarea                               | `index.html` (dev / futuro)                                                                                                     | `catalogo.html` (producción actual)                                                                                                                                                                                                                                                                             | Estado de paridad                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **T1** styles-desktop `media=`      | 🟡 línea 15 con `media="(min-width: 1024px)"` (en disco, sin commit, ver nota T1)                                               | 🟡 línea 15 con `media="(min-width: 1024px)"` (en disco, sin commit, comentario marcando FASE 1A · T1)                                                                                                                                                                                                          | ✅ paridad lograda                                              |
| **T2** overlay no bloqueante        | ✅ vía `styles.css` (`body.catalog-boot-active { overflow: auto }`, overlay `pointer-events: none`, dots `pointer-events: auto`) | ✅ vía `styles.css` (archivo compartido)                                                                                                                                                                                                                                                                         | ✅ paridad por archivo compartido                               |
| **T3** handlers críticos inmediatos | ✅ commit `3cb7f70`: `whatsapp.js` y `notifications.js` movidos del batch +1300ms al batch inmediato del `__fylLoadDeferred`     | ✅ por construcción: `whatsapp.js` ya carga como `<script defer>` clásico fuera del `__fylLoadDeferred` (línea 1121, ejecuta apenas DOM parseado, más temprano aún). `notifications.js` y `auth-status.js` **no se importan** (la versión pública no tiene esos componentes — diferencia permitida por DEC-001). | ✅ paridad de efecto (handlers responden ≤ momento equivalente) |
| **T4** onboarding menos invasivo    | ✅ commit `ea494c9`: `OPEN_DELAY_MS` 3000→6000, abort en `pointerdown / touchstart / scroll / hashchange`                        | ✅ por construcción: `catalog-onboarding.js` **no se importa** en `catalogo.html` (no hay `#catalog-onboarding` ni el script). La forma más extrema de "menos invasivo" = no aparecer. Diferencia permitida por DEC-001.                                                                                         | ✅ paridad de efecto (no roba taps en ninguno)                  |


**Decisión sobre T3 y T4 en `catalogo.html`:** **NO se portan literalmente** porque los scripts implicados (`notifications.js`, `auth-status.js`, `catalog-onboarding.js`) **no existen** en `catalogo.html` por diseño consciente (DEC-001 los lista como "diferencias permitidas"). El efecto de FASE 1A (no robar interacción durante boot) está cumplido en `catalogo.html` por construcción.

**T1 en `catalogo.html`** se aplicó como cambio mínimo (1 línea + comentario marcador) sobre el WIP previo. Igual que en `index.html`, queda en disco sin commit aislado porque el `<link rel="stylesheet" href="styles-desktop.css">` ya estaba en el WIP previo del usuario; no se puede commitear el `media=` sin arrastrar el WIP. Comportamiento idéntico al de `index.html`.

### Nota sobre T1

T1 modifica una línea (`<link rel="stylesheet" href="styles-desktop.css">`) que **no existe en HEAD** — está sólo en tu WIP previo de `index.html`. Además `styles-desktop.css` está untracked en el repo.

Por eso T1 **no se puede commitear como FASE 1A puro** sin arrastrar tu WIP previo. El cambio quedó **en disco** con `media="(min-width: 1024px)"` correcto, pero el commit queda pendiente hasta que decidas cómo entra `styles-desktop.css` al repo:

- **Opción A — un solo commit conjunto** (recomendado): cuando agregues `styles-desktop.css` y el `<link>` en index al repo, ya queda con `media=` correcto desde el primer commit. Marcalo como `[FASE 1A][T1] styles-desktop async mobile-safe` y referenciá [[../Performance/PERF-006-Styles-Desktop-Render-Blocking]].
- **Opción B — dos commits separados**: primero `chore: add styles-desktop experimental layer` (sin `media=`), después `[FASE 1A][T1] styles-desktop async mobile-safe` (agregando `media=`). Implica deployar styles-desktop bloqueante por un momento — no recomendado.

Para el smoke ya validado, T1 está activo localmente: en mobile, `styles-desktop.css` se descarga con prioridad lowest y no bloquea render. La diferencia entre commitear vs no commitear sólo afecta el historial git, no el comportamiento actual.

---

## T1 — `styles-desktop.css` con `media="(min-width: 1024px)"`

### Diagnóstico verificado en código

- `index.html:15` → `<link rel="stylesheet" href="styles-desktop.css?v=m260512">` sin `media`.
- `styles-desktop.css` confirmado: **toda** la hoja está dentro de un único `@media (min-width: 1024px) {}` (línea 8). **Cero reglas globales** fuera del media query. Verificado con grep.

### Cambio

`index.html:15`:

```html
<link rel="stylesheet" href="styles-desktop.css?v=m260512" media="(min-width: 1024px)">
```

### Archivos modificados

- `index.html` (1 línea)

### Impacto esperado

- Mobile: navegador descarga `styles-desktop.css` con prioridad "Lowest" y **no bloquea render**. Estimado −200/−600ms en LCP en mobile 3G/4G.
- Desktop ≥1024px: comportamiento idéntico (sigue aplicando las reglas).
- Devtools "Eliminate render-blocking resources" deja de listarlo.

### Riesgos

- Ninguno relevante. Si alguna regla cayera fuera del `@media` por error humano futuro, no aplicaría en mobile — pero hoy no hay ninguna.

### Verificación post-cambio

- DevTools mobile → Network: `styles-desktop.css` con prioridad "Lowest", no marcado como render-blocking.
- Desktop ≥1024px: layout idéntico a antes (header grid, container 1720px, etc.).
- Mobile <1024px: ningún cambio visual.

---

## T2 — Overlay boot deja de capturar clicks

### Diagnóstico verificado en código

- `index.html:475-478` → `<div id="catalog-boot-overlay">` se monta en `<body class="catalog-boot-active">`.
- `styles.css:833` → `body.catalog-boot-active { overflow: hidden; }` bloquea scroll.
- `styles.css:837-846` → overlay `position: fixed; inset: 0; z-index: 10040; background: rgba(245,243,240,0.97);` sin `pointer-events: none` mientras está activo.
- Resultado real: **todo tap cae sobre el overlay y se pierde**.

### Cambio (minimalista)

Sólo CSS, sin tocar JS de boot:

```css
/* styles.css */
body.catalog-boot-active {
  /* scroll permitido durante el boot para que la usuaria pueda explorar header */
  overflow: auto;          /* antes: hidden */
}

.catalog-boot-overlay {
  pointer-events: none;    /* permite tap en lo que esté detrás */
  /* mantenemos el background visual; el feedback de "estoy cargando" sigue ahí */
}

/* Si quisiéramos que la zona de dots sí capture tap (opcional / no necesario hoy):
.catalog-boot-dots {
  pointer-events: auto;
}
*/
```

### Archivos modificados

- `styles.css` (3–5 líneas en el bloque que ya existe: `body.catalog-boot-active` y `.catalog-boot-overlay`)

### Impacto esperado

- Tap en header (avatar, campana, FAB WhatsApp) llega al elemento real durante el boot.
- Scroll vertical disponible temprano (la usuaria puede "asomarse" al catálogo).
- Feedback visual de carga se mantiene (los dots + fondo opaco siguen visibles).
- Dead clicks de los primeros 8–10s deberían caer fuerte en Clarity.

### Riesgos

- Si alguna lógica de boot dependiera de que el `<body>` tuviera scroll bloqueado, podríamos ver doble scroll o saltos. Mitigación: `overflow: hidden` durante boot **mantiene el feedback** pero la usuaria no puede explorar; podemos dejarlo `hidden` y aún así con `pointer-events: none` los clicks **en posición fija (header, FAB)** funcionan. Decisión final en implementación.
- Si la usuaria scrollea durante el boot y luego se renderiza el catálogo, podría haber un pequeño salto. Aceptable.

### Verificación post-cambio

- Repro mobile real con throttle 3G: tap en `.cliente-link`, `#header-notifications`, `#wa-toggle` durante los primeros 5s ⇒ responde (al menos visualmente, ver T3).
- El overlay sigue siendo visualmente perceptible.
- Al terminar el boot, el overlay desaparece sin glitches.
- Clarity 7 días: caída de dead clicks en los primeros 10s de sesión.

---

## T3 — Handlers críticos no diferidos

### Diagnóstico verificado en código

Hoy en `index.html:1250-1281` los scripts se cargan así:

```
fyl-catalog-boot-done dispara __fylLoadDeferred:
  · auth-status.js          → inmediato (ya en este batch)
  · scroll.js               → +300ms
  · product-alternatives.js → +300ms
  · notifications.js        → +1300ms   ← ⚠️ handler campana
  · catalog-onboarding.js   → +1300ms
  · whatsapp.js             → +1300ms   ← ⚠️ handler FAB
  · pwa-install.js          → +2200ms
```

Y `__fylLoadDeferred` se dispara con `fyl-catalog-boot-done` o tras 8000ms (fallback).

Resultado: handlers de FAB y campana **no existen hasta varios segundos después del primer paint**.

Elementos visibles desde paint inicial:

- `#wa-toggle` (`index.html:1100`) — `<button>`, requiere JS.
- `#header-notifications` (`index.html:687`) — `<button>`, requiere JS.
- `.cliente-link` (`index.html:694`) — `<a href="#" onclick="return false;">`, su `onclick="return false"` ya neutraliza la navegación pero **no hay handler real hasta que carga `auth-status.js`**.

### Cambio

Mover `whatsapp.js` y `notifications.js` al **primer batch** (inmediato, sin esperar `fyl-catalog-boot-done`).

`index.html:1264-1273` queda así (cambios marcados):

```js
function __fylLoadDeferred() {
  if (__fylDeferredLoaded) return;
  __fylDeferredLoaded = true;
  // Auth del header tiene prioridad para no afectar CTA de login.
  import("./scripts/auth-status.js?v=m260512");
  // [FASE 1A] Handlers críticos UX: se cargan junto a auth-status para evitar dead clicks
  import("./scripts/whatsapp.js?v=m260512");
  import("./scripts/notifications.js?v=m260512");
  __fylSchedulePostBootTask(function () {
    import("./scripts/scroll.js?v=m260512");
    import("./scripts/product-alternatives.js?v=m260512");
  }, 300);
  __fylSchedulePostBootTask(function () {
    // [FASE 1A] whatsapp.js y notifications.js movidos al batch inmediato
    import("./scripts/catalog-onboarding.js?v=m260512");
  }, 1300);
  __fylSchedulePostBootTask(function () {
    var s = document.createElement("script");
    s.src = "scripts/pwa-install.js?v=m260512";
    document.body.appendChild(s);
  }, 2200);
}
```

**Nota:** sigue dependiendo de `fyl-catalog-boot-done` (o 8s fallback). Para acortar más, evaluamos en T3-b si es necesario (no se hace en esta tarea).

### Archivos modificados

- `index.html` (mover 2 líneas, comentar el cambio)

### Impacto esperado

- Handlers de FAB y campana atados **~1300ms antes**, justo cuando la usuaria empieza a explorar.
- Sin cambio en peso total descargado (mismos scripts, sólo orden).
- `.cliente-link` ya recibía `auth-status.js` en este batch — no necesita cambio para T3, su comportamiento mejora porque ya no tiene el overlay encima (T2).

### Riesgos

- `notifications.js` consulta Supabase al cargar. Si lo cargamos antes, puede competir con `main-supabase.js` por conexión. Mitigación: `notifications.js` ya tiene guard `hasLikelySupabaseSession()` para no consultar sin sesión, así que en invitados es no-op. Para clientes logueados, una request extra es aceptable.
- `whatsapp.js` registra un listener delegado en `document` para Meta Lead tracking. No tiene side-effects pesados.

### Verificación post-cambio

- Tap en `#wa-toggle` 2s post-paint ⇒ abre menú o navega a WhatsApp.
- Tap en `#header-notifications` 2s post-paint ⇒ abre panel.
- No regresión en `Meta Lead` tracking (testear en DevTools console con `localStorage.fyl_debug_pixel="1"`).
- Clarity 7 días: dead clicks específicos en `#wa-toggle` y `#header-notifications` caen.

---

## T4 — Onboarding respeta interacción y scroll

### Diagnóstico verificado en código

`scripts/catalog-onboarding.js:10` → `OPEN_DELAY_MS = 3000`.

Flujo actual:

1. `fyl-catalog-boot-done` dispara `onBootDone()` → `tryShowOnboarding()`.
2. Verifica `STORAGE_KEY` ("nunca más"), `SEEN_KEY` ("ya vista") y `tryLock`.
3. Si está logueado, aborta.
4. `**setTimeout(openOnboarding, 3000)`** ⇒ abre 3s después, robando el primer tap.

No respeta si la usuaria ya interactuó / scrolleó / abrió PDP.

### Cambio

Edición mínima en `scripts/catalog-onboarding.js`:

1. Cambiar `OPEN_DELAY_MS` de `3000` → `6000` (más conservador).
2. Agregar abort si hay interacción durante la espera:

```js
const OPEN_DELAY_MS = 6000;          // antes: 3000
const ABORT_EVENTS = ["pointerdown", "touchstart", "scroll", "hashchange"];

let openTimer = null;
let abortHandler = null;

function clearOpenTimer() {
  if (openTimer) { clearTimeout(openTimer); openTimer = null; }
  if (abortHandler) {
    ABORT_EVENTS.forEach(ev => window.removeEventListener(ev, abortHandler, true));
    abortHandler = null;
  }
}

// Dentro de tryShowOnboarding, reemplazar el setTimeout actual por:
clearOpenTimer();
abortHandler = function () {
  // Si el usuario ya interactuó antes de que pase OPEN_DELAY_MS, no abrir hoy.
  clearOpenTimer();
};
ABORT_EVENTS.forEach(ev => window.addEventListener(ev, abortHandler, { once: true, passive: true, capture: true }));

openTimer = setTimeout(() => {
  clearOpenTimer();
  openOnboarding();
}, OPEN_DELAY_MS);
```

1. En `closeOnboarding`, también llamar a `clearOpenTimer()` por las dudas.

### Archivos modificados

- `scripts/catalog-onboarding.js` (~15 líneas modificadas, mismo módulo)

### Impacto esperado

- Si la usuaria entra y empieza a explorar (tap, scroll, hash a PDP) en los primeros 6s, **no se le abre el onboarding hoy**. Vuelve a intentar la próxima sesión (sin marcar `SEEN_KEY`).
- Si la usuaria queda quieta 6s mirando, recién entonces aparece el onboarding (sigue cumpliendo función educativa para quien necesita la guía).
- Rage clicks contra el modal "que aparece de la nada" caen.

### Riesgos

- Si una usuaria no interactúa durante 6s y queremos sí mostrárselo, el delay extra es aceptable; los benchmarks de tutoriales recomiendan ≥5s para no robar atención del primer paint.
- `passive: true` en los listeners de abort impide que bloqueen scroll.
- `capture: true` asegura que detectamos eventos antes de que sean stop-propagated.
- Si el `setTimeout` se queda colgado por bug, en la rama abortada también lo limpiamos.

### Verificación post-cambio

- Limpiar localStorage `fyl-catalog-onboarding-hide` y `fyl-catalog-onboarding-seen`.
- Repro: cargar catálogo, esperar boot, NO interactuar 7s ⇒ aparece onboarding.
- Repro: cargar catálogo, hacer un tap o un scroll dentro de los primeros 6s ⇒ NO aparece onboarding en esta sesión.
- Repro: cargar catálogo, tappear PDP a los 2s ⇒ NO aparece onboarding cuando se cierra el PDP.
- Clarity 7 días: rage clicks en zona del modal de bienvenida caen.

---

## Orden de implementación recomendado

1. **T1** (CSS-only, 1 línea, riesgo mínimo). Push solo.
2. **T2** (CSS-only en `styles.css`, 3–5 líneas). Push solo.
3. **T4** (un solo módulo JS, sin tocar boot). Push solo.
4. **T3** (mover 2 imports en `index.html`). Push solo.

Cada cambio en deploy separado para poder atribuir métricas en Clarity. Si algo se rompe, rollback de **un solo cambio**, no de los cuatro.

---

## Cache-bust

Cada deploy debe:

- Subir versión en `app-version.json`
- Ejecutar `npm run build` (que actualiza `?v=` en todos los HTML)
- Confirmar `<meta name="app-version">` en `index.html`

---

## Tracking de progreso


| Tarea | Commit                            | Aplicado en                                                  | Deploy    | LCP antes / después | INP antes / después | Dead clicks antes / después | Notas                                                                                                                       |
| ----- | --------------------------------- | ------------------------------------------------------------ | --------- | ------------------- | ------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| T1    | 🟡 sin commit · en disco en ambos | `index.html` + `catalogo.html`                               | pendiente | ~10s / —            | ~1300ms / —         | alto / —                    | `media="(min-width: 1024px)"` agregado al link en ambos. Commit pendiente porque la línea base estaba en WIP previo         |
| T2    | ✅ `d2c6ab5` · 2026-05-12          | `styles.css` (compartido) → ambos                            | pendiente | —                   | —                   | —                           | `body.catalog-boot-active { overflow:auto }` + `pointer-events:none` en overlay; `pointer-events:auto` en dots              |
| T3    | ✅ `3cb7f70` · 2026-05-12          | `index.html` · `catalogo.html` por construcción              | pendiente | —                   | —                   | —                           | `whatsapp.js` y `notifications.js` al batch inmediato. `catalogo.html` ya tenía `whatsapp.js` como `<script defer>` clásico |
| T4    | ✅ `ea494c9` · 2026-05-12          | `scripts/catalog-onboarding.js` (solo `index.html` lo carga) | pendiente | —                   | —                   | —                           | `OPEN_DELAY_MS` 3000→6000; abort en `pointerdown/touchstart/scroll/hashchange`. `catalogo.html` no carga el script          |


Actualizar este bloque tras cada deploy. Métricas → ver [[../Metricas/00-KPIs-Catalogo]].

### Smoke test 2026-05-12 (pre-deploy, sobre `index.html` local)

- Setup: Chrome DevTools mobile (Pixel 5, 360–390px), throttling Slow 4G / Fast 3G.
- T2 (overlay no-bloqueante): ✅ tappear header durante boot no atrapa el tap; scroll permitido; sin glitches al salir del overlay.
- T3 (handlers críticos): ✅ FAB y campana responden apenas termina el boot, sin ventana de +1300ms.
- T4 (onboarding): ✅ no aparece si hay interacción dentro de los primeros 6s; aparece si la usuaria queda quieta.
- T1 (styles-desktop media=): ✅ desktop ≥1024px sin cambios visuales; mobile sin descarga prioritaria del archivo.
- ⚠️ Hallazgo nuevo durante smoke → [[../UX/UX-005-Cambio-Categoria-Sin-Feedback]] (asociado a [[FASE-1B-Render-Feedback]], no se ataca en 1A).

### Smoke test 2026-05-12 — POST-BUILD sobre `catalogo.html` real (firebase emulator + ide-browser)

- Setup: `firebase emulators:start --only hosting` en `http://127.0.0.1:5000` · viewport 390×844 · navegación a `/catalogo` (rewrite Firebase real).
- **Build resultado**: `npm run build` → exit 0 · `v=m260514` · HTML 57/69 · sw.js sí · 5 JS extra · `config.prod.js` + `config.local.js` generados · sin errores.
- **Verificación cache-bust**:
  - `app-version.json` intacto (`m260514`, es input).
  - `<meta name="app-version" content="m260514">` en ambos entrypoints.
  - `?v=` único en `index.html` y `catalogo.html`: `m260514` (cero reliquias de m260512/m260420).
  - `SW_BUILD_TAG = "m260514"` en `sw.js`.
- **Verificación FASE 1A intacta post-build**:
  - T1 line 16 en `index.html` y `catalogo.html`: `<link rel="stylesheet" href="styles-desktop.css?v=m260514" media="(min-width: 1024px)">`. El comentario "[FASE 1A · T1]" preservado.
  - T2 `styles.css:833+`: `body.catalog-boot-active`, `.catalog-boot-overlay`, `.catalog-boot-dots` con `pointer-events` correctos.
  - T3 `index.html:1264`+: `__fylLoadDeferred` con `whatsapp.js` y `notifications.js` en batch inmediato, comentarios FASE 1A preservados, `?v=m260514`.
  - T4 `scripts/catalog-onboarding.js`: `OPEN_DELAY_MS = 6000`, `ABORT_EVENTS`, `clearOpenTimer` preservados.
- **Smoke runtime sobre `catalogo.html`**:
  - ✅ Página renderiza completa, overlay desaparece tras boot.
  - ✅ Header mobile correcto (logo, search, link WhatsApp pill verde). Sin estilos desktop aplicados (T1 funciona).
  - ✅ Tap en categoría "Calzado" → estado `active, focused` + productos renderizados al instante + URL actualiza a `?tab=calzado`. T3 OK.
  - ✅ FAB "Abrir WhatsApp" visible y clickeable (`whatsapp.js` defer clásico carga inmediato).
  - ✅ Tras 7s+ de espera, **no** aparece modal de onboarding. `browser_search` confirma string "Bienvenida" no existe en el DOM. T4 cumplido por construcción.
  - ✅ Sin errores de imports rotos por cache-bust en consola.
  - ⚠️ 1 error preexistente: `[fylAnalytics] init omitido app_area invalido public_catalog` (`analytics.js:19`). Registrado como [[../Bugs/BUG-001-Analytics-Init-App-Area-Invalido]] (no FASE 1A, pre-existente).
- **Verificación curl/headers**:
  - `/catalogo` → 200, body de `catalogo.html` (48377 bytes, mismo ETag que `/catalogo.html`).
  - ⚠️ Firebase emulator local no aplica los `redirects` 301 (`/` → `/catalogo`) ni los `headers` Cache-Control de `firebase.json`. Es limitación conocida del emulator, **en producción Firebase Hosting sí los aplica**.

**Conclusión smoke post-build**: FASE 1A sobre `catalogo.html` funciona como esperado. Cache-bust limpio, sin imports rotos. Listo para push/deploy (cuando el usuario decida). Ver bitácora resumida en [[../Deploys/DEP-2026-05-12-v01-FASE-1A-Predeploy]].

---

## Hallazgos del smoke (registrados, no resueltos en 1A)


| Fecha      | Hallazgo                                                         | Severidad | Doc                                                                                     |
| ---------- | ---------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------- |
| 2026-05-12 | Cambio de categoría sin feedback inmediato → doble tap percibido | alto      | [[../UX/UX-005-Cambio-Categoria-Sin-Feedback]] → asociado a [[FASE-1B-Render-Feedback]] |


> Los hallazgos detectados durante el smoke **no se atacan en 1A**. Se documentan y se asocian a la fase correspondiente para no perder contexto.

---

## Lo que NO se hace en FASE 1A (queda para FASE 1B+)

- Render card-a-card → [[../Performance/PERF-007-Render-Card-A-Card]] (Fase 2)
- MutationObserver de filtros → [[../Performance/PERF-002-MutationObserver-Filtros]] (Fase 2)
- scroll.js layout thrashing → [[../Performance/PERF-003-Scroll-JS-Layout-Thrashing]] (Fase 4)
- setInterval imágenes lazy → [[../Performance/PERF-004-SetInterval-Imagenes-Lazy]] (Fase 1B-Quick-Win, próxima)
- Color swatches touch target → [[../UX/UX-004-Color-Swatches-Touch-Target]] (Fase 1B)
- Round-trips Supabase → [[../Performance/PERF-001-LCP-Round-Trips-Supabase]] (Fase 3)

---

## Cruces

- [[../Performance/2026-05-12-Auditoria-Inicial]] — origen
- [[../UX/UX-001-Overlay-Boot-Bloquea-Interaccion]]
- [[../UX/UX-002-Handlers-Diferidos-Header-FAB]]
- [[../UX/UX-003-Onboarding-Roba-Tap]]
- [[../Performance/PERF-006-Styles-Desktop-Render-Blocking]]
- [[00-Roadmap-Performance-Q2-2026]]

