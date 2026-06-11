# 41 — Migración Next.js 15 App Router — `/nj` — 2026-06-08

## Resumen ejecutivo

Se inició una **migración paralela** del frontend público (`index.html` + Vanilla JS) a **Next.js 15 App Router**, alojada en la subcarpeta `/nj` del mismo repositorio.

- El objetivo es comparar rendimiento, navegación, back button, scroll restoration y estabilidad visual contra la versión Vanilla JS antes de cualquier cutover.
- La app en `/nj` corre **en paralelo** en `http://localhost:3001/nj` (dev) y se prepara para Vercel con `basePath: '/nj'`.
- **No se toca** `index.html`, `main-supabase.js`, `sw.js`, ni las rutas de producción actuales.
- **Primera etapa: catálogo público de solo lectura** — sin auth, carrito, pedidos ni service worker.

---

## Motivaciones

| Problema en Vanilla | Solución Next.js |
|---|---|
| Routing hash-based (`#/tag/...`, `#/pdp/SKU`) | App Router con rutas reales (`/producto/[sku]`, `/[categoria]`) |
| Fetch Supabase en cliente → waterfall inicial | Server Components + ISR → primer HTML con datos |
| Transformaciones Cloudinary manuales en JS | `next/image` con loader Cloudinary personalizado |
| Estado global en `window.*` | Hooks y SWR con encapsulamiento limpio |
| Sin scroll restoration automático | Next.js App Router restaura scroll por defecto |
| Back button no restaura filtros ni scroll | `?from=...` URL param preserva el estado de regreso |

---

## Arquitectura

### Stack

- **Next.js 15** (App Router)
- **TypeScript**
- **Supabase** (`@supabase/supabase-js`) — mismo proyecto de producción
- **SWR** (`swr`) — data fetching client-side con cache
- **Cloudinary** — loader personalizado en `next.config.ts`
- **CSS**: import directo de `../../styles.css` (reutilización total del sistema de estilos existente)

### Patrón de datos

```
SSR (Server Component, 3s timeout + AbortController)
  → si falla: CatalogSkeleton inmediato (Suspense)
  → cliente toma el relevo con SWR (useSWRInfinite)
```

Todos los banners excepto `InfoBanner` son **client components con SWR** para no depender de SSR (que falla en el entorno de dev de Windows por restricciones de red).

### Rendering

- **Páginas**: `NOT async` → envían HTML con skeleton inmediato
- **`CatalogContent`**: `async` Server Component envuelto en `<Suspense>` → permite streaming
- **Client Components**: `useSWRInfinite`, `useSWR` para data dinámica
- **ISR**: `revalidate = 300` en páginas de catálogo y PDP

---

## Estructura de carpetas

```
nj/
├── middleware.ts                   # Protege /dashboard, refresca token SSR
├── app/
│   ├── layout.tsx                  # Root layout: Header, BottomNav, globals.css
│   ├── page.tsx                    # Home: catálogo "all" + banners
│   ├── [categoria]/page.tsx        # Catálogo por categoría
│   ├── tags/[...slugs]/page.tsx    # Catálogo por tags
│   ├── producto/[sku]/page.tsx     # PDP (Product Detail Page)
│   ├── banner/[slug]/page.tsx      # Colección completa de un banner curado
│   ├── como-comprar/page.tsx       # Guía de compra
│   ├── quienes-somos/page.tsx      # Quiénes somos
│   ├── login/
│   │   ├── page.tsx                # Metadata wrapper (Server)
│   │   └── LoginClient.tsx         # Google OAuth + Magic Link (Client)
│   ├── auth/callback/route.ts      # exchangeCodeForSession → redirect
│   ├── dashboard/
│   │   ├── layout.tsx              # Guard: verifica sesión SSR
│   │   ├── page.tsx                # Carga customer + orders (Server)
│   │   └── DashboardClient.tsx     # Tabs pedidos/perfil, logout (Client)
│   └── api/catalog/route.ts        # API route (legacy, no usado por useCatalog)
├── components/
│   ├── layout/
│   │   ├── Header.tsx              # Header móvil con logo, SearchBar y HeaderActions
│   │   ├── HeaderActions.tsx       # Campana + perfil (foto Google si logueado) (Client)
│   │   └── BottomNav.tsx           # Navegación inferior: Inicio, Buscar, Pedidos, Perfil
│   ├── catalog/
│   │   ├── CatalogShell.tsx        # Client: grid, filtros, infinite scroll, slots
│   │   ├── ProductCard.tsx         # Server: card de producto
│   │   └── SkeletonCard.tsx        # Skeleton de altura igual a ProductCard
│   ├── filters/
│   │   ├── CategoryTabs.tsx        # Chips de categoría
│   │   ├── TagFilterBar.tsx        # Barra de filtros activos
│   │   └── SizeFilterSheet.tsx     # Sheet de filtro por talle
│   ├── search/
│   │   └── SearchBar.tsx           # Barra de búsqueda
│   ├── banners/
│   │   ├── InfoBanner.tsx          # ESTÁTICO: "COMPRA MÍNIMA 4 productos"
│   │   ├── NuevosIngresosBanner.tsx  # CLIENT: primera publicación 7 días (SWR + RPC)
│   │   ├── FylOriginalsBanner.tsx  # CLIENT: F&L Originals (SWR, SupplierCode=FYL)
│   │   ├── CuratedSpecialBanner.tsx # CLIENT: banner especial (SWR, __curated_special__)
│   │   ├── CuratedBanner.tsx       # CLIENT: banner dinámico curado (SWR, __curated__)
│   │   └── PromotionalBanner.tsx   # SERVER: promotional_banners (SSR, fallback silencioso)
│   └── howto/
│       ├── HowtoTabs.tsx           # Tabs "Cómo comprar / Quiénes somos"
│       └── FaqSection.tsx          # FAQ con acordeón (client)
├── hooks/
│   └── useCatalog.ts               # SWRInfinite: paginación, search, filtros
├── lib/
│   ├── cloudinary.ts               # Loader next/image + helpers URL
│   ├── supabase/
│   │   ├── server.ts               # createServerClient (Server Components)
│   │   ├── client.ts               # getSupabaseBrowserClient (singleton browser)
│   │   └── queries.ts              # Todas las queries SSR centralizadas
│   ├── banners/
│   │   ├── nuevos-ingresos.ts      # RPC + mezcla banner Nuevos ingresos
│   │   ├── curated-banner-fetch.ts
│   │   ├── curated-banner-layout.ts
│   │   ├── curated-banner-tags.ts  # __curated__ / __curated_special__
│   │   └── catalog-dates.ts
│   └── utils/
│       ├── catalog.ts              # agruparProductos, intercalarProductos (round-robin feed), formatARS
│       ├── size-normalizer.ts      # Normalización de talles
│       └── search.ts               # searchProducts, filterBySizes
├── styles/
│   └── globals.css                 # Solo: @import "../../styles.css"
├── types/
│   ├── catalog.ts                  # CatalogRow, GroupedProduct, PdpProduct, etc.
│   └── banners.ts                  # PromotionalBannerData, CuratedBannerConfig, etc.
├── public/
│   ├── logo.png                    # Copiado de raíz
│   ├── favicon.ico
│   └── assets/
│       ├── icono-carrito-x4.png
│       ├── icons/instagram.svg
│       ├── icons/facebook.svg
│       └── maps/mapa-fyl.jpg
├── next.config.ts
├── tsconfig.json
├── package.json
└── .env.local                      # NEXT_PUBLIC_SUPABASE_URL + ANON_KEY
```

---

## Banners implementados

### 1. InfoBanner — Estático
- **Componente**: `components/banners/InfoBanner.tsx`
- **Tipo**: Server Component estático (sin fetch)
- **Contenido**: "COMPRA MÍNIMA — 4 productos combinables — Guía de compra →"
- **Link**: `/como-comprar`
- **Posición**: `aboveGridSlot` (entre filtros y grid)
- **Icono**: `assets/icono-carrito-x4.png`

### 2. NuevosIngresosBanner — Client SWR
- **Componente**: `components/banners/NuevosIngresosBanner.tsx`
- **Fuente**: `rpc_get_nuevos_ingresos_products(7)` + cruce con catálogo disponible
- **Criterio**: primera publicación (`min(publication_events.published_at)`); reingreso solo vía `nuevos_ingresos_highlight_at` (admin)
- **Detalle completo**: [[42-HOME-BANNERS-FEED-NJ-2026-06-09]] §1

### 3. FylOriginalsBanner — Client SWR
- **Componente**: `components/banners/FylOriginalsBanner.tsx`
- **Tipo**: Client Component con `useSWR`
- **Fuente**: `catalog_public_view` WHERE `SupplierCode = 'FYL'`
- **Render**: Scroll horizontal de product cards, skeleton mientras carga
- **Link "Ver colección"**: `/tags/fyl-originals`
- **Posición**: `aboveGridSlot` (después de Nuevos ingresos e InfoBanner)

### 4. CuratedSpecialBanner — Client SWR (banner dinámico especial)
- **Componente**: `components/banners/CuratedSpecialBanner.tsx`
- **Fuente**: `custom_product_banners` WHERE `tag_value = '__curated_special__'`
- **UI**: tarjeta oscura, 3 fotos superpuestas, textos JSON en `description`
- **Admin**: `quick-actions.html` preset `special`
- **Posición**: `aboveGridSlot`, encima de CuratedBanner
- **Detalle**: [[42-HOME-BANNERS-FEED-NJ-2026-06-09]] §3

### 5. CuratedBanner — Client SWR (banner dinámico)
- **Componente**: `components/banners/CuratedBanner.tsx`
- **Tipo**: Client Component con `useSWR`
- **Fuente**: `custom_product_banners` WHERE `enabled = true AND tag_value = '__curated__'` + JOIN `custom_product_banner_items(product_variant_id, position)`
- **Productos**: fetcha por `variant_id IN (...)` desde catálogo snapshot/vista, ordenados por `position`
- **Render**: Carrusel 2×2 horizontal
- **Link "Ver todo"**: `/banner/[slug]`
- **Posición**: `aboveGridSlot` (debajo del banner especial)

### 6. PromotionalBanner — Server (SSR)
- **Componente**: `components/banners/PromotionalBanner.tsx`
- **Tipo**: Server Component
- **Fuente**: `promotional_banners` WHERE `enabled = true` ORDER BY `order` LIMIT 1
- **Fallback**: Si SSR falla, no renderiza (silencioso)
- **Posición**: `aboveGridSlot` (después de FylOriginals e InfoBanner)

---

## Rutas implementadas

| Ruta | Tipo | Descripción |
|------|------|-------------|
| `/nj` | Server + Streaming | Home: catálogo "all" + todos los banners |
| `/nj/[categoria]` | Server + Streaming | Catálogo filtrado por categoría |
| `/nj/tags/[...slugs]` | Server + Streaming | Catálogo filtrado por tags |
| `/nj/producto/[sku]` | Server ISR | PDP — resuelve SKU a Articulo, galería, variantes |
| `/nj/banner/[slug]` | Server + Streaming | Colección completa de un banner curado |
| `/nj/como-comprar` | Server estático | Guía de compra (4 pasos, notas, FAQ acordeón, redes) |
| `/nj/quienes-somos` | Server estático | Presentación, ventajas, ubicación, redes |

---

## Decisiones de arquitectura

### D1 — `basePath: '/nj'` permanente en paralelo
Permite testing lado a lado sin DNS changes. El cutover a `/` queda para cuando se valide la paridad de UX/rendimiento.

### D2 — CSS reutilizado directamente
`globals.css` hace `@import "../../styles.css"`. No se reescribió ninguna clase. Mantiene identidad visual exacta.

### D3 — Logos con `<img>` explícito
`next/image` con `basePath` no aplica `basePath` a `unoptimized` automáticamente en todas las condiciones. Se usan `<img src="/nj/logo.png">` directos para evitar 404.

### D4 — SSR con timeout de 3 segundos + fallback silencioso
```ts
// En lib/supabase/queries.ts
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 3000);
const { data, error } = await (query as any).abortSignal(controller.signal);
```
En entorno dev de Windows, el proceso Node no alcanza Supabase por restricciones de red. El timeout de 3s garantiza que el skeleton se muestra rápido y el cliente toma el relevo.

### D5 — Banners como client components
Todos los banners con datos dinámicos son client components con SWR. Esto elimina la dependencia de SSR (que falla) y garantiza que siempre cargan desde el browser, igual que el `index.html` original.

### D6 — `ProductCard` sin `useSearchParams`
`ProductCard` recibe `href` completa como prop desde `CatalogShell`. Esto evita que el componente sea client y permite que sea Server Component puro. El `?from=...` param se arma en `CatalogShell`.

### D7 — Suspense + inner async component
```tsx
// page.tsx — NO async: envía HTML inmediato
export default function HomePage() {
  return (
    <Suspense fallback={<CatalogSkeleton />}>
      <CatalogContent />   {/* async: espera Supabase adentro */}
    </Suspense>
  );
}
```
Esto garantiza que el skeleton aparece en el primer byte de HTML, sin bloquear el render.

### D8 — CuratedBanner: __curated__ con variant_ids
El banner dinámico principal usa `custom_product_banner_items.product_variant_id` (productos específicos elegidos por el admin), no filtros por tag. El CuratedBanner fetchea:
1. Config desde `custom_product_banners` WHERE `tag_value = '__curated__'`
2. Items desde `custom_product_banner_items` (JOIN automático con select nested)
3. Productos desde `catalog_public_view` WHERE `variant_id IN (...)`

### D9 — Feed home: round-robin Calzado/Ropa/Otros + republicación
`intercalarProductos` en `lib/utils/catalog.ts` ordena por `max(FechaPublicacion, FechaIngreso)` dentro de cada bucket y mezcla 1:1:1. `useCatalog` aplica la misma mezcla tras SWR para que el scroll no pierda el orden. Ver [[42-HOME-BANNERS-FEED-NJ-2026-06-09]] §5.

---

## Errores resueltos durante la implementación

| # | Error | Causa | Fix |
|---|-------|-------|-----|
| 1 | `useSearchParams()` fuera de Suspense | `Header`, `BottomNav`, `ProductCard` usaban el hook sin boundary | `Suspense` en layout; `href` como prop a `ProductCard` |
| 2 | `themeColor` metadata warning | Moved de `metadata` a `viewport` export | `export const viewport = { themeColor: "#CD844D" }` |
| 3 | `outputFileTracingRoot` warning | Monorepo-like structure | `outputFileTracingRoot: path.join(__dirname)` en `next.config.ts` |
| 4 | `fetch failed` 7–8s de timeout | Node.js en Windows no alcanza Supabase en SSR | `AbortController` 3s + try/catch silencioso + Suspense skeleton inmediato |
| 5 | Logo 404 | `basePath: '/nj'` no aplica a `<img>` estáticas | `src="/nj/logo.png"` explícito |
| 6 | `onLoad="this.media='all'"` React warning | React no acepta strings como handlers | Eliminado; `display=swap` ya suficiente |
| 7 | `SyntaxError: Unexpected end of JSON input` (500 transitorio) | Hot-reload race condition durante recompilación | Auto-resuelto al terminar compilación |
| 8 | `ReferenceError: getPromotionalBanner is not defined` (transitorio) | Caché compilado stale al cambiar `page.tsx` | Auto-resuelto con recompilación |
| 9 | `CuratedBanner` nunca aparecía | Era Server Component → SSR siempre fallaba | Reescrito como client component con SWR |

---

## Flujo de datos — Catálogo

```
1. page.tsx (NOT async)
   └── <Suspense fallback={<CatalogSkeleton />}>
         └── <CatalogContent /> (async Server Component)
               ├── getCatalogPage("all", 1)  [SSR, 3s timeout]
               └── <CatalogShell
                     initialProducts={products}   // intercalarProductos en SSR
                     aboveGridSlot={InfoBanner + NuevosIngresos + FylOriginals + Special + Curated}
                   />

2. Browser monta CatalogShell (Client Component)
   ├── useSWRInfinite → merge + intercalarProductos (all, sin tags)
   ├── NuevosIngresosBanner: useSWR → rpc_get_nuevos_ingresos_products
   ├── CuratedSpecialBanner: useSWR → __curated_special__
   └── CuratedBanner: useSWR → __curated__
```

---

## Rutas estáticas informativas

### `/nj/como-comprar`
Contenido idéntico al original `#/como-comprar`:
- 4 pasos de compra
- Aclaraciones (reserva, envíos, medios de pago)
- FAQ acordeón interactivo (`FaqSection.tsx` — client)
- Redes sociales
- Tabs "Cómo comprar / Quiénes somos" (`HowtoTabs.tsx` — client, activa según pathname)

### `/nj/quienes-somos`
Contenido idéntico al original `#/quienes-somos`:
- Presentación de la empresa
- Lista de ventajas (✔)
- Ubicación + preview Google Maps
- Redes sociales
- Tabs activas

---

## Assets copiados a `nj/public/`

| Asset | Origen | Destino |
|-------|--------|---------|
| `logo.png` | raíz | `nj/public/logo.png` |
| `favicon.ico` | raíz | `nj/public/favicon.ico` |
| `icon-192x192.png` | raíz | `nj/public/icon.png` |
| `assets/icono-carrito-x4.png` | `assets/` | `nj/public/assets/icono-carrito-x4.png` |
| `assets/icons/instagram.svg` | `assets/icons/` | `nj/public/assets/icons/instagram.svg` |
| `assets/icons/facebook.svg` | `assets/icons/` | `nj/public/assets/icons/facebook.svg` |
| `assets/maps/mapa-fyl.jpg` | `assets/maps/` | `nj/public/assets/maps/mapa-fyl.jpg` |

---

## Estado actual (2026-06-09)

| Área | Estado |
|------|--------|
| Catálogo home + categorías + tags | ✅ Implementado |
| PDP `/producto/[sku]` | ✅ Implementado |
| Filtros (categoría, tag, talle, búsqueda) | ✅ Implementado |
| Infinite scroll (SWR) | ✅ Implementado |
| Feed orden republicación + mix categorías | ✅ Round-robin NJ (2026-06-09) |
| Back button restaura scroll + filtros | ✅ Vía `?from=...` param |
| Banner Nuevos ingresos | ✅ Client SWR + RPC 231/232 |
| Banner FYL Originals | ✅ Client SWR |
| Banner Info (compra mínima) | ✅ Estático |
| Banner especial (`__curated_special__`) | ✅ Client SWR + admin quick-actions |
| Banner Dinámico Curado (`__curated__`) | ✅ Client SWR |
| Reingreso destacado admin publications | ✅ Checkbox + `nuevos_ingresos_highlight_at` |
| Banner Promocional (`promotional_banners`) | ✅ Server (silencioso si SSR falla) |
| Página Cómo comprar | ✅ Implementado |
| Página Quiénes somos | ✅ Implementado |
| Página colección `/banner/[slug]` | ✅ Implementado |
| Auth — login Google OAuth + Magic Link | ✅ Implementado (`@supabase/ssr`) |
| Auth — callback handler + session cookie | ✅ Implementado |
| Middleware protección `/dashboard` | ✅ Implementado |
| Dashboard — pedidos y perfil del cliente | ✅ Implementado |
| Header — iconos notificaciones + perfil | ✅ Implementado (foto Google si logueado) |
| Carrito (Zustand) | ⏸ DIFERIDO |
| Service Worker | ⏸ DIFERIDO |
| Cutover DNS / producción | ⏸ DIFERIDO hasta validar paridad |

---

## Auth — Fase 2 (2026-06-08)

### Stack
- `@supabase/ssr` — manejo de sesión vía cookies (SSR-safe)
- `createBrowserClient` — reemplaza el cliente anterior (que tenía `persistSession: false`)
- `createSupabaseServerClient` — async, usa `cookies()` de Next.js

### Archivos nuevos

| Archivo | Descripción |
|---------|-------------|
| `nj/middleware.ts` | Protege `/dashboard/*`, redirige a `/login?next=...` si no hay sesión. Refresca token automáticamente. |
| `nj/lib/supabase/server.ts` | `createSupabaseServerClient()` (async) + `getServerUser()` para Server Components. |
| `nj/app/login/page.tsx` | Wrapper server; metadata. |
| `nj/app/login/LoginClient.tsx` | Client Component: Google OAuth button + Magic Link form. Maneja `?next=` redirect. |
| `nj/app/auth/callback/route.ts` | Route Handler: intercambia `code` por sesión, setea cookies, redirige a `next` o `/dashboard`. En error → `/login?error=auth_error`. |
| `nj/app/dashboard/layout.tsx` | Server layout: verifica sesión, redirect a `/login` si no autenticado. |
| `nj/app/dashboard/page.tsx` | Server Component: carga `customer` + `orders` (con `order_items`). |
| `nj/app/dashboard/DashboardClient.tsx` | Client: tabs Pedidos / Perfil, accordion por pedido, cerrar sesión. |
| `nj/components/layout/HeaderActions.tsx` | Client: iconos campana + perfil. Si logueado → foto de Google (o iniciales). |

### Archivos modificados

| Archivo | Cambio |
|---------|--------|
| `nj/lib/supabase/client.ts` | Migrado de `createClient` a `createBrowserClient` (`@supabase/ssr`). Elimina `persistSession: false`. |
| `nj/lib/supabase/queries.ts` | `createServerClient()` → `await createSupabaseServerClient()` en todas las llamadas. |
| `nj/components/layout/Header.tsx` | Reemplaza `<span hidden>` por `<HeaderActions />`. |
| `nj/components/layout/BottomNav.tsx` | "Pedidos" y "Perfil" ahora apuntan a `/dashboard` (antes: `/client/dashboard.html`). |
| `nj/next.config.ts` | `NODE_TLS_REJECT_UNAUTHORIZED=0` en `development` para evitar error SSL de Node.js en Windows al intercambiar código OAuth. |

### Flujo OAuth (Google)

```
1. Usuario toca "Continuar con Google" en /nj/login
2. LoginClient llama supabase.auth.signInWithOAuth({
     redirectTo: "http://localhost:3001/nj/auth/callback?next=/dashboard"
   })
3. Browser redirige a Google → usuario elige cuenta
4. Google redirige a /nj/auth/callback?code=...&next=/dashboard
5. Route Handler: exchangeCodeForSession(code) → setea cookies de sesión
6. Redirect a /nj/dashboard
7. Middleware valida sesión en cada request subsiguiente
```

### Configuración requerida en Supabase

En **Auth → URL Configuration → Redirect URLs** agregar:
```
http://localhost:3001/nj/auth/callback
http://localhost:3001/nj/auth/callback?next=**
```

En producción (Vercel) agregar también:
```
https://<dominio>/nj/auth/callback
https://<dominio>/nj/auth/callback?next=**
```

### Dashboard — datos que muestra

- **Bienvenida**: nombre del customer + número de cliente
- **Tab Pedidos**: lista de órdenes con accordion expandible
  - Header: `#número`, status badge (color), fecha, cantidad de items, total ARS
  - Detalle: imagen miniatura, nombre, color, talle, cantidad, precio
  - Estados: pending, confirmed, processing, shipped, delivered, cancelled
- **Tab Perfil**: nombre, email, teléfono, ciudad, provincia (de tabla `customers`)
- **Cerrar sesión**: `supabase.auth.signOut()` + redirect a `/login`

### Header — icono de perfil

- **No logueado**: ícono persona gris → navega a `/login`
- **Logueado con foto** (Google OAuth): `user.user_metadata.avatar_url` → imagen circular con borde naranja
- **Logueado sin foto** (Magic Link): círculo naranja con iniciales del nombre
- El estado se sincroniza con `onAuthStateChange` (reactivo)

---

## Errores resueltos — Fase 2 Auth

| # | Error | Causa | Fix |
|---|-------|-------|-----|
| 10 | `'createServerClient' is not exported from './server'` | Renombré la función pero `queries.ts` importaba el nombre viejo | Import actualizado + `await` agregado a todas las llamadas |
| 11 | `UNABLE_TO_VERIFY_LEAF_SIGNATURE` en `/auth/callback` | Node.js en Windows no puede verificar la cadena de certificados SSL de Supabase | `NODE_TLS_REJECT_UNAUTHORIZED=0` en `development` en `next.config.ts` |
| 12 | Redirect a Firebase en vez de localhost | `http://localhost:3001/nj/auth/callback` no estaba en la whitelist de Supabase | Agregar URL al panel Supabase → Auth → URL Configuration |
| 13 | `BottomNav` enviaba a `/client/dashboard.html` | Link apuntaba al dashboard Vanilla viejo | Actualizado a `<Link href="/dashboard">` |
| 14 | `SyntaxError` en `BottomNav` (transitorio) | Hot-reload compiló `Header.tsx` antes de que `HeaderActions.tsx` existiera | Auto-resuelto; archivo creado, recompilación automática |
| 15 | Warning `key` en lista de `CatalogShell` | `<FylOriginalsBanner>` y `<InfoBanner>` dentro de Fragment sin keys | `key="fyl-originals"` y `key="info-banner"` en `page.tsx` |

---

## Pendientes antes del cutover

1. **Validar en móvil real**: rendimiento, CLS, scroll restoration, back button
2. **Comparar LCP** `/nj` vs `index.html` con Lighthouse/Clarity
3. **Medir TTFB** real (con Supabase alcanzable en Vercel)
4. **Carrito**: Zustand + sync Supabase + optimistic updates
5. **SEO**: `generateMetadata` dinámico en PDP + sitemap
6. **Service Worker**: migrar `sw.js` o rediseñar strategy para App Router
7. **Dashboard perfil editable**: ruta `/dashboard/perfil` con form de edición

---

## Cómo correr en dev

```bash
cd nj
npm install
npm run dev
# → http://localhost:3001/nj
```

Variables requeridas en `nj/.env.local`:
```
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
```

---

## Referencias

- Código: `nj/` (todo el proyecto Next.js)
- Plan original: `c:\Users\gonzi\.cursor\plans\migración_next.js_15_e20bb7c6.plan.md`
- Schema curated banner: [[24-CURATED-BANNER-V1-SCHEMA]]
- Banner FYL Originals original: [[22-BANNER-FYL-ORIGINALS]]
- Banner curado operativo (Vanilla): [[37-CURATED-BANNER-FRONTEND-OPERATIVO-2026-05-18]]
- **Home NJ banners + feed + republicaciones (2026-06-09):** [[42-HOME-BANNERS-FEED-NJ-2026-06-09]]
- Arquitectura general (Vanilla): [[01-ARQUITECTURA-GENERAL]]

---

*Creado: 2026-06-08. Última actualización: 2026-06-09. Autor: agente Cursor.*
*Etapa 1: catálogo público solo lectura. Etapa 2: auth + dashboard cliente. Etapa 3: banners home + feed (ver nota 42).*
