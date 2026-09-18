# 59 — Prep NJ raíz + checkout + OAuth — 2026-09-04

Registro de la sesión de prep **antes del cutover**. Complementa [[58-NJ-PRELAUNCH-CUTOVER-2026-09-04]] (auditoría previa; varias secciones de 58 quedaron desactualizadas — esta nota manda).

**Cutover de `www` no ejecutado.** No se desplegó a `nj-gonzidel`. No se tocó `catalogo1/`, vanilla Firebase, 330–333C, sellable, OISS, `reserved_qty`, ColorHex, triggers dirty ni cleanup de `cart_items`. No se aplicó SQL de checkout.

Backend live: **fyl-core** (`dtfznewwvsadkorxwzft`).

---

## Restricciones que se respetaron

- Producción clientas hoy: `catalogo1/` en `www.fylmoda.com.ar/catalogo` (WhatsApp, sin login/carrito).
- `/nj` en `www` sigue siendo rewrite Vercel → `https://nj-gonzidel.vercel.app/nj/:path*`.
- Catch-all de lo que no es `/catalogo` ni `/nj` → `https://catalogo-fyl-test.web.app`.
- Google Sheets deprecado.
- NJ: Next 15, vanilla HTML/JS fuera de `nj/`, sin frameworks nuevos.

---

## 1. Riesgo de duplicado en checkout NJ (evidencia)

Un segundo `operation_id` **no crea un segundo pedido** (índice live `orders_one_open_per_customer_idx` + attach a `active`/`closing_soon`).

Sí puede **volver a insertar ítems y descontar stock** si:

1. el primer RPC completa (pedido + `DELETE cart_items`, cart `open`);
2. el browser no recibe la respuesta;
3. Zustand sigue con ítems y `syncNow()` los reinserta;
4. el retry manda **otro** UUID.

El lock `FOR UPDATE` del wrapper 174 solo serializa concurrentes (el segundo ve el cart vacío). No cubre retry **secuencial** post-resync.

309 (`local_deferred_pickup=true`) está **fuera** del unique index: el attach sigue existiendo, pero un segundo order es teóricamente posible si no hay `active`/`closing_soon`.

---

## 2. Corrección frontend (sin tocar RPC)

Archivos:

- `nj/lib/cart/checkout-operation.ts` (nuevo)
- `nj/lib/cart/checkout-operation.test.ts` (nuevo)
- `nj/hooks/useCart.ts`
- `nj/components/cart/CartTab.tsx`

Comportamiento (histórico 2026-09-04; actualizado en [[62-NJ-CHECKOUT-CROSS-TAB-LOCK-2026-09-08]]):

- persiste `operation_id` + request en `sessionStorage` (`fyl-nj-checkout-op`);
- retry ambiguo reusa el mismo id y el fingerprint original;
- éxito marca completed (replay si hay retry accidental);
- lock in-flight impide RPC paralelos;
- `CartTab` deshabilita el CTA y usa ref lock.

**2026-09-08:** el estado durable pasó a `localStorage` por cliente, con Web Locks / lease TTL. Ver [[62-NJ-CHECKOUT-CROSS-TAB-LOCK-2026-09-08]]. `rpc_checkout_cart` sigue sin cambios.

Tests: `npx tsx lib/cart/checkout-operation.test.ts` **PASS**.

No se cambió el wrapper ni `rpc_checkout_cart()`.

---

## 3. NJ sin `basePath: "/nj"` (código local, no deploy)

Archivos clave:

- `nj/next.config.ts` — sin `basePath`; rewrites `/nj` y `/nj/:path*` → `/`
- `nj/lib/site-url.ts` + `nj/lib/site-url.test.ts`
- `nj/app/login/LoginClient.tsx` — `getAuthCallbackUrl()`
- `nj/app/nj/auth/callback/route.ts` — callback dual (`pfx=nj`)
- middleware matcher: `/dashboard`, `/admin`, `/login` y variantes `/nj/...`
- cookies `@supabase/ssr`: Path **`/`**
- SEO: `NJ_INDEXING_ENABLED = false` (noindex a propósito)

Auth dual:

| Entrada | Callback |
|---|---|
| `/login` | `http://localhost:3001/auth/callback?next=/dashboard` (sin `/nj`, sin `pfx`) |
| `/nj/login` | `http://localhost:3001/nj/auth/callback?next=...&pfx=nj` |

Helpers: `getAuthCallbackUrl()`, `getPublicAppPrefix()`, `resolveAuthRedirectBase()`.

Defaults SQL `/nj/dashboard?...` **no migrados**. Mensajes nuevos de NJ usan `/dashboard`. Históricos se cubren el día D con 301 `/nj/:path*`.

Build: `npx tsc --noEmit` PASS. `npx next build` PASS. Sin `ignoreBuildErrors`. TLS bypass solo en `NODE_ENV=development`. Dev: `npm run dev -- --port 3001` en `nj/`.

**Deploy live (`nj-gonzidel`) sigue con `basePath: "/nj"`.** El código local no se publicó.

---

## 4. Pruebas controladas checkout + 309 (APROBADAS)

No repetir. No seguir auditando stock/checkout/309 pre-launch.

### Fixtures

Cuenta de prueba (no exponer email en chats):

- `customer_id`: `771a9a9c-e703-4443-819f-05b0eab736be` (Gonzalo, super_admin)
- Ciudad restaurada a **Charata / Chaco**. `fn_customer_uses_local_deferred_pickup` = false
- **No usar** staff 309 reales: Gisela De la Fuente, Laura Sartor (Resistencia)

SKU de prueba:

- `R2584-BLA` Blanco talle 4
- `variant_id` `002873de-5601-476a-bc9f-a96cc59acef3`
- Baseline restaurado: general **3**, venta-público **0**, sellable **3**, OISS **0**

### Prueba 1 — checkout normal

- Pedido **A56520**
- VSS 3→2, OISS +1
- Replay `idempotent_replay: true`
- Cancel clienta **borra** el pedido y restaura stock

### Prueba 2 — flujo 309

- Ciudad temporal Charata→Resistencia (perfil)
- Checkout → `awaiting_apartado`, VSS/OISS intactos
- Admin `/admin/retiro` Apartar → `picked`, VSS 3→2, OISS +1, UI “listo para retirar”
- Cancel clienta post-apartado **no** restaura (queda `cancelled` + stock)
- **Desarmar** admin sí restaura
- Ciudad vuelta a Charata

### Hallazgos (NO tocar ahora)

Documentados también en [[10-BACKLOG-NO-CRITICO]]:

| Hallazgo | Decisión |
|---|---|
| Checkout 309 ensucia `catalog_public_snapshot_meta` aunque VSS no baje. Cron 332 converge | Baja. No tocar triggers dirty |
| Cancel clienta post-apartado no restaura stock; restore vía **Desarmar** admin | Aceptado (318) |
| `order_number` se reutiliza tras `DELETE` del pedido | Auditoría post-launch |

---

## 5. OAuth raíz — Redirect URLs live

MCP/SQL/CLI **no** pueden mutar Auth URL config. Se aplicó en Dashboard:

`https://supabase.com/dashboard/project/dtfznewwvsadkorxwzft/auth/url-configuration`

### Site URL

**No se cambió:** `https://catalogo-fyl-test.web.app`

Eso explica los fallbacks a Firebase `catalogo-fyl-test.web.app/catalogo?...` cuando el `redirect_to` no está en la allowlist.

### Redirect URLs

| | Total |
|---|---|
| Antes | 36 |
| Después | **42** |

No se borró ninguna URL `/nj` ni vanilla/Firebase.

Agregadas (exactas + wildcard `?next=**`, mismo patrón que `/nj`):

```
http://localhost:3001/auth/callback
http://localhost:3001/auth/callback?next=**
https://nj-gonzidel.vercel.app/auth/callback
https://nj-gonzidel.vercel.app/auth/callback?next=**
https://www.fylmoda.com.ar/auth/callback
https://www.fylmoda.com.ar/auth/callback?next=**
```

Siguen (entre otras):

```
http://localhost:3001/nj/auth/callback
http://localhost:3001/nj/auth/callback?next=**
https://www.fylmoda.com.ar/nj/auth/callback
https://www.fylmoda.com.ar/nj/auth/callback?next=**
https://nj-gonzidel.vercel.app/nj/auth/callback
https://nj-gonzidel.vercel.app/nj/auth/callback?next=**
```

### Lección operativa

La URL exacta `/auth/callback` **sola no alcanza**. El `redirect_to` real lleva `?next=/dashboard`. Sin `?next=**` Supabase rechaza y cae al Site URL (Firebase) con `?code=...` o `error=bad_oauth_state`.

Un `code`/`state` que ya aterrizó en Firebase **no se reusa** (PKCE perdido / state expirado). Login fresco inmediato.

### Verificación OAuth localhost (2026-09-04 noche)

Dos logins frescos desde `http://localhost:3001/login` (cuenta de prueba):

1. Google `redirect_to=http://localhost:3001/auth/callback?next=/dashboard`
2. Callback raíz → `http://localhost:3001/dashboard`
3. Cookies `sb-dtfznewwvsadkorxwzft-auth-token.0` / `.1` presentes
4. Recarga de `/dashboard`: sesión intacta
5. Misma sesión sirve en `/nj/dashboard` (Path `/`)
6. Logout desde `/nj/dashboard`: limpia `sb-*` y aterriza en `/login` (raíz)
7. Relogin raíz → `/dashboard` otra vez
8. `/nj/login` con sesión → `/nj/dashboard`

OAuth en `www` / `nj-gonzidel` **no** se probó (no hay cutover ni deploy de este código).

---

## 6. GO / NO-GO

| Pregunta | Veredicto |
|---|---|
| ¿Preparar cutover de `www`? | **GO** (OAuth localhost + idempotencia frontend + raíz local listos) |
| ¿Ejecutar cutover / deploy / mover `www`? | **NO-GO** |

### Blockers que quedan para el día D

1. Dueño de `www` (hoy catalogo1; no tocar hasta autorización explícita)
2. Deploy NJ sin `basePath` al host canónico
3. Probar OAuth en `www` (allowlist raíz ya está; Site URL cambiar solo si hace falta el día D)
4. Migración SQL defaults `p_dashboard_url` (autorizar aparte)
5. SEO / SW vanilla / analytics el día D

---

## 7. Rollback / riesgo

| Cambio | Rollback | Riesgo |
|---|---|---|
| Frontend idempotencia checkout | Revertir `checkout-operation.ts` + `useCart` + `CartTab` | Bajo. No toca RPC |
| Quitar `basePath` (local) | Restaurar `basePath: "/nj"` en `next.config.ts` | Medio si se despliega sin rewrites/`/nj` |
| Redirect URLs raíz | Borrar las 6 URLs nuevas; dejar `/nj` | Bajo. Site URL no se tocó |
| Pedidos de prueba | Ya revertidos (cancel / desarmar / ciudad Charata / stock baseline) | — |

Irreversible no tocado: sellable, grants 333C, checkout SQL, `reserved_qty`.

---

## 8. No ejecutado

- Deploy a `nj-gonzidel` / preview Vercel
- Cambio de dominio `www` / `catalogo1/vercel.json`
- Cambio de Site URL
- SQL (defaults dashboard, 331, etc.)
- Checkout o 309 adicionales

---

## Enlaces

- [[58-NJ-PRELAUNCH-CUTOVER-2026-09-04]] — auditoría pre-launch (varias secciones stale; ver esta nota)
- [[10-BACKLOG-NO-CRITICO]] — 3 hallazgos 309/order_number
- [[41-MIGRACION-NEXTJS-NJ-2026-06-08]] — flujo OAuth histórico bajo `/nj`
- [[56-FRONTENDS-CATALOGO-VS-NJ-2026-09-04]] — mapa de hosts (deploy live sigue `/nj`)
- [[05-IDEMPOTENCIA-RPC-OPERATIONS]] — patrón `operation_id`
