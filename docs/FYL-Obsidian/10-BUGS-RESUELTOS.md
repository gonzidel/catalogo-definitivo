# 10 — Bugs resueltos (registro desde el código y contexto de repo)

> Estas entradas resumen el comportamiento y la solución **según comentarios y lógica actual en el repositorio**, no un ticket de issue tracker externo. Ajustar fechas si se contrasta con el historial de git.

---

## 2026-05-08 — Safari iPhone: error `no_client` al iniciar el catálogo (Supabase no se inicializaba)

### Síntoma

- En **iPhone real con Safari** (no en BrowserStack ni en Chrome/Android), al cargar `index.html` o `catalogo.html` aparecía el modal:

  > ❌ No se pudo iniciar el catálogo  
  > Detalle: El navegador no pudo cargar la librería de Supabase. Probá recargar, otra red Wi-Fi/datos, o ventana privada.  
  > Código: `no_client`

- Safari mostraba además el cartel **"Reducir protecciones"** y el panel de **"Rastreadores bloqueados"** con `facebook.net`, `googletagmanager.com`, `bing.com` (Microsoft Clarity).
- El usuario quedaba atascado: recargar varias veces no recuperaba; cambiar de red tampoco. En BrowserStack y otros navegadores funcionaba sin problemas.

### Causa raíz (auditoría iterativa)

La causa NO era un único bug sino **una cadena de fragilidades acumuladas** que se manifestaba específicamente en Safari iOS real con **iCloud Private Relay + ITP** activos:

1. **Service Workers legacy (cache-first)** podían servir HTML stale en respuesta a requests del bundle de Supabase, rompiendo el `import()` dinámico.
2. **Recovery automático demasiado agresivo** (`fylNuclearClearSwAndCaches` ⇒ `unregister()` del SW + reload) consumía el único slot de recuperación por sesión en el primer fallo transitorio (timeout de red), dejando un terminal `no_client` cuando un retry normal habría funcionado.
3. **Dynamic `import()` ESM del bundle Supabase** (`scripts/vendor/supabase-js.bundle.min.js`) dentro de **top-level await** encadenado:
   - `main-supabase.js` (TLA) → `supabase-client.js` (TLA × 2) → `loadCreateClient()` → `import(local, 60s)` → cae a 3 CDNs cross-origin (jsdelivr/unpkg/esm.sh, cada una 28s) → 144s totales antes de fallar.
   - Safari iOS bloquea o ralentiza CDNs cross-origin por **iCloud Private Relay** y **ITP**.
   - El grafo de modules con TLA encadenado a un `import()` que se cuelga = `main-supabase.js` nunca evalúa = catálogo no inicializa.
4. **Imports versionados parciales:** los archivos críticos (`fyl-version.js`, `fyl-runtime-resilience.js`) NO tenían `?v=` en sus imports estáticos internos, lo que dejaba que Safari sirviera versiones cacheadas como `immutable, max-age=1y` aún después de un deploy nuevo.
5. **Trackers bloqueados** (Meta Pixel, GTM, Microsoft Clarity) eran un FALSO positivo: Safari los bloquea pero no rompen el boot (todos los stubs son síncronos y seguros). Auditoría detallada confirmó aislamiento (sólo encolan en queue, sin red durante boot).

### Solución (5 cambios en cascada, todos vivos)

#### 1. Service Worker como **tombstone network-only** (`sw.js`)

- `activate`: borra **todos** los caches (`caches.keys()` + `caches.delete()`).
- `fetch`: solo intercepta GET/HEAD same-origin de **rutas críticas** (`/scripts/vendor/*`, `/config.prod.js`) y responde con `fetch(req, { cache: "no-store" })` (network-only, sin Cache API).
- `SW_BUILD_TAG = "<FYL_VERSION>"` (reescrito por `cache-bust-html.mjs`) garantiza byte-diff en cada deploy ⇒ Safari detecta nuevo SW y reemplaza legacy.

#### 2. Recovery **soft clear** vs **hard nuclear** separados (`scripts/fyl-runtime-resilience.js`)

- `fylClearCachesOnly()` — borra Cache API; **preserva** el SW en producción.
- `fylNuclearClearSwAndCaches()` — borra caches **y** desregistra SW; **solo** lo dispara el kill switch remoto (`fyl-flags.json` con `FORCE_RESET=true`).
- `ensureCatalogSupabaseHealthy()` queda **exportado pero NO se invoca en boot inicial**. Ya no se gatilla recovery automático por timeout transitorio.

#### 3. Bundle Supabase en **formato IIFE same-origin** (refactor estructural)

**Antes:** `--format=esm` cargado por `import()` dinámico desde `loadCreateClient()` con 4 reintentos (1 local + 3 CDNs cross-origin).

**Ahora:** `--format=iife --global-name=fylSupabase`, cargado como `<script defer src="scripts/vendor/supabase-js.bundle.min.js?v=<FYL_VERSION>">` antes de los `<script type="module">`. Expone `window.fylSupabase.createClient`. El módulo `supabase-client.js` lo lee de forma síncrona.

Eliminados de `scripts/supabase-client.js`: `loadCreateClient`, `importWithTimeout`, `tryImportSupabaseModule`, `probeBundleForDebug`, `fylBundleHeadLooksLikeHtml`, `fylBundleFetchAppearsHtml`, `fylScheduleReloadOnceAfterHtmlBundle`, `fylClearBundleHtmlRecoverFlag`, `SUPABASE_CDN_URLS`, `SUPABASE_LOCAL_BUNDLE`. **–58 % LoC** en el archivo, **0 dynamic imports** en boot crítico, **0 dependencias cross-origin**.

`scripts/cache-bust-html.mjs` ganó `ensureVendorSupabaseScript()` que inyecta de forma idempotente el `<script defer>` del bundle vendor antes del primer `<script type="module" src=".../supabase-client.js">` en cada HTML que lo necesite (catálogo + admin + client).

#### 4. Versionado **global** y **defensivo** (cache-bust)

- `app-version.json` → `FYL_VERSION` (única fuente).
- `scripts/cache-bust-html.mjs` reescribe **todos** los `?v=` en HTMLs **y** en JS críticos (`EXTRA_VERSIONED_FILES`: `main-supabase.js`, `supabase-client.js`, `config.js`, `boot-telemetry.js`, `fyl-runtime-resilience.js`).
- `scripts/fyl-version.js` exporta `FYL_VERSION` (también reescrito por `cache-bust`).
- Imports estáticos internos versionados (`./fyl-version.js?v=...`, `./fyl-runtime-resilience.js?v=...`) ⇒ Safari no puede servir caché viejo de archivos sin query.
- `firebase.json`:
  - `/index.html`, `/*.html`, `/client/**/*.html`, `/manifest.json`, `/sw.js` → `no-cache, no-store, must-revalidate`.
  - `/config.prod.js`, `/fyl-flags.json`, `scripts/config.js`, `scripts/boot-telemetry.js`, `scripts/fyl-version.js`, `scripts/fyl-runtime-resilience.js`, `scripts/config.local.js` → `no-cache`.
  - `scripts/vendor/supabase-js.bundle.min.js` → `must-revalidate, max-age=86400` (NO `immutable`) + `Content-Type: application/javascript`.

#### 5. Kill switch remoto (`fyl-flags.json`)

JSON estático servido con `no-cache`. `{ "FORCE_RESET": true, "rev": N }` dispara `fylNuclearClearSwAndCaches` + reload en todos los clientes (poll cada 120s + en `visibilitychange`). Permite arreglar producción sin redeploy. Una vez aplicado, volver a `false` con `rev` superior.

### Archivos (cambios principales)

- `scripts/supabase-client.js` — reescrito (–10 718 B, –58 %); `await configReady` queda como único TLA.
- `scripts/supabase-vendor-entry.js` — comentarios sobre IIFE.
- `scripts/vendor/supabase-js.bundle.min.js` — re-bundleado IIFE (~168 KB).
- `scripts/fyl-runtime-resilience.js` — soft/hard separados; kill switch + error reporting.
- `scripts/fyl-version.js` — única fuente de `FYL_VERSION`, reescrita en cada `cache-bust`.
- `scripts/cache-bust-html.mjs` — `ensureVendorSupabaseScript`, `patchFylVersionExport`, `patchServiceWorker` con `SW_BUILD_TAG`, `EXTRA_VERSIONED_FILES` ampliado.
- `scripts/main-supabase.js` — eliminada la llamada a `ensureCatalogSupabaseHealthy()` durante boot inicial; check de `supabase` directo.
- `scripts/config.js`, `scripts/boot-telemetry.js` — imports internos versionados (`?v=...`).
- `sw.js` — tombstone network-only + `SW_BUILD_TAG`.
- `index.html`, `catalogo.html`, `admin/*.html`, `client/*.html` — `<script defer src=".../scripts/vendor/supabase-js.bundle.min.js?v=...">` antes de cualquier module crítico (57 archivos inyectados por `cache-bust-html.mjs`).
- `firebase.json` — headers (no-cache HTML/críticos, must-revalidate bundle vendor).
- `package.json` — `bundle:supabase` con `--format=iife --global-name=fylSupabase`.
- `fyl-flags.json` — flags de runtime para kill switch (`FORCE_RESET`, `rev`).

### Cómo funciona ahora (boot crítico simplificado)

```
HTML (no-cache)
│
├─ <script src="/config.prod.js">                                       [clásico, sync]
│        └─ window.SUPABASE_URL, SUPABASE_ANON_KEY, __FYL_CONFIG_PROD_LOADED__
│
├─ <script defer src="scripts/vendor/supabase-js.bundle.min.js?v=...">  [clásico, defer same-origin]
│        └─ var fylSupabase = (() => { ... return { createClient }; })()
│        └─ window.fylSupabase.createClient queda listo ANTES que cualquier <script type="module">
│
├─ <script type="module" src="boot-telemetry.js?v=...">                 [defer]
├─ <script type="module" src="config.js?v=...">                         [defer; configReady IIFE no bloquea modules]
├─ <script type="module" src="supabase-client.js?v=...">                [defer]
│        ├─ await configReady                                           ← único TLA, resuelve en ms
│        ├─ getCreateClient() lee window.fylSupabase.createClient       ← SYNC
│        ├─ createClient(URL, KEY, opts)                                ← SYNC
│        └─ supabase queda exportado y en window.supabase
│
├─ <script type="module" src="analytics.js?v=...">
└─ <script type="module" src="main-supabase.js?v=...">                  [defer]
         └─ usa supabase ya inicializado; sin retries automáticos en boot
```

**Características clave del nuevo boot:**

- **0 dynamic imports** en la cadena crítica de Supabase.
- **0 CDNs cross-origin** (`jsdelivr`, `unpkg`, `esm.sh` ya no se usan).
- **1 solo TLA** en supabase-client (`await configReady`, IIFE local).
- **Bundle vendor** se descarga en paralelo con el HTML gracias a `defer`; está listo antes de los modules.
- **Safari iOS Private Relay/ITP** ya no impactan el boot (todo same-origin).
- Si por alguna razón el bundle vendor falla, `supabase-client.js` lanza `supabase_vendor_missing` con error claro, sin colgarse 144 s ni gastar slots de recovery.
- **Recovery automático eliminado en boot**: un timeout transitorio ya no genera un terminal `no_client`. El usuario ve el modal con hint y puede recargar manualmente o cambiar red.
- **Kill switch remoto disponible** para casos donde se necesite hard reset sin redeploy (`fyl-flags.json` con `FORCE_RESET=true`).

### Cómo verificar

1. **iPhone real (Safari) — feliz path:**
   - Abrir `https://<dominio>/?nocache=1`
   - DevTools (Mac → iPhone) → **Network**:
     - `index.html` 200 (sin from-cache), `Cache-Control: no-cache`
     - `scripts/vendor/supabase-js.bundle.min.js?v=<FYL_VERSION>` 200, `Content-Type: application/javascript`, ~168 KB
     - `config.prod.js` 200, `no-cache`
     - **Cero requests** a `cdn.jsdelivr.net`, `unpkg.com`, `esm.sh`
   - DevTools → **Storage → Service Workers**: una sola SW activa, scope `/`, script `sw.js?v=<FYL_VERSION>`.
   - **Console**:
     - sin warnings `[FYL supabase] [sw_cache_suspect] Bundle URL devuelve HTML`.
     - sin `[supabase_local_timeout]` ni `[supabase_cdn_*]`.
     - boot-telemetry stage `supabase.client.ready` con `source: "vendor-iife"`.
   - **UI**: catálogo carga normal en <2 s.

2. **iPhone real (Safari) — caso degradado intencional:**
   - Bloquear `scripts/vendor/supabase-js.bundle.min.js` desde DevTools.
   - Recargar.
   - Esperado: modal "no_client" inmediato (sin esperar 144 s); `markBootStage` → `supabase.client.failed` con `name: "Error", message: "supabase_vendor_missing"`.
   - Recargar manualmente con bundle desbloqueado: catálogo carga normal (slot de recovery intacto).

3. **Kill switch remoto (cuando haga falta):**
   - Editar `fyl-flags.json`: `{ "FORCE_RESET": true, "rev": <N+1> }`.
   - `firebase deploy --only hosting` (solo este archivo cambia).
   - Clientes detectan en <2 min: `fylNuclearClearSwAndCaches` + `location.reload()`.
   - Volver `FORCE_RESET=false` con `rev` superior cuando estén limpios.

### Riesgo futuro / cosas a recordar

- **Si `@supabase/supabase-js` cambia de major** y necesita override de IIFE: revisar `package.json` `bundle:supabase` y `scripts/supabase-vendor-entry.js`.
- **Imports sin `?v=` desde otros módulos**: 17 archivos importan `./supabase-client.js` SIN query. Esto NO rompe (existe deduplicación por `existingWindowClient`) pero duplica evaluación del módulo. Si en el futuro se quiere eliminar la duplicación: search & replace en bloque, no urgente.
- **`ensureCatalogSupabaseHealthy` y `fylNuclearClearSwAndCaches`** siguen exportados para uso manual desde panel de soporte. NO invocarlos automáticamente en boot.
- **`fyl-flags.json`**: tratar como infra crítica. Cambiar `rev` siempre al modificar `FORCE_RESET`.
- **Trackers** (Meta Pixel, GTM, Clarity): siguen diferidos hasta primera interacción / `fyl-catalog-boot-done` / 15 s. Si Safari los bloquea, NO afectan boot. Si en el futuro alguien agregue un tracker síncrono que sí use red en boot, ese sí podría romper Safari → mantener el patrón "stub sync, carga real diferida".
- **Refs cruzados**: ver [[11-DECISIONES-TECNICAS]] para el principio "boot crítico same-origin sin dynamic import" y [[09-RUNBOOK-OPERATIVO]] (si se documenta el procedimiento de kill switch).

---

## 2026-05-07 — Catálogo público (`catalogo.html`): FAB WhatsApp (`#wa-popup`) no abría al tocar

### Síntoma

- El botón flotante verde de WhatsApp parecía visible pero **no hacía nada** al pulsarlo (especialmente en móvil / Safari).
- En escritorio ancho, en algún momento el FAB estaba oculto por CSS (`styles-desktop.css`).

### Causa (auditoría)

1. **`scripts/whatsapp.js`** registraba `click` en `#wa-toggle` con **`stopPropagation()`** sobre un `<a href="https://wa.me/…">`. En **Safari iOS** eso puede interferir con la **navegación nativa** del enlace.
2. **Solapamiento táctil** con **`#btn-scroll-top`** (misma esquina inferior derecha en móvil): aunque el FAB tenía `z-index` mayor, el área útil del dedo a veces caía en el botón blanco.
3. **`whatsapp.js`** cargaba muy tarde vía **import dinámico** post-boot; el FAB ya era `<a>` con `href`, pero el JS redundante seguía siendo riesgo en otros navegadores.
4. Listener en **captura** en `scripts/catalogo-publico.js` sobre `document` — no interceptaba el FAB por selectores, pero se añadió **salida explícita** si el evento viene de `#wa-popup`.

### Solución

- **Catálogo público**: sin listeners JS en `#wa-toggle`; solo el `<a>` nativo. Lead Meta: listener **delegado** en `whatsapp.js` con `content_category: "public_catalog"` cuando `link.id === "wa-toggle"`.
- **`catalogo.html`**: `<script defer src="scripts/whatsapp.js">`; se quitó el import diferido tardío de ese archivo.
- **`styles.css`** (móvil ≤768px, `html.public-catalog`): `#wa-popup` con `z-index` más alto + `isolation`; `#btn-scroll-top.visible` desplazado para no tapar el FAB; `touch-action: manipulation` en `#wa-toggle`.
- **`catalogo-publico.js`**: `if (event.target.closest("#wa-popup")) return` al inicio del handler en captura.
- **`styles-desktop.css`**: el FAB en catálogo público ya no se oculta en desktop (solo ajuste de posición).

### Archivos

- `catalogo.html`
- `scripts/whatsapp.js`
- `scripts/catalogo-publico.js`
- `styles.css`
- `styles-desktop.css`

### Cómo verificar

- Abrir `catalogo.html` en iPhone/Safari y en Chrome Android: un toque en el FAB abre WhatsApp (mismo número que el botón del header).
- Con scroll largo (visible `#btn-scroll-top`): el FAB sigue respondiendo; el scroll-top no queda encima del FAB.

---

## 2026-05-04 — Producción: drift `reserved_qty` al marcar pedido enviado (migración 188)

### Síntoma

- Pedidos en **`sent`** (y otros finales excluidos por la vista 175) seguían con **`order_item_stock_sources.qty > 0`** mientras **`product_variants.reserved_qty`** no bajaba al dejar de contar en `real_reserved_qty`.
- Auditoría: **`reserved_qty_inflated`** («Stock disponible subestimado») y uso recurrente de **`rpc_reconcile_stock(true)`** como parche.

### Causa

Al pasar a estado final, la vista deja de sumar esas fuentes en `real_reserved_qty`, pero no existía ajuste automático de **`reserved_qty`** en la transición.

### Solución

Migración **188** (`supabase/canonical/188_order_reserved_qty_release_on_final_status.sql`): tabla **`order_reserved_qty_released`**, función **`release_reserved_qty_for_order`**, trigger **`trg_orders_release_reserved_qty_on_final_status`** en `orders` (solo **`reserved_qty`**; sin tocar stock físico ni borrar fuentes). Idempotencia por PK **`order_id`**.

Cierre histórico: **`rpc_reconcile_stock(true)` una sola vez** tras deploy; **sin** backfill masivo por pedidos.

### Archivos / SQL

- `supabase/canonical/188_order_reserved_qty_release_on_final_status.sql`
- `supabase/canonical/188_POST_DEPLOY_VERIFICATION.sql`
- `supabase/canonical/188_STAGING_TEST_PLAN_order_reserved_release.md` (pruebas previas)

### Cómo verificar

Ver [[06-RESERVED-QTY-Y-RECONCILE]] §188 y ejecutar queries de `188_POST_DEPLOY_VERIFICATION.sql` (objetos, trigger `tgenabled = O`, prueba `closed` → `sent`, KPI infladas).

---

## 2026-05-04 — products.js: tags de categoría incorrecta al cargar producto existente

### Síntoma

Al buscar y cargar un producto de categoría **Ropa** en `admin/products.html`:
- El selector Tag1 mostraba tags de **Calzado** en lugar de Ropa.
- Los tags ya guardados no aparecían seleccionados (selectores en blanco).
- El panel "Detalles" cargaba Tags3 de la categoría equivocada.

### Causa

En `loadProductById`, el campo `#category` del DOM se actualizaba **después** de llamar a `renderTags1()`, `renderTags2()`, `renderTags3()` y `renderDetailsList()`. Todas esas funciones llaman a `getProductCategory()` que lee el DOM en tiempo real → devolvía la categoría anterior (generalmente "Calzado").

```js
// ANTES (orden incorrecto):
selectedTag1Id = pt.tag1_id;
await renderTags1();                    // ← lee DOM: "Calzado" ❌
await renderDetailsList();              // ← idem ❌
// ...
document.getElementById("category").value = prod.category;  // tarde
```

### Solución

Mover `document.getElementById("category").value = prod.category` al inicio del bloque, antes de cualquier render de tags.

### Archivos

- `admin/products.js`

### Cómo verificar

Cargar un producto con categoría Ropa → Tag1 muestra opciones de Ropa → tag guardado aparece seleccionado → panel Detalles muestra Tags3 de Ropa.

---

## 2026-05-04 — products.js: crear Tag1 no habilita Tag2 inmediatamente

### Síntoma

Al crear un Tag1 nuevo desde el input de `admin/products.html`, el selector Tag2 permanecía deshabilitado ("Primero selecciona Tags1"). El usuario tenía que deseleccionar y volver a elegir Tag1 para activar Tag2.

### Causa

El handler `tag1Create` llamaba solo `renderTags1()` tras crear el tag, pero no `renderTags2()` ni `renderTags3()`. El estado `selectedTag1Id` sí se actualizaba, pero los selectores dependientes no se refrescaban.

### Solución

Agregar `await renderTags2(); await renderTags3();` después de `await renderTags1()` en el handler `tag1Create`.

### Archivos

- `admin/products.js`

### Cómo verificar

Crear un Tag1 nuevo → Tag2 se habilita inmediatamente sin intervención adicional del usuario.

---

## 2026-05-04 — products.js: autocompletado de nombre en categoría Ropa

### Síntoma

Al seleccionar categoría **Ropa** en `admin/products.html`:
- Si el nombre estaba vacío, se auto-rellenaba con `R{número}` (ej. `R142`).
- Si el nombre no empezaba con `R\d`, se anteponía `"R"` automáticamente.
- Comportamiento no práctico para carga real de productos.

### Causa

La función `updateNamePrefix()` ejecutaba esta lógica para Ropa disparada por el evento `category.change`.

### Solución

`updateNamePrefix()` retorna inmediatamente para categoría Ropa (`return` early). La lógica de limpieza para otras categorías (quitar prefijo `R\d` si se cambia desde Ropa) permanece intacta.

### Archivos

- `admin/products.js`

### Cómo verificar

- Seleccionar Ropa → campo nombre queda vacío, sin auto-rellenar.
- Cambiar a Calzado → si el nombre tenía prefijo `R\d`, se limpia.

---

## 2026-05-04 — complete-tags: producto queda en `missing_tags` para siempre

### Síntoma

Al guardar tags en `admin/complete-tags.html`, el mensaje decía "El estado del producto se actualizará automáticamente", pero el producto permanecía con `status = 'missing_tags'` indefinidamente y nunca aparecía en el catálogo.

### Causa

No existía ningún trigger DB que realizara la transición `missing_tags → active` al guardar en `product_tags` o `product_tag_details`. Confirmado con:

```sql
SELECT trigger_name, event_object_table
FROM information_schema.triggers
WHERE trigger_schema = 'public'
  AND (trigger_name ILIKE '%missing_tags%' OR trigger_name ILIKE '%product_status%');
-- Resultado: Success. No rows returned
```

### Solución aplicada

En `admin/complete-tags.js`, tras guardar exitosamente tags y details, se ejecuta explícitamente:

```js
await supabase.from("products").update({ status: "active" }).eq("id", currentProductId)
```

Si el update falla, se muestra aviso visible en lugar de silenciarlo. El mensaje de éxito ya no dice "automáticamente".

### Archivos

- `admin/complete-tags.js`

### Cómo verificar

1. Tomar un producto con `status = 'missing_tags'`.
2. Completar Tags1, Tags2 y al menos un detalle. Guardar.
3. Verificar en Supabase: `SELECT status FROM products WHERE id = '<id>'` → debe ser `active`.
4. El producto debe desaparecer de la lista en `complete-tags.html`.

---

## 2026-05-04 — complete-tags: errores de carga silenciosos en pantalla

### Síntoma

Si la query a Supabase fallaba al cargar productos `missing_tags` (error de red, RLS, etc.), no se mostraba nada en pantalla. `showStatus()` era una función vacía que solo hacía `console.log`.

### Causa

`showStatus` tenía implementación intencionalmente pendiente:
```js
function showStatus(message, type = "info") {
  // Esta función se puede implementar si se necesita...
  console.log(`[${type}] ${message}`);
}
```

### Solución aplicada

`showStatus` con `type === "error"` ahora inyecta un bloque rojo visible en el `productsContainer` además de logguear en consola.

### Archivos

- `admin/complete-tags.js`

---

## 2026-05-04 — stock-audit: links del card O2 no diferenciaban por estado

### Síntoma

El card "Altas de producto pendientes" en `admin/stock-audit.html` mostraba dos links genéricos en el footer ("Alta incompleta" y "Tags"), independientemente del `status` de cada producto. Un producto `pending_stock` podía enviarse a `complete-tags.html` y viceversa.

### Causa

El footer era estático; no usaba el campo `status` de cada producto para determinar el destino.

### Solución aplicada

Se agregó `getLinkForStatus(status)` en `admin/stock-audit.js`. Cada fila del card muestra ahora un link "Completar →" que apunta a:

| `status` | Destino |
|---|---|
| `pending_stock` | `incomplete-products.html` |
| `missing_tags` | `complete-tags.html` |
| `draft` | `products.html` |

### Archivos

- `admin/stock-audit.js`

---

## 2026-05-04 — incomplete-products: categoría "Otros" ignorada + sin estado vacío

### Síntoma

Productos con categorías distintas de "Calzado" o "Ropa" (ej. accesorios) con `status = 'pending_stock'` no aparecían en `admin/incomplete-products.html`. Además, si no había ningún producto pendiente, la pantalla quedaba en blanco sin ningún mensaje.

### Causa

`refreshProducts()` solo filtraba `Calzado` y `Ropa`. No había container HTML para otras categorías ni manejo del array vacío total.

### Solución aplicada

- Agregada sección `<section id="others-section">` con `#others-container` en el HTML (oculta por defecto; visible solo si hay productos).
- `refreshProducts()` ahora filtra también `others` y los renderiza.
- Si `incompleteProducts.length === 0`, se muestra "✅ No hay productos pendientes de stock."

### Archivos

- `admin/incomplete-products.html`
- `admin/incomplete-products.js`

---

## 2026-04-29 — Orders admin: stock insuficiente al fusionar 2 unidades del mismo SKU

### Sintoma

Al cargar o editar pedido en admin, podia aparecer:

- `rpc_apply_order_stock_deduction: stock insuficiente ... disponible=1, solicitado=2`

incluso cuando el stock total del SKU parecia suficiente entre depositos.

### Causa

- La linea fusionada acumulaba `qty_from_venta`/`qty_from_general` por suma historica en lugar de recalcular split por deposito segun cantidad total.
- Caso tipico: stock partido (`venta=1`, `general=1`) y dos altas priorizando venta terminaban como `qty_from_venta=2`, lo que fuerza a la RPC a descontar 2 en un solo `warehouse_id`.

### Solucion aplicada (en codigo)

- Se agrego `computeWarehouseQtySplitForOrderItem(quantity, stockGeneral, stockVenta)` en `admin/order-creator.js`.
- En `addProductToOrder`, al obtener stock por talle en `variant_size_warehouse_stock`, se guarda snapshot para split (`fetchedStockForSplit`).
- Al fusionar lineas iguales:
  - si hay snapshot de stock, ya no se suman ciegamente `qty_from_general` y `qty_from_venta`;
  - se recalcula el split final del item afectado segun su `quantity` total y stock por deposito.
- Se mantiene fallback previo (suma original) si falla la lectura de stock.

### Archivos tocados (referencia)

- `admin/order-creator.js`

### Como verificar

- Preparar un SKU con stock partido (ejemplo: `venta=1`, `general=1`) para el mismo talle.
- Agregar 2 unidades del mismo SKU en admin (incluyendo caso de fusion de linea).
- Verificar en consola que el item final quede con split `1+1` (no `2+0` todo en venta).
- Guardar pedido y confirmar que no aparece el error `stock insuficiente ... solicitado=2` para un solo deposito.

---

## 2024–2025 (aprox.) — Stock insuficiente en admin por split inconsistente

### Síntoma

Al confirmar un pedido admin, el descuento de stock fallaba o no aplicaba correctamente si las cantidades `qty_from_general` + `qty_from_venta` no coincidían con `quantity`, o luego de un “reset” del split (comportamiento relato en comentarios de `admin/order-creator.js`).

### Causa

- Un **fallback** previo reasignaba toda la cantidad a un depósito de forma que la validación de `rpc_apply_order_stock_deduction` no coincidía con el stock real por almacén.  
- Código explícito: comentario en `itemQualifiesForApplyOrderStockDeduction` que menciona *“bug del fallback que pedía toda la venta a un depósito”* (paráfrasis).

### Solución aplicada (en código)

- Criterio estricto: `g + v === q` (general + venta = cantidad) y excluir `status === "missing"` y `admin_confirmed_missing` del camino de `rpc_apply_order_stock_deduction`. Construcción de `deductions` **solo** desde `qty_from_general` y `qty_from_venta` alineados. Ver `itemQualifiesForApplyOrderStockDeduction` y `updateStockBatch` en `admin/order-creator.js`.

### Archivos tocados (referencia)

- `admin/order-creator.js` (lógica de `updateStockBatch` / `itemQualifiesForApplyOrderStockDeduction`).

### Riesgo futuro

- Cualquier cambio que reintroduzca fallback a un solo depósito o permita `g+v≠quantity` reabre el fallo.  
- Integraciones que inserten `order_items` sin respetar el split.

### Cómo verificar

- Casos con cantidad partida entre general y venta pública; forzar `g+v` ≠ `quantity` y constatar que el ítem **no** pasa a deducción automática (logs `console` en el mismo flujo).  
- Pedidos puramente con `admin_confirmed_missing` deben ir por `rpc_admin_manual_inject_and_deduct`, no por `apply_order_stock_deduction`.

---

## 2024–2025 (aprox.) — Fallback que reasignaba cantidades a depósito

### Síntoma

Relacionado con el bug anterior: descuentos o mensajes de stock incorrectos al enviar toda la cantidad a un almacén.

### Causa

- Asignación automática a un depósito único (detalle en comentarios alrededor de `itemQualifiesForApplyOrderStockDeduction` y del bloque “sin fallback” en `updateStockBatch`).

### Solución

- Misma lógica estricta de split; eliminado el reintento a un solo almacén (según comentarios y ausencia de fallback en el bloque auditado de `updateStockBatch`).

### Archivos

- `admin/order-creator.js`

### Riesgo futuro

- Copiar/pegat flujos de otra rama o de documentación desactualizada.  
- Modificar `updateStockBatch` sin tests con dos depósitos.

### Cómo verificar

- Pruebas manuales con `console.table` de `itemsForStockDeduction` y `itemsSkippedFromStockDeduction` (ya loguea el script).  
- Límites: stock 1 en general, 0 en venta y viceversa.

---

## 2024–2025 (aprox.) — Campos de costo visibles a colaboradores

### Síntoma

Quien no debería ver costo/margen/logístico accedía a esos campos o veían prefilled.

### Causa

- Faltante de gating estricto por **rol `super_admin`** a nivel de UI (frente a solo `products: can_edit`).

### Solución

- Uso de `isSuperAdmin()` y control de `disabled`/vacío de inputs para no volcar `cost`/`logistic` al DOM para colaboradores. Ver `admin/products.js` (líneas de comentario y carga cerca de “Populate pricing fields (solo super_admin)…”).

### Archivos

- `admin/products.js`  
- `admin/permissions-helper.js` (`isSuperAdmin`)

### Riesgo futuro

- Añadir nuevos formularios de producto que expongan costos sin `isSuperAdmin()`.  
- RLS/BD: la documentación de este repo no audita en profundidad políticas; **DUDOSO** a nivel de DB.

### Cómo verificar

- Probar con usuario colaborador: campos de costo vacíos o deshabilitados; con `super_admin`, visibles.  
- Revisar `console` por advertencias al resolver `isSuperAdmin()`.

---

## 2026-04 (aprox.) — Checkout falla: item sin variante asociada (`variant_id` null)

### Sintoma

Al hacer pedido desde el dashboard, `rpc_checkout_cart` devuelve un error cuyo mensaje indica que el item (UUID) no tiene variante asociada (ver texto exacto en `10_checkout_flow.sql` / RPC).

### Causa

- Filas en `public.cart_items` con **`variant_id` NULL** (merge desde `localStorage`, consolidacion de duplicados, sync previo, o legacy).
- La RPC itera `cart_items` y exige variante; ver flujo en `supabase/canonical/10_checkout_flow.sql` y cuerpo en `124_*`.

### Solucion aplicada (en codigo)

- `syncCartWithSupabase`: resolver variante con `fetchVariantInfo`; **no** persistir lineas sin `variant_id` resuelto.
- `repairCartItemsMissingVariantIds` al cargar carrito en dashboard.
- `cleanupDuplicateCartItems`: no insertar duplicado sin variante.
- `submitCurrentCart`: validacion previa y mensaje amigable; manejo de error RPC.

### Archivos (referencia)

- `scripts/cart-persistent.js`, `client/dashboard-instant.js`

### Riesgo futuro

- Cualquier nuevo camino que escriba `cart_items` sin `variant_id` reabre el fallo.  
- Documentacion o SQL de diagnostico que asuman columna `sku` en `cart_items` (no existe en el esquema actual).

### Como verificar

- Consulta `select ... from cart_items where variant_id is null`.  
- Flujo: agregar con sesion, duplicar lineas, merge post-login, checkout.

**Nota de contexto ampliada:** [[21-CONTEXTO-AGENTE-HARDENING-2026-04]].

---

## 2026-04 (aprox.) — Index: loader y texto “Cargando destacados…” mal posicionado / persistente

### Sintoma

En mobile u orden de carga, el area superior (F&L, banners) “salta” o queda un loader/etiqueta de carga visible de forma confusa.

### Causa

- Layout sin reserva de altura en el bloque superior; uso del loader global bajo filtros en lugar de estado local al slot; overlay de boot vs carga de extras de home desalineados.

### Solucion aplicada (en codigo y CSS)

- Contenedor `#home-top-dynamic-slot` con clases de estado, `min-height` y `syncHomeTopSlotState` en `scripts/main-supabase.js`.  
- Loader local `#home-top-dynamic-loader` con atributo `hidden` y reglas en `styles.css` para no dejar texto visible al terminar.

### Archivos (referencia)

- `index.html`, `styles.css`, `scripts/main-supabase.js`

**Nota de contexto ampliada:** [[21-CONTEXTO-AGENTE-HARDENING-2026-04]] (seccion 3.2).

---

## Enlaces

- [[11-DECISIONES-TECNICAS]] · [[12-CHECKLIST-CAMBIOS-FUTUROS]] · [[99-AUDITORIA-DOCUMENTACION]] · [[21-CONTEXTO-AGENTE-HARDENING-2026-04]]

## VALIDACIÓN

- ✔ **Confirmado por código:** entradas de split y costos contrastadas con `admin/order-creator.js` y `admin/products.js` (comentarios y lógica presentes).  
- ⚠️ **Dudoso:** fechas “2024–2025 (aprox.)” no verificadas contra `git log`.  
- ❌ No aplica marcar como incorrectas las historias de bug; **sí** hubo **error de documentación en otra nota** sobre `admin_confirmed_missing` (corregido en [[04-FLUJO-STOCK]] y [[05-FLUJO-PEDIDOS]], no en las entradas históricas de este archivo).
