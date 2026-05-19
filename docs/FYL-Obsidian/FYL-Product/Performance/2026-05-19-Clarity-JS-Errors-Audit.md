# CLAR-2026-05-19 — Auditoría errores JavaScript (Microsoft Clarity)

- **Fecha:** 2026-05-19
- **Alcance:** `catalogo.html`, `index.html`, hosting Firebase, boot/config/SW, analytics, vendors (gtag, Meta Pixel, Clarity)
- **Contexto Clarity:** 342 errores JS en ~2,90 % de grabaciones; 94,15 % como `Script error.`
- **Restricciones:** Vanilla JS, sin migración React/Next, sin desactivar Pixel/Clarity sin análisis de impacto, catálogo mobile-first
- **Estado:** auditoría + plan; **sin aplicar patches** salvo aprobación explícita

---

## 1. Resumen ejecutivo

| Categoría | % estimado del volumen Clarity | ¿Bug FYL? | Acción |
|-----------|-------------------------------|-----------|--------|
| `Script error.` (CORS / terceros) | ~94 % | No (medición) | Diagnóstico + `crossorigin` + tags Clarity; evaluar vendors en WebView |
| WebView Meta (`java object is gone`) | ~3,5 % | No | Segmentar en Clarity; no “arreglar” en JS propio |
| `unexpected end of input` | ~1,5 % | Posible (assets/HTML/caché) | Sync versiones + listener carga + probe config |
| Analytics `public_catalog` inválido | 0 % en Clarity | **Sí** (medición GA4) | Fix trivial `app_area: "catalog"` |
| Desfase `m260514` vs `m260518` en `catalogo.html` | Contribuye a riesgo asset | **Sí** (deploy) | `npm run build` en Fase 1 |

**Conclusión:** El KPI de Clarity **sobreestima fallos del catálogo**. La UX ya suprime overlays para muchos errores benignos (`fyl-runtime-resilience.js`), pero Clarity sigue contándolos. El tráfico principal entra por `/catalogo` (redirect 301 desde `/`), y **`catalogo.html` está desfasado 4 revisiones** respecto a `app-version.json` / imports internos en `m260518`, lo que aumenta riesgo de caché mixta e inconsistencias de boot.

**Prioridad recomendada:** Fase 0–1 (sync versión + fix analytics + diagnóstico capture) antes de decidir apagar vendors en WebView Meta.

---

## 2. Tabla error → causa → evidencia → impacto → acción

| Error Clarity | Causa probable | Evidencia en repo | Impacto usuario | Acción |
|---------------|----------------|-------------------|-----------------|--------|
| `Script error.` | Fallo en script **cross-origin** sin `crossorigin` (gtag, fbevents, clarity.ms) o extensión | Vendors insertados sin `crossorigin` (`catalogo.html` L367–370, L385–387, L487–488); benigno en `fyl-runtime-resilience.js` L263–265 | Bajo en catálogo; alto en atribución | `crossorigin="anonymous"` + listener capture; tags `error_class=third_party` |
| `Script error.` | Bloqueo tracker (Safari ITP, Private Relay, adblock) | Obsidian `10-BUGS-RESUELTOS.md`; vendors diferidos | Nulo en compra | Segmentar; no overlay |
| `Error invoking postMessage: java object is gone` | Bridge Android WebView Meta destruido | No hay `postMessage` a Java en código FYL; solo workers Supabase en bundle | Nulo | Tag `in_meta_webview`; excluir en dashboards |
| `Error invoking enableDidUserTypeOnKeyboardLogging: java object is gone` | Idem, API interna Meta | Ausente en código FYL | Nulo | Idem |
| `unexpected end of input` | `config.prod.js` o `.js` recibe HTML (rewrite `**`) o body truncado | `config.js` L77–79, L81–158 (probe definido); `firebase.json` L98–101 | **Alto** si ocurre en boot (catálogo no arranca) | Re-habilitar probe en prod sin marker; listener `SCRIPT` load error |
| `unexpected end of input` | URL de script obsoleta → rewrite a `catalogo.html` | `firebase.json` L98–101; archivos estáticos existentes se sirven primero **solo si existen** | Medio en usuarios con bookmark viejo | Listener + cache-bust; opcional guard hosting |
| `unexpected end of input` | `JSON.parse` sin guard en runtime | Varios módulos (carrito, etc.) | Bajo puntual | try/catch en hot paths (Fase 2+) |
| GA4 inactivo en `/catalogo` | `app_area: "public_catalog"` inválido | `catalogo.html` L1119; `analytics.js` L9, L72–76 | Medio en decisiones producto | `app_area: "catalog"` |
| Mezcla de versiones | HTML `?v=m260514` + imports estáticos `?v=m260518` | Ver §4 | Medio (módulos inconsistentes, caché immutable) | `npm run build` |

---

## 3. Hallazgos confirmados (archivo / línea)

### 3.1 Vendors en `catalogo.html` e `index.html` (paridad)

Ambas páginas comparten el mismo patrón de carga diferida.

| Aspecto | Evidencia | Detalle |
|---------|-----------|---------|
| **gtag stub síncrono** | `catalogo.html` L358–371; `index.html` L258–271 | `dataLayer` + `gtag('config')` en inline; red real en `__FYL_loadGtag` |
| **Meta Pixel stub síncrono** | `catalogo.html` L373–416; `index.html` L273–316 | `fbq('init')` + `fbq('track','PageView')` **antes** de insertar `fbevents.js` (cola estándar) |
| **Clarity stub** | `catalogo.html` L480–490; `index.html` L380–390 | Cola `clarity()`; script real en `__FYL_insertClarity` |
| **Sin `crossorigin`** | Mismas líneas de `createElement("script")` | Ningún `s.crossOrigin = "anonymous"` |
| **Cuándo cargan** | `catalogo.html` L492–514; `index.html` L392–414 | (1) Primera interacción `pointerdown/touchstart/keydown/scroll`; (2) evento `fyl-catalog-boot-done` + 2 s; (3) timeout 15 s |
| **No duplicación de insert** | Flags `__FYL_gtagLoaded`, `__FYL_fbPixelLoaded`, `__FYL_clarityLoaded` | Idempotente |
| **“Duplicación” PageView Meta** | `fbq` inicial + SPA hook L529+ (`catalogo`) | Por diseño (ruta SPA); dedupe por `__FYL_lastFbPageViewKey` |
| **Clarity hash antes de script** | `catalogo.html` L516–527 | Usa stub en cola → **seguro** |

**Carga tardía:** correcta para performance (Obsidian `10-BUGS-RESUELTOS.md`). No es la causa principal de `Script error.`; los errores aparecen **cuando** los vendors cargan (post-interacción o 15 s), coincidiendo con sesiones activas en Clarity.

### 3.2 `firebase.json` — rewrites y caché

| Regla | Líneas | Riesgo |
|-------|--------|--------|
| Redirect `/` → `/catalogo` | L47–50 | Producción usa **`catalogo.html`** |
| Rewrite catch-all `**` → `catalogo.html` | L98–101 | Rutas **sin archivo estático** devuelven HTML |
| JS/CSS `immutable, max-age=31536000` | L215–222 | Fuerte si `?v=` desalineado |
| `config.prod.js`, `sw.js`, HTML `no-cache` | L104–170, L237–248 | Correcto |
| `scripts/config.js`, `boot-telemetry.js`, `fyl-runtime-resilience.js` `no-cache` | L263–297 | Correcto |
| **Excepción:** `main-supabase.js` y resto de `/scripts/**` | Heredan regla `**/*.js` immutable | Depende 100 % de `?v=` |

**Comportamiento Firebase Hosting:** los archivos en `public` se sirven **antes** que rewrites. Riesgo real: petición a `/scripts/archivo-eliminado.js` o typo → HTML → `unexpected end of input` / `Unexpected token '<'`.

### 3.3 Config, probe y estado inconsistente

| Hallazgo | Archivo | Líneas |
|----------|---------|--------|
| Documentación HTML-as-JS | `scripts/config.js` | L77–79 |
| `probeConfigProdJsResponse()` implementado | `scripts/config.js` | L81–158 |
| **Probe NO invocado en `configReady`** (solo warning si falta marca) | `scripts/config.js` | L186–189 |
| Marca esperada `__FYL_CONFIG_PROD_LOADED__` | `scripts/generate-config.mjs` | L103–104 |
| Si `<script src="/config.prod.js">` parsea HTML → fallo **síncrono** antes de módulos | `catalogo.html` L1097; `index.html` L1228 | Boot abortado |
| Fallback credenciales en `config.js` si prod falla | `scripts/config.js` | L44–51 | Catálogo puede seguir **sin** prod válido → riesgo de drift config |
| `configReady` no bloquea por marker faltante | `scripts/config.js` | L161–251 | Módulos siguen; diagnóstico incompleto |

### 3.4 Service Worker y resiliencia

| Hallazgo | Archivo | Líneas |
|----------|---------|--------|
| SW network-only solo `/scripts/vendor/*` y `/config.prod.js` | `sw.js` | L16–70 |
| `SW_BUILD_TAG = "m260518"` | `sw.js` | L14 |
| Registro SW en `config.js` (no en admin) | `scripts/config.js` | L262–291 |
| `Script error.` benigno para overlay | `scripts/fyl-runtime-resilience.js` | L260–267, L337–338 |
| `fylReportClientError` opcional vía `FYL_ERROR_LOG_URL` | `scripts/fyl-runtime-resilience.js` | L102–137 |
| Doble `window.onerror`: `boot-telemetry.js` + resiliencia | `boot-telemetry.js` L176–188; `fyl-runtime-resilience.js` L327–344 | Posible doble conteo interno |

### 3.5 Versionado / cache-bust — **desfase confirmado**

| Fuente | Versión |
|--------|---------|
| `app-version.json` | `m260518` |
| `scripts/fyl-version.js` | `m260518` |
| `sw.js` `SW_BUILD_TAG` | `m260518` |
| `index.html` (meta + todos `?v=`) | `m260518` |
| **`catalogo.html` (meta + todos `?v=`)** | **`m260514`** |

**Mezcla crítica en producción (`/catalogo`):**

- HTML carga `scripts/main-supabase.js?v=m260514` y `scripts/config.js?v=m260514`.
- Esos archivos **importan estáticamente** dependencias con `?v=m260518`:
  - `scripts/main-supabase.js` L11, L22 → `supabase-client.js?v=m260518`, `fyl-fetch.js?v=m260518`
  - `scripts/config.js` L1, L284 → `fyl-version.js?v=m260518`, `fyl-runtime-resilience.js?v=m260518`
  - `scripts/boot-telemetry.js` L194 → `fyl-runtime-resilience.js?v=m260518`
  - `scripts/supabase-client.js` L20–21

Efecto: el navegador puede cachear **dos familias** de módulos (514 en URL de entrada vs 518 en grafo interno) con `Cache-Control: immutable`. Riesgo de regresiones intermitentes y errores de parseo en actualizaciones.

**Corrección segura:** `npm run build` (ejecuta `cache-bust-html.mjs` sobre **todos** los `.html` del repo). No requiere cambio de lógica.

### 3.6 Analytics — bug confirmado solo en `catalogo.html`

```javascript
// catalogo.html L1117–1120
fylAnalytics.init({ app_area: "public_catalog", page_type: "home", user_role: "guest" });
```

```javascript
// scripts/analytics.js L9, L72–76
const VALID_APP_AREAS = new Set(["catalog", "client"]);
if (!VALID_APP_AREAS.has(area)) {
  _warn("init omitido app_area invalido", area);
  _ready = false;
  return;
}
```

`index.html` L1249 usa `app_area: "catalog"` → **correcto**.

**Impacto:** GA4 ecommerce/SPA del catálogo público no inicializa en la URL principal de producción. No genera `Script error.` en Clarity, pero **rompe correlación** error ↔ comportamiento en GA.

### 3.7 Diferencias estructurales `catalogo.html` vs `index.html` (no bloqueantes para Clarity)

| Elemento | `catalogo.html` | `index.html` |
|----------|-----------------|--------------|
| `fyl-error-state.js` explícito | Sí (L1112) | No (vía `boot-telemetry`) |
| `fyl-header-early.js` | No | Sí (L1110) |
| `cart-persistent.js` | No | Sí |
| `catalogo-publico.js` | Sí | No |
| Curated banner | `curated-banner.js` directo | `fyl-curated-banner-loader.js` |
| Redirect prod | Destino principal | 301 a `/catalogo` |

---

## 4. Riesgos no confirmados (requieren Clarity / producción)

| Hipótesis | Cómo confirmar |
|-----------|----------------|
| % exacto de `Script error.` por dominio (`connect.facebook.net` vs `googletagmanager.com` vs `clarity.ms`) | Listener capture Fase 0 + muestra sesiones Clarity con Network |
| `Script error.` atribuible a extensión Chrome | Filtro UA desktop + reproducir con extensiones |
| `unexpected end of input` correlacionado con `config.prod.js` | Listener: `src` termina en `config.prod.js` + body prefix `<!` |
| Spike post-deploy sin `npm run build` | Comparar fecha deploy vs `meta app-version` en HTML servido live |
| Doble conteo 342 ≠ 342 usuarios únicos | Clarity “errors per session” vs dedupe |

---

## 5. Diseño: diagnóstico de recursos (Fase 0 / 2)

### 5.1 Objetivos

1. Capturar **URL** en fallos de carga (`script`/`link`) vía fase capture.
2. Clasificar sin mostrar overlay al usuario.
3. Alimentar `markBootStage` / `fylReportClientError` / tags Clarity.

### 5.2 Taxonomía `error_class`

| Clase | Criterio |
|-------|----------|
| `third_party` | `src`/`href` host ∉ `location.host` y host ∈ lista vendors |
| `meta_webview` | UA `FBAN|FBAV|Instagram|IABMV` + mensaje bridge Java |
| `asset_html_instead_js` | Mismo origen + (`Unexpected token '<'` o probe prefix `<!`) |
| `network_truncated` | `unexpected end of input` + mismo origen `.js` |
| `first_party_exception` | Mismo origen + mensaje ≠ `Script error.` |
| `benign_third_party_exec` | `Script error.` + sin `target.src` (ejecución cross-origin) |

### 5.3 Módulo propuesto: `scripts/fyl-resource-error-diagnostics.js`

- Registrar **una vez** `window.addEventListener('error', handler, true)`.
- Si `event.target` es `SCRIPT` o `LINK`: leer `src`/`href`, clasificar, `fylReportClientError({ kind: 'resource.load', ... })`.
- Delegar mensaje a clasificador compartido con `fyl-runtime-resilience.js` (evitar duplicar lógica benigna).
- **No** llamar `showFylErrorState` para clases benignas.

Cargar desde `boot-telemetry.js` **antes** de resiliencia (orden actual: `fyl-error-state` → `boot-telemetry` → dynamic import resiliencia).

### 5.4 Utilidad UA / entrypoint (compartida)

```javascript
// scripts/fyl-env-tags.js (propuesto)
export function fylDetectMetaInAppBrowser() {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
  return /FBAN|FBAV|Instagram|IABMV/i.test(ua);
}
export function fylBrowserFamily() {
  const ua = navigator.userAgent || "";
  if (/FBAN|FBAV/i.test(ua)) return "facebook_iab";
  if (/Instagram/i.test(ua)) return "instagram_iab";
  if (/Safari/i.test(ua) && !/Chrome|CriOS|FxiOS/i.test(ua)) return "safari";
  if (/Chrome|CriOS/i.test(ua)) return "chromium";
  return "other";
}
export function fylAppEntrypoint() {
  const p = location.pathname || "";
  if (p.includes("catalogo")) return "catalogo";
  if (p.endsWith("index.html") || p === "/") return "index";
  return "other";
}
```

---

## 6. Estrategia Microsoft Clarity

### 6.1 Tags recomendados (vía stub, antes y después de cargar script)

| Tag | Valor | Cuándo |
|-----|-------|--------|
| `app_version` | `FYL_VERSION` o `meta[name=app-version]` | Lo antes posible en `<head>` |
| `app_entrypoint` | `catalogo` \| `index` | Inline post-`DOMContentLoaded` |
| `browser_family` | `facebook_iab` \| `instagram_iab` \| `safari` \| … | Inline |
| `in_meta_webview` | `1` \| `0` | Inline |
| `error_class` | última clasificación FYL | Tras listener (opcional, Fase 2) |

Ejemplo inline (cola Clarity, no requiere script cargado):

```html
<script>
(function () {
  function pushClarityTags() {
    if (typeof clarity !== "function") return;
    var ua = navigator.userAgent || "";
    var inMeta = /FBAN|FBAV|Instagram|IABMV/i.test(ua) ? "1" : "0";
    var meta = document.querySelector('meta[name="app-version"]');
    clarity("set", "app_version", meta ? meta.content : "unknown");
    clarity("set", "in_meta_webview", inMeta);
    clarity("set", "app_entrypoint", location.pathname.indexOf("catalogo") >= 0 ? "catalogo" : "index");
    if (/FBAN|FBAV/i.test(ua)) clarity("set", "browser_family", "facebook_iab");
    else if (/Instagram/i.test(ua)) clarity("set", "browser_family", "instagram_iab");
  }
  pushClarityTags();
  window.addEventListener("fyl-catalog-boot-done", pushClarityTags, { once: true });
})();
</script>
```

### 6.2 Filtros sugeridos en panel Clarity

- **KPI catálogo real:** `in_meta_webview != 1` AND mensaje NOT LIKE `%java object is gone%`
- **Ruido trackers:** mensaje = `Script error.` AND sesión con carga de catálogo OK (scroll / product views)
- **Regresión deploy:** `app_version` ≠ versión esperada

### 6.3 No desactivar Clarity/Pixel sin datos

| Vendor | Desactivar en WebView Meta | Impacto negativo | Alternativa |
|--------|---------------------------|------------------|-------------|
| Meta Pixel | Reduce `Script error.` | Pérdida atribución ads en canal principal | Mantener stub; diferir insert; A/B 5 % sesiones |
| Clarity | Auto-referencial | Pierde grabaciones del canal mayoritario | Tags + filtros |
| gtag | Bajo volumen errores | GA4 incompleto | `crossorigin` + filtros |

**Decisión Fase 3:** solo tras 7 días con `error_class` en muestra ≥ 500 sesiones.

---

## 7. Plan de implementación por fases

### Fase 0 — Diagnóstico (1–2 días, bajo riesgo)

- [ ] Desplegar listener capture + `fyl-env-tags` en staging.
- [ ] Verificar en Clarity tags `in_meta_webview`, `app_version`.
- [ ] Muestrear 20 sesiones `Script error.` con y sin filtro WebView.
- [ ] `?debug_boot=1` en iPhone Safari + WebView Meta: panel boot + consola.

**Criterio de salida:** ≥ 80 % de `Script error.` clasificados como `third_party` o `benign_third_party_exec` con evidencia de URL o dominio.

### Fase 1 — Fixes seguros (mismo deploy, riesgo bajo)

- [ ] `npm run build` → alinear `catalogo.html` a `m260518`.
- [ ] Patch analytics `public_catalog` → `catalog`.
- [ ] Verificar live: `curl -I` `/catalogo.html`, `/config.prod.js`, `/scripts/main-supabase.js?v=m260518`.
- [ ] Checklist predeploy: `meta app-version` === `app-version.json`.

**Criterio de salida:** una sola versión en HTML + imports; GA4 `fylAnalytics.isReady()` true en `/catalogo` (consola: `window.fylAnalytics?.isReady?.()`).

### Fase 2 — Telemetría (3–5 días)

- [ ] Integrar `fyl-resource-error-diagnostics.js`.
- [ ] Unificar clasificación con `fyl-runtime-resilience.js`.
- [ ] Re-habilitar `probeConfigProdJsResponse()` **solo si** `!__FYL_CONFIG_PROD_LOADED__` en producción (sin bloquear boot > 6 s).
- [ ] `crossorigin="anonymous"` en inserts gtag / fbevents / Clarity (validar CORS en red).
- [ ] Documentar en [[../Metricas/00-KPIs-Catalogo]] nuevo denominador “errores first-party”.

### Fase 3 — Decisión vendors WebView (después de datos)

- [ ] Informe: % errores que desaparecen si `__FYL_insertFbPixel` no corre en `in_meta_webview=1`.
- [ ] Si atribución Meta lo permite: skip insert pixel **solo** en IAB (mantener stub + cola).
- [ ] Re-medir Clarity 7 días; objetivo: errores first-party &lt; 5 / 1k sesiones.

---

## 8. Patches propuestos (NO aplicados — pendiente aprobación)

### Patch A — Trivial: analytics `catalogo.html`

```diff
--- a/catalogo.html
+++ b/catalogo.html
@@ -1116,7 +1116,7 @@
   <script type="module">
     import { fylAnalytics } from "./scripts/analytics.js?v=m260514";
-    fylAnalytics.init({ app_area: "public_catalog", page_type: "home", user_role: "guest" });
+    fylAnalytics.init({ app_area: "catalog", page_type: "home", user_role: "guest" });
   </script>
```

> Nota: al ejecutar `npm run build`, el `?v=` se actualizará a `m260518` automáticamente.

### Patch B — Sync versión (comando, no diff manual)

```bash
npm run build
# Equivale: generate-config + cache-bust-html.mjs --mode prod
# Reescribe catalogo.html, index.html, sw.js, fyl-version.js, EXTRA_VERSIONED_FILES
```

Verificar:

```bash
git diff catalogo.html | head -40
# Debe mostrar m260514 → m260518 en meta y ?v=
```

### Patch C — `crossorigin` en vendors (`catalogo.html` / `index.html`)

```diff
     window.__FYL_loadGtag = function () {
       if (window.__FYL_gtagLoaded) return;
       window.__FYL_gtagLoaded = true;
       const s = document.createElement("script");
       s.async = true;
+      s.crossOrigin = "anonymous";
       s.src = "https://www.googletagmanager.com/gtag/js?id=G-2JDYZW1KD6";
       document.head.appendChild(s);
     };
```

```diff
       t = b.createElement(e);
       t.async = true;
+      t.crossOrigin = "anonymous";
       t.src = v;
```

```diff
           t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
+          t.crossOrigin = "anonymous";
```

**Riesgo:** si el CDN no envía `Access-Control-Allow-Origin`, no mejora mensajes de ejecución; no empeora carga. Validar en Network.

### Patch D — Nuevo `scripts/fyl-resource-error-diagnostics.js` (esqueleto)

```javascript
/**
 * Diagnóstico de errores de carga de SCRIPT/LINK (capture).
 * Sin overlay. Clasifica para Clarity / fylReportClientError.
 */
import { fylReportClientError } from "./fyl-runtime-resilience.js?v=m260518";
import { fylDetectMetaInAppBrowser, fylBrowserFamily } from "./fyl-env-tags.js?v=m260518";

const VENDOR_HOSTS = /googletagmanager\.com|google-analytics\.com|connect\.facebook\.net|facebook\.com|clarity\.ms/i;

function classifyResource(url, message) {
  const msg = String(message || "");
  if (/java object is gone/i.test(msg) || /enableDidUserTypeOnKeyboardlogging/i.test(msg)) {
    return "meta_webview";
  }
  if (/unexpected end of input/i.test(msg)) {
    try {
      const u = new URL(url, location.href);
      if (u.origin === location.origin) return "network_truncated";
    } catch (_) {}
  }
  if (/Unexpected token ['"]?<'/i.test(msg)) return "asset_html_instead_js";
  try {
    const u = new URL(url, location.href);
    if (u.origin !== location.origin && VENDOR_HOSTS.test(u.hostname)) return "third_party";
    if (u.origin === location.origin && /\.(js|mjs)(\?|$)/i.test(u.pathname)) return "network_truncated";
  } catch (_) {}
  if (msg === "Script error." || msg === "Script error") return "benign_third_party_exec";
  return "first_party_exception";
}

export function installFylResourceErrorDiagnostics() {
  if (typeof window === "undefined" || window.__FYL_RESOURCE_DIAG__) return;
  window.__FYL_RESOURCE_DIAG__ = true;

  window.addEventListener(
    "error",
    (event) => {
      const t = event.target;
      const tag = t && t.tagName;
      if (tag !== "SCRIPT" && tag !== "LINK") return;
      const url = tag === "SCRIPT" ? t.src : t.href;
      if (!url) return;
      const errorClass = classifyResource(url, event.message);
      const payload = {
        kind: "resource.load",
        error_class: errorClass,
        tag,
        url: String(url).slice(0, 2000),
        message: String(event.message || "").slice(0, 500),
        in_meta_webview: fylDetectMetaInAppBrowser(),
        browser_family: fylBrowserFamily(),
      };
      fylReportClientError(payload);
      try {
        globalThis.markBootStage?.("client.resource_error", payload);
      } catch (_) {}
    },
    true
  );
}
```

```diff
--- a/scripts/boot-telemetry.js
+++ b/scripts/boot-telemetry.js
@@ -191,6 +191,10 @@ markBootStage("boot.telemetry.ready", { debug });
 
+import("./fyl-resource-error-diagnostics.js?v=m260518")
+  .then((m) => m.installFylResourceErrorDiagnostics?.())
+  .catch(() => {});
+
 import("./fyl-runtime-resilience.js?v=m260518")
```

(Añadir `fyl-resource-error-diagnostics.js` y `fyl-env-tags.js` a `EXTRA_VERSIONED_FILES` en `cache-bust-html.mjs`.)

### Patch E — Probe config condicional (`scripts/config.js`)

```diff
       } else {
-        // [PERF] Probe fetch eliminado: solo loguear warning sin hacer roundtrip de red.
         console.warn(
           `${logPrefix} config.prod.js: marca no detectada. Si el cat\u00e1logo funciona, ignorar este aviso.`
         );
+        if (!local && typeof fetch === "function") {
+          fylConfigDiagnostics.configProdFetchProbe = await probeConfigProdJsResponse();
+          if (fylConfigDiagnostics.configProdFetchProbe?.looksLikeHtml) {
+            console.error(`${logPrefix} /config.prod.js parece HTML, no JS`);
+            globalThis.markBootStage?.("config.prod.html_not_js", fylConfigDiagnostics.configProdFetchProbe);
+          }
+        }
       }
```

---

## 9. Verificación post-cambios

| Check | Comando / acción | Esperado |
|-------|------------------|----------|
| Versión HTML | Ver `meta app-version` en `/catalogo` | `m260518` |
| config.prod | DevTools → Network → `/config.prod.js` | `Content-Type: javascript`, cuerpo con `__FYL_CONFIG_PROD_LOADED__` |
| GA4 | Consola: `fylAnalytics.isReady()` | `true` en `/catalogo` |
| Clarity tags | Custom tags en sesión de prueba | `in_meta_webview`, `app_version` |
| Errores | Clarity 7 días post Fase 1 | Caída de `unexpected end` si había drift; `Script error.` estable hasta Fase 2–3 |

---

## 10. Cruces

- [[2026-05-12-Auditoria-Inicial]]
- [[2026-05-18-Implementacion-CWV]]
- [[../Clarity/2026-05-12-Metricas-Iniciales]]
- [[../../10-BUGS-RESUELTOS]] (Safari boot, trackers diferidos, SW)
- [[../Metricas/00-KPIs-Catalogo]]

---

## 11. Decisión registrada

| Tema | Decisión |
|------|----------|
| ¿Son 342 bugs del catálogo? | **No** — mayoría ruido medible |
| ¿Aplicar cambios ahora? | **Fase 1–2 aplicadas** (2026-05-19); Fase 3 pendiente |
| Prioridad 1 | Patch B + A (versión + analytics) — **hecho** |
| Prioridad 2 | Diagnóstico + tags Clarity + crossorigin — **hecho** |
| Pixel/Clarity en WebView | Mantener; decidir en Fase 3 con datos |

---

## 12. Implementación Fase 1 (2026-05-19)

| Cambio | Estado |
|--------|--------|
| `catalogo.html`: `app_area: "catalog"` | Aplicado |
| `npm run build` → `?v=m260518` en `catalogo.html` | Aplicado (`HTML: 1/207` actualizado) |
| `config.prod.js` regenerado | Sí (`generate-config.mjs`) |

**Verificación local:** `meta app-version` y todos los `?v=` en `catalogo.html` = `m260518`; sin restos `m260514`.

**Pendiente deploy:** subir hosting para que producción refleje el HTML; post-deploy comprobar en consola `/catalogo`: `window.fylAnalytics?.isReady?.()` → `true`.

---

## 13. Implementación Fase 2 (2026-05-19)

| Entregable | Archivo |
|------------|---------|
| Clasificación compartida | `scripts/fyl-error-classify.js` |
| Tags entorno (módulos) | `scripts/fyl-env-tags.js` |
| Listener capture SCRIPT/LINK | `scripts/fyl-resource-error-diagnostics.js` |
| Tags Clarity tempranos | `scripts/fyl-clarity-env-tags.js` + `<script>` en `catalogo.html` / `index.html` |
| Hook boot | `scripts/boot-telemetry.js` |
| Overlay + `error_class` en reportes | `scripts/fyl-runtime-resilience.js` |
| Probe `config.prod` si falta marca | `scripts/config.js` |
| `crossOrigin="anonymous"` vendors | `catalogo.html`, `index.html` |
| Cache-bust extra | `scripts/cache-bust-html.mjs` |

**Verificación post-deploy**

- `window.__FYL_RESOURCE_DIAG__` → `true`
- `window.__FYL_pushClarityEnvTags` → función
- Clarity custom tags: `app_version`, `in_meta_webview`, `browser_family`, `app_entrypoint`
- Forzar fallo de carga (DevTools offline + reload): `markBootStage` / consola con `client.resource_error` y `url`
