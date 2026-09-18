# 58 — Pre-launch NJ / plan de cutover — 2026-09-04

> Auditoría previa del 2026-09-04. **Fuente de verdad de lo hecho después:** [[59-NJ-CHECKOUT-IDEMPOTENCY-ROOT-PREP-2026-09-04]]. Varias secciones de abajo (basePath local, UUID por click, “no hay cuenta test”, “no se crearon pedidos 309”) quedaron stale.

Preparación para que `nj/` sea el frontend público. **Cutover no ejecutado.**

No se tocó: 330/331/332/333C, `reserved_qty`, `cart_items` cleanup, `catalogo1/`, vanilla, ColorHex. 309 se **probó** en cuenta controlada (ver 59); no se modificó el SQL.

---

## A. Build

`typescript.ignoreBuildErrors` **eliminado**. `npx tsc --noEmit` y `next build` (sin TLS bypass) = **PASS**.

| Clase | Errores (33) | Acción |
|---|---|---|
| Typing | `AdminOrder` sin `payment_method`; `notes` optional vs null; implicit any; Phase5 `code`; remittance fallback types; regex `/s` vs target ES2017 | Corregidos (mínimo) |
| Deuda / dead code | ramas `column === "waiting"` dentro de `!isWaitingColumn` | Eliminadas (inalcanzables) |
| Blocker webpack | `next/font/google` en admin products (cert Windows) | Reemplazado por CSS vars / Poppins ya cargado |
| Seguridad launch | `/admin` sin check staff | `getAdminContext()` en `app/admin/layout.tsx` |

No se reactivó `ignoreBuildErrors`.

---

## B. BasePath

**URL definitiva acordada (no aplicada):**

```
/  /calzado /ropa /lenceria /marroquineria /ofertas
/producto/:sku  /tags/...  /coleccion/:slug  /banner/:slug
/como-comprar  /quienes-somos
/login  /auth/callback  /dashboard  /admin/**
/api/catalog/**
```

`basePath: "/nj"` **sigue en el deploy live** (`nj-gonzidel`). En **código local** ya se quitó (rewrites `/nj` → raíz). Ver [[59-NJ-CHECKOUT-IDEMPOTENCY-ROOT-PREP-2026-09-04]] §3. No desplegar hasta el día D.

| Tipo | ¿Rompe al quitar `/nj`? | Ejemplos |
|---|---|---|
| `Link` / `router.push` / `redirect()` sin `/nj` | No | Header, categorías, PDP, dashboard |
| `middleware` matcher | No | `/dashboard`, `/admin`, `/login` |
| Cookies Path | No | default `/` |
| Auth callback hardcode | **Sí** | `LoginClient.tsx`, `auth/callback/route.ts` |
| Assets `<img src="/nj/...">` | **Sí** | logo, favicon, onboarding, icons |
| `fetch("/nj/api/...")` | **Sí** | CategoryTabs |
| `<a href="/nj/...">` | **Sí** | ActiveOrderTab |
| SQL/WA `p_dashboard_url` | **Sí** (mensajes nuevos) | 305/307/314–317/322 |
| Infra Vercel | **Sí** | `catalogo1/vercel.json` rewrite `/nj` + `/` → `/catalogo` |

Estrategia: `nj/lib/constants/app.ts` con `BASE_PATH = ""` (como catalogo1) + reemplazar hardcodes el día D.

---

## C. Auth / cookies

- Login: **solo Google OAuth** + PKCE. No hay signup ni magic link (doc desactualizada).
- Cookies `@supabase/ssr`: Path **`/`**, SameSite **lax**, host-only, sin Domain. **No Path `/nj`**.
- Refresh: `getUser()` en middleware (solo matcher login/dashboard/admin).
- Logout: `signOut()` + `router.refresh()`.
- Middleware en raíz: **sí** (matcher ya sin `/nj`).
- Sesiones al cutover **mismo host** (`www.fylmoda.com.ar`): **probablemente sobreviven**.
- Cambio de host (`nj-gonzidel` → `www`): **no**. Jars distintos.
- Login loop: riesgo bajo; OAuth roto si no se actualizan Redirect URLs.
- `www.fylmoda.com.ar/nj` (rewrite) y `nj-gonzidel.vercel.app/nj` **no comparten cookies**.

**Redirect URLs (aplicadas 2026-09-04, Site URL intacta `https://catalogo-fyl-test.web.app`):**

Antes: 36. Después: 42. No se borró ninguna `/nj`.

Agregadas (exactas + wildcard `?next=**`, mismo patrón que `/nj`):

```
http://localhost:3001/auth/callback
http://localhost:3001/auth/callback?next=**
https://nj-gonzidel.vercel.app/auth/callback
https://nj-gonzidel.vercel.app/auth/callback?next=**
https://www.fylmoda.com.ar/auth/callback
https://www.fylmoda.com.ar/auth/callback?next=**
```

OAuth raíz localhost verificado: `/login` → Google `redirect_to=/auth/callback?next=/dashboard` → `/dashboard`. La URL exacta sola no alcanza: sin `?next=**` Supabase cae al Site URL (Firebase). `/nj` sigue vivo.

---

## D. PWA / SW

**NJ no es PWA.** No hay manifest ni SW propio. El PWA/SW es **vanilla** (`manifest.json` `start_url: "/"`, `scope: "/"`, `sw.js`).

| Ruta | SW hoy |
|---|---|
| `/catalogo` | catalogo1 **unregister** en cada carga |
| `/nj` | NJ ahora también **unregister** (añadido en `layout.tsx`) |
| vanilla residual | puede registrar SW scope `/` |

Plan cutover: 1) tombstone vanilla opcional 2) dejar de servir HTML que carga `scripts/config.js` 3) si se quiere PWA post-launch, manifest nuevo con `start_url: "/"` 4) usuarios con icono viejo: reinstalación o redirect.

---

## E. Carrito

Contrato (código, no UI clickeada — no hay cuenta de prueba):

- Store `fyl-nj-cart` + `useCartSync`.
- Agregar **no reserva físico**. `cart_items.status='reserved'` es etiqueta.
- Sellable gobierna PDP/CartTab. Sync BD en `syncNow()` al checkout.
- Recarga: localStorage + merge Supabase al montar.

**Hecho en 59:** smoke login/dashboard/carrito vacío + checkout/309 controlados. Cuenta test: `customer_id` `771a9a9c-e703-4443-819f-05b0eab736be` (no exponer email).

---

## F. Checkout

- `rpc_checkout_cart(p_operation_id uuid, p_request jsonb)` — `source: dashboard-nj`.
- Idempotencia en wrapper. NJ **ya no genera UUID nuevo cada intento** (sessionStorage + fingerprint; ver 59 §2). Wrapper/`rpc_checkout_cart()` no se tocó.
- UI: modal “Todavía no se envía ni se paga” → **Sí, hacer pedido = pedido real**.
- Checkout real + replay + 309 se probaron en cuenta controlada (59 §4). md5 checkout SQL intacto.

---

## G. 309

- Zona: Resistencia / Barranqueras / Puerto Vilelas / Fontana (perfil `customers`, no transporte).
- Checkout 309: `awaiting_apartado`, **sin** descontar stock.
- Commit: admin `rpc_mark_order_items_picked` → `fn_commit_deferred_order_item_stock`.
- UI clienta: “Preparando tu pedido” → “Listo para retirar” + 36h.
- **Probado** en 59 §4 (ciudad temporal Resistencia, Apartar, cancel, Desarmar). Hallazgos en [[10-BACKLOG-NO-CRITICO]].

---

## H. SEO (día D, no ahora)

Hoy: `robots: { index: false }` en `nj/app/layout.tsx` (añadido para no indexar por error) + header Vercel `noindex` observado.

Día D:

1. Quitar `robots` noindex del layout.
2. Quitar `X-Robots-Tag` del proyecto Vercel NJ.
3. Añadir `metadataBase`, canonical, `robots.ts`, `sitemap.ts`.
4. Portar JSON-LD / OG desde catalogo1.
5. Sitemap: `https://www.fylmoda.com.ar/sitemap.xml`.

---

## I. Redirects (diseñados, no aplicados)

| origen | destino | tipo | cuándo |
|---|---|---|---|
| `/catalogo` | `/` | 301 | cutover |
| `/catalogo/:path*` | `/:path*` | 301 | cutover |
| `/nj` | `/` | 301 | cutover |
| `/nj/:path*` | `/:path*` | 301 | cutover |
| `/index.html` | `/` | 301 | cutover (ya parcial) |
| `/client/dashboard.html` | `/login` o `/dashboard` | 302 | cutover |
| `/catalogo.html` | `/` | 301 | cuando se retire vanilla del catch-all |
| `/calzado-femenino-por-mayor` | `/calzado` | 301 | cuando se retire catch-all |
| `/produto/:sku` | `/producto/:sku` | 301 | ya existe en NJ |

---

## J. URLs hardcodeadas

| Dónde | Path | Cutover |
|---|---|---|
| `LoginClient` + `auth/callback` | `/nj/auth/callback` | sí |
| Assets / fetch / `<a>` | `/nj/logo.png`, `/nj/api/...` | sí |
| `customer-status-message`, `useOrders`, SQL 305+ | `/nj/dashboard?tab=active-order` | sí (defaults + mensajes **nuevos**; no reescribir WA históricos). **2026-09-05:** `getDashboardActiveOrderUrl()` ya no usa `window.location` (evitaba localhost). Por ahora apunta a `https://nj-fyl-testing.vercel.app/nj/dashboard?tab=cart` (`NEXT_PUBLIC_CUSTOMER_DASHBOARD_URL` para cambiarlo). |
| `admin/publications.js` | `/catalogo#/pdp/{sku}` | sí |
| Meta feed SQL | `/catalogo?sku=` | sí |
| `catalogo1/vercel.json` | rewrite `nj-gonzidel` | sí |
| Kanban `localhost:5500` | admin vanilla | fix dev, no cutover |
| `wa.me` números | no son paths | no |

---

## K. Env

| Var | Estado |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `ANON_KEY` | prod-ok |
| `NEXT_PUBLIC_SITE_URL` | **faltante** — origen = `window.location.origin` |
| service_role | no usado en NJ (correcto) |
| Pixel / Clarity env | no existen; IDs solo en catalogo1/vanilla |

`nj/.env.example` creado (nombres vacíos).

---

## L. Admin

- Middleware: login.
- **Ahora** `app/admin/layout.tsx` exige fila en `public.admins`; cliente → `/dashboard`.
- 333C: write productos/variantes/VSS solo admin.
- UI admin (editar producto/stock) **no clickeada** (sin credenciales staff de prueba).

---

## M. Analytics

| | GA `G-2JDYZW1KD6` | Pixel `988002930324230` | Clarity `w7h6cytm9j` |
|---|---|---|---|
| NJ | sí (`send_page_view: false`) | no | no |
| catalogo1 | sí + page_view | sí | sí |
| vanilla | sí | sí | sí |

Riesgo post-cutover: **duplicar** si catalogo1/vanilla siguen en el mismo host. NJ pierde Pixel/Clarity si no se portan. No se cambiaron IDs.

---

## N. Checklist

### PRE-CUTOVER

- [x] `next build` sin `ignoreBuildErrors`
- [x] Guard staff en `/admin`
- [x] Unregister SW en NJ
- [x] noindex explícito en metadata
- [x] Cuenta test clienta (Gonzalo `771a9a9c-…`; no staff 309 reales). Admin staff de prueba dedicado: pendiente
- [x] Smoke UI: login raíz, dashboard, carrito, checkout + 309 controlados (59). PDP/admin denied: no re-auditados en esa pasada
- [x] Código local: `basePath` quitado + auth dual + hardcodes de callback. Deploy live sigue `/nj`
- [x] Redirect URLs Supabase raíz (`/auth/callback` + `?next=**`) — OAuth localhost raíz verificado; Site URL no se tocó
- [ ] Migración SQL defaults `p_dashboard_url` (autorizar aparte)
- [ ] Decidir proyecto Vercel canónico (NJ dueño de `www`)
- [ ] Portar Pixel/Clarity o aceptar gap
- [ ] Sitemap/robots/canonical listos en rama

### CUTOVER

1. Deploy NJ **sin** `basePath` (o `""`) al proyecto que sirve `www.fylmoda.com.ar`.
2. Reemplazar `catalogo1/vercel.json`: quitar `/`→`/catalogo` y rewrite `/nj`→gonzidel; poner 301 de la tabla I.
3. Actualizar Supabase Redirect URLs (`/auth/callback`).
4. Quitar noindex (layout + header Vercel).
5. Activar sitemap/robots/canonical.
6. Dejar de servir vanilla `config.js` en el host canónico (retirar catch-all).
7. No revertir 330–333C.

### POST-CUTOVER

- [ ] Home `/` es NJ (login, catálogo, PDP)
- [ ] `/catalogo` y `/nj` 301
- [ ] OAuth en `www` (no solo gonzidel)
- [ ] Cookies Path `/`, una sola sesión
- [ ] Un solo SW o ninguno
- [ ] Carrito + checkout test
- [ ] Admin staff entra; clienta no
- [ ] Cron 332 + snapshot
- [ ] Un solo GA config

---

## O. Rollback

Si NJ falla el día D:

1. Restaurar `catalogo1` como proyecto Vercel de `www` (redirect `/`→`/catalogo`, rewrite `/nj` a gonzidel).
2. **No** revertir DB 330–333C.
3. Pedidos/stock quedan.
4. Re-poner noindex en NJ si sigue público por `/nj`.
5. Auth Redirect URLs: volver a `/nj/auth/callback`.
6. SW: catalogo1 ya unregister; vanilla residual no reactivar.
7. Reversible: Vercel routing, basePath, redirects, noindex, Auth URLs. Irreversible (y no se toca): sellable/checkout/grants.

---

## P. PRE-LAUNCH NJ BLOCKERS

Orden de criticidad:

1. **Cutover de host Vercel** — `www` hoy es catalogo1; `/nj` es rewrite. Auth/cookies hay que probarlos en `www` con NJ dueño del dominio.
2. **Quitar `basePath /nj` + hardcodes** — hecho en código local (59 §3). Falta **deploy**. Defaults SQL/WA `/nj/dashboard` no migrados.
3. **Redirect URLs Supabase** — raíz + `?next=**` ya en live (42 URLs). OAuth localhost raíz verificado. Falta OAuth en `www` el día D (no cambiar Site URL hasta el cutover).
4. **Cuenta de prueba** — hay clienta de test (`771a9a9c-…`). Falta staff admin dedicado (no usar 309 reales).
5. **Analytics unificado** — evitar doble GA/Pixel si catalogo1 sigue vivo; decidir Pixel/Clarity en NJ.
6. **SW vanilla scope `/`** — unregister en NJ+catalogo1 hecho; el día D hay que dejar de servir vanilla `config.js`.
7. **SEO día D** — quitar noindex + sitemap/canonical. Hoy noindex está **puesto a propósito**.

No son blockers: 333A/B, zombies, reserved_qty, ColorHex, vanilla residual, Fase 4 en catalogo1, ignoreBuildErrors (cerrado).
