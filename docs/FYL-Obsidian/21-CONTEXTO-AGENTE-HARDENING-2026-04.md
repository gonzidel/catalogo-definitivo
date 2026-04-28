# 21 — Contexto para agentes: hardening UX/red, auth y carrito (2026-04)

Esta nota consolida **trabajo real** hecho en el repo (no un plan teórico) para que otro agente pueda **depurar, extender o corregir** sin re-auditar desde cero.

**Regla:** si algo aquí contradice el código actual, **manda el código** y actualizá esta nota.

---

## 1. Mapa rápido “qué tocar para qué”

| Tema | Archivos / SQL clave |
|------|----------------------|
| Overlay global catálogo (`#catalog-boot-overlay`), first usable paint | `scripts/main-supabase.js` — `hideCatalogBootOverlay`, `catalogScope`, `releaseBootOverlayOnFirstPaint`, `CATALOG_BOOT_MIN_VISIBLE_MS` |
| Capa “pantalla usable” | `scripts/net/screen-scope.js` — `createScreenScope` |
| Red: errores, abort, Supabase wrap | `scripts/net/fyl-fetch.js` — `wrapSupabase`, `classifyError`, `createAbortScope` |
| Auth/permisos admin cache | `admin/auth-state.js` — `preloadAuthState`, `can`, `invalidate` |
| Permisos internos (bulk) | `admin/permissions-helper.js` — usado por auth-state; no listar aquí todos los cambios |
| PDP modal skeleton + abort | `scripts/main-supabase.js` — `pdpFetchAbortScope`, `_abrirModalConSkeleton`, `abrirPdpPorSkuIfPossible`, fast-path abort en `abrirModalPorSKU` / `abrirModalConResultado` |
| **Top del index: layout + loader local** | `index.html` — `#home-top-dynamic-slot`, `#home-top-dynamic-loader`; `styles.css` — clases `home-top-dynamic-*`; `scripts/main-supabase.js` — `syncHomeTopSlotState` |
| Carrito + checkout cliente | `scripts/cart-persistent.js` — `addToCart`, `ensureCartItemInDatabase`, **`syncCartWithSupabase`**; `client/dashboard-instant.js` — `loadCart`, **`repairCartItemsMissingVariantIds`**, `cleanupDuplicateCartItems`, `submitCurrentCart`, RPC `rpc_checkout_cart` |
| RPC checkout (exige `variant_id`) | `supabase/canonical/10_checkout_flow.sql` (y delegaciones vía `124_*`, wrapper `174_rpc_checkout_cart_strong_idempotency.sql`) |

---

## 2. Fases de hardening (resumen ejecutivo)

Se avanzó por fases en el mismo hilo de trabajo; el código mezcla mejoras en varios módulos. Las subsecciones **2.3** y **2.4** amplían las Fases 3 y 4 (auth centralizado y patrones por pantalla).

### 2.1 Fase 1 — UX de carga / gates admin

- Objetivo: la UI **no quede bloqueada** por loaders, redirects fantasma o timeouts duros de auth “visual”.
- Ejemplos documentados en conversación: `admin/stock.html` + `admin/stock.js` — `skipPanelRedirect`, `requireAuthWithTimeout` sin `Promise.race` duro, permisos sin redirect por error de red transitorio.
- Varios `admin/*.html` recibieron `window.skipPanelRedirect = true` donde aplica (orders, customers, products, publications, etc.).

### 2.2 Fase 2 — Infra común

- **`createScreenScope`** (`scripts/net/screen-scope.js`): `markFirstPaint`, `markReady`, eventos, idempotencia.
- **`fyl-fetch.js`**: `wrapSupabase`, clasificación `FYL_ERROR_KIND`, abort, retries en lecturas donde se acordó.
- Integración gradual: catálogo overlay, `admin/orders.js`, `admin/customers.js`, `admin/stock.js`, **PDP** (skeleton-first + abort).

### 2.3 Fase 3 — `auth-state.js` (sesión local + permisos en bulk)

**Archivo:** `admin/auth-state.js` (el bloque de comentarios iniciales describe el diseño; conviene leerlo antes de tocar permisos).

**Problemas que intenta eliminar (resumen del propio módulo):**

- Varios `getUser()` (red) por pantalla → sustituido por **sesión local** vía `getSession()`.
- N llamadas dispersas a permisos → **carga bulk** reutilizable.
- **Single-flight:** dos inits simultáneos comparten la misma `Promise` (usuario y permisos por separado).
- Sin caché de `user` coherente → caché en memoria hasta `invalidate` o cierre de sesión.

**API que debe conocer un agente:**

| Export | Rol |
|--------|-----|
| `getSessionUser()` | Primera carga de usuario; caché; evita `getUser()` en cada interacción. |
| `getAdminPermissions()` | Carga bulk de permisos (delega en `permissions-helper`); caché; single-flight. |
| `preloadAuthState()` | `Promise.all([getSessionUser(), getAdminPermissions()])` — **usar al inicio del módulo** antes de `can()`. |
| `can(permissionKey, action)` | **Síncrono**; lee caché. Si se llama con caché de permisos aún `null`, devuelve `false` y emite **un** `console.warn` por carga. |
| `isAuthStateReady()` | `true` cuando ya se resolvió `getAdminPermissions()` (aunque el mapa quede vacío por error). |
| `isAdminUser()` | Tras preload: si hay al menos un módulo con permisos. |
| `invalidate()` | Limpia usuario, permisos, promises en vuelo y flags; llama `clearPermissionsCache()` del helper. |
| `refreshAuthState()` | `invalidate()` + `preloadAuthState()` (misma sesión, refresco explícito). |

**Invalidación automática:** `supabase.auth.onAuthStateChange` con `SIGNED_OUT`, `SIGNED_IN`, `TOKEN_REFRESHED`, `USER_UPDATED` → `invalidate()`.

**Llamadas manuales a `invalidate`:** `admin/admin-auth.js` importa `invalidate`; buscar `invalidate(` en ese archivo (flujos de login/logout/cambio de contexto).

**Módulos admin que importan `auth-state` (útil al depurar "permiso negado falso"):**  
`customers.js`, `import-customers.js`, `import-export.js`, `stock-audit.js`, `proveedores.js`, `stock.js`, `orders.js`, `collaborators.js`, `compras-proveedores.js`, `fyl-products.js`, `publications.js`, `products.js`.  
`admin-auth.js` solo importa `invalidate`.

**Trampa:** nunca asumir `can(...)` fiable **sin** `await preloadAuthState()` en el init de la pantalla (también §6).

### 2.4 Fase 4 — Tareas con etiqueta, gates de auth y acciones en vuelo

Objetivo: **un estilo** para envolver handlers async (log con prefijo de módulo, errores con manejo explícito) y, donde aplica, **verificar auth** antes de mutaciones o de abrir paneles.

**Patrón `run*Task(label, task)`:**
- Varios archivos: `runOrdersTask`, `runStockTask`, `runPublicationsTask`, `runProveedoresTask`, `runComprasTask`, `runCollaboratorsTask`, `runProductsTask` (este admite tercer arg `onError` opcional).
- Típicamente: `Promise.resolve().then(task).catch(...)` con `console.error` que incluye el prefijo del módulo y el `label` del fallo; en **publications** y **products** el catch puede mostrar `showMessage` o callback.
- Algunas pantallas usan **sets** de claves en vuelo (ej. `orders.js` → `_ordersUiActionInFlight`, `stock.js` → `_stockUiActionInFlight`, `collaborators.js` → `_collaboratorActionInFlight`, `products.js` → `_variantImageOpsInFlight`).

**Patrón `ensure*Auth()` (async, boolean):**
- `ensureComprasAuth`, `ensureProveedoresAuth`, `ensurePublicationsAuth`, `ensureCollaboratorsAccess` (collaborators): suelen basarse en `preloadAuthState()` y reglas extra (en collaborators, después `isSuperAdmin()` al iniciar la página).
- `publications.js` tiene además un **gate al cargar** (IIFE con promesa de auth / redirect) antes de las tareas; revisar inicio de archivo al cambiar el flujo de entrada.

| Archivo | Wrapper | Gate / notas |
|---------|---------|----------------|
| `admin/orders.js` | `runOrdersTask` | `preloadAuthState` + `can` en carga; `createScreenScope`, `createAbortScope`. |
| `admin/stock.js` | `runStockTask` | Búsqueda con abort scope; watchdog de carga. |
| `admin/publications.js` | `runPublicationsTask` | `ensurePublicationsAuth` + IIFE inicial. |
| `admin/proveedores.js` | `runProveedoresTask` | `ensureProveedoresAuth`. |
| `admin/compras-proveedores.js` | `runComprasTask` | `ensureComprasAuth`. |
| `admin/collaborators.js` | `runCollaboratorsTask` | `ensureCollaboratorsAccess` + super admin. |
| `admin/products.js` | `runProductsTask` | Tercer parámetro `onError` opcional. |

Fase 4 no es un framework: es **convención por archivo**. Al añadir una pantalla admin compleja, copiar el patrón del módulo más parecido (p. ej. proveedores/compras). Para localizar: buscar en cada archivo el nombre de la función `run*Task` o `ensure*Auth`.

---

## 3. Catálogo público (`index.html` / `main-supabase.js`)

### 3.1 Overlay global

- Sigue el patrón **“first chunk usable”**: `releaseBootOverlayOnFirstPaint` / `catalogScope.markFirstPaint` cuando hay primer bloque de productos (o categoría vacía / error con mensaje usable).
- Hay un **mínimo de visibilidad** del overlay (`CATALOG_BOOT_MIN_VISIBLE_MS`, orden ~380 ms) para evitar parpadeo; **no** sustituye a “cargar todo”.

### 3.2 Top dinámico (F&L Originals, promo, info compra mínima)

- **Problema resuelto:** layout shift y loader mal ubicado.
- **Estructura:** contenedor `#home-top-dynamic-slot` agrupa:
  - `#fyl-originals-banner`
  - `#info-banner-top-container` (compra mínima / guía)
  - `#promotional-banner-container`
- **Reserva de altura:** clase `home-top-dynamic-slot--pending` + `min-height` en CSS (valores en `styles.css`; ~220px desktop, ~196px en viewport ≤480px).
- **Estado JS:** `syncHomeTopSlotState({ pending })` en `main-supabase.js` alrededor de extras de home (`runHomeExtras`, boot FYL, etc.). Cuando `pending: false`, se quita la clase; el loader local usa atributo **`hidden`** y CSS `#home-top-dynamic-loader[hidden]` para **no dejar texto “Cargando destacados...”** visible en mobile.
- **Importante:** el loader **global** `#loader` (bloque bajo filtros en HTML) en categoría `all` **no** debe mostrarse como sustituto del top — el patrón acordado fue **loader local al slot** + no forzar el overlay viejo.

### 3.3 Imágenes “above the fold”

- En el primer chunk de cards, imágenes con `loading="eager"` y `fetchpriority="high"` (primeras ~4) para reducir sensación de “a medio cargar” (detalle en `renderizarProductosPagina`).

### 3.4 PDP

- Apertura **skeleton-first**; `wrapSupabase` en fetches; **abort** al cerrar modal o abrir otro SKU; reintento con debounce; fast-path hace **abort** del slow-path.

---

## 4. Carrito y checkout (bug `variant_id` null)

### 4.1 Regla de negocio en DB

- En el flujo canónico de checkout (p. ej. `10_checkout_flow.sql`, bucle sobre `cart_items`), si **`variant_id` IS NULL** se lanza:
  - `El item <uuid> no tiene variante asociada.`
- Cualquier fila en `cart_items` sin `variant_id` **válido** rompe el checkout.

### 4.2 Causas que vimos en código

1. **`syncCartWithSupabase`** (antes del fix): insertaba/actualizaba con `variant_id: null` si el ítem local (p. ej. merge post-login desde `localStorage` **sin** `variant_id`) no lo tenía.
2. **`cleanupDuplicateCartItems`** en `dashboard-instant.js`: al consolidar duplicados, un `insert` podía llevar `primary.variant_id || null`.
3. Filas **legacy** ya persistidas en Supabase.

**Nota:** `cart_items` **no** tiene columna `sku` en el esquema actual — diagnóstico SQL sin usar `sku` en el `SELECT`.

### 4.3 Fix mínimo aplicado (lógica de producto, no tocar stock ni RPC de dominio)

| Ubicación | Comportamiento |
|-----------|------------------|
| `syncCartWithSupabase` | Si falta `variant_id`, intenta `fetchVariantInfo(..., { forceFresh: true })`; si no hay `id`, **omite** esa línea (no escribe null). |
| `repairCartItemsMissingVariantIds` (dashboard) | Tras leer `cart_items`, hace `UPDATE` de `variant_id` cuando `fetchVariantInfo` resuelve. |
| `cleanupDuplicateCartItems` | Resuelve variante antes del `insert` consolidado; si no hay variante, **no** inserta fila rota. |
| `submitCurrentCart` | Si queda algún ítem sin `variant_id`, **alert** amigable y no llama RPC. |
| Manejo error RPC | Mensaje comprensible si el texto contiene `no tiene variante asociada`. |

### 4.4 SQL de diagnóstico (válido sin columna `sku`)

```sql
select id, cart_id, variant_id, product_name, color, size, quantity, created_at
from public.cart_items
where variant_id is null
order by created_at desc
limit 200;
```

### 4.5 Cómo probar (agente)

- Carrito normal: añadir con sesión desde catálogo → dashboard → Hacer pedido.
- Legacy reparable: fila con `variant_id` null pero producto/talle aún resolvible → recargar dashboard (reparación) → pedido.
- Legacy no reparable: debe bloquearse con mensaje y/o error RPC mapeado; usuario debe **eliminar** la línea.

---

## 5. Archivos nuevos o muy citados (infra)

- `scripts/net/screen-scope.js`
- `scripts/net/fyl-fetch.js`
- `admin/auth-state.js`

---

## 6. Errores o trampas a no repetir

1. **`can()` antes de `preloadAuthState()`** — puede dar falsos negativos; siempre precargar en el init del módulo.
2. **Confundir** mensaje “conexión lenta” del **admin stock** (timeout **solo informativo**, sin abortar `requireAuth`) con el **overlay del index** (criterio first paint del catálogo).
3. **Asumir** que `cart_items` tiene `sku` — en SQL del dashboard del usuario falló; usar `product_name`, `color`, `size`, `variant_id`.
4. **Query por id** de item que ya no existe: puede ser otra base, o fila borrada/post-checkout; contrastar con `variant_id is null` global.
5. **Documentación 19** original: era auditoría **solo lectura**; los **fixes de variant_id** y sync son **posteriores** — ver sección añadida en [[19-AUDITORIA-MODULO-CLIENTE-CARRITO]].

---

## 7. Enlaces Obsidian

- [[00-INICIO]]
- [[06-FLUJO-CATALOGO]]
- [[19-AUDITORIA-MODULO-CLIENTE-CARRITO]]
- [[10-BUGS-RESUELTOS]]
- [[11-DECISIONES-TECNICAS]]
- [[12-CHECKLIST-CAMBIOS-FUTUROS]]
- [[03-MAPA-DE-RPCS]]
- [[05-FLUJO-PEDIDOS]]

---

## 8. Changelog de esta nota

| Fecha | Qué |
|-------|-----|
| 2026-04-22 | Creación: contexto de sesión hardening + index top + carrito `variant_id` + referencias a archivos. |
| 2026-04-22 | Sección 2.3 y 2.4: documentación ampliada de Fases 3 (`auth-state`) y 4 (`run*Task` / `ensure*Auth`, tabla por módulo). |
