# FYL Next.js `/catalogo` — Documentación Técnica

> Fork de `/nj` para lanzamiento público sin login ni carrito. Consulta por WhatsApp.
> Última actualización: 2026-09-26

## Índice

| Tema | Archivo |
|------|---------|
| Arquitectura y stack | este archivo |
| Catálogo, filtros, banners | mismo stack que `doc/nj/` (subset light) |
| WhatsApp | `lib/utils/whatsapp.ts`, `components/contact/WhatsAppButton.tsx` |

---

## Propósito

- **URL**: `http://localhost:3002/catalogo` (dev) / `https://www.fylmoda.com.ar/catalogo` (prod)
- **Datos**: mismo Supabase de producción (`catalog_public_snapshot`, Cloudinary, banners CMS)
- **Sin**: login, dashboard, carrito, `rpc_checkout_cart`, middleware de auth, analytics de búsqueda
- **CTA**: WhatsApp `5493625172874` (mismo que catálogo público vanilla)

`/nj` sigue siendo la línea de desarrollo con auth+carrito. Este sync (2026-09-26) trajo mejoras de catálogo manteniendo light.

---

## Sync NJ → catalogo1 (2026-09-26)

Portado desde `nj/` (sigue light):

- Anti-CLS: `home-banner-presence`, slots de banners, `CatalogShellSkeleton`, `reconcile-display-products` (con `productHasAnyStock`)
- Datos: `useEnrichedCatalog` sin flash OOS, `snapshot-version` / revalidate
- Búsqueda: `lib/search/*` + diccionario + SearchBar a11y (**sin** writes a `search_events`)
- Display: precio por color (`variant-price`), polish `PdpGallery`, scroll restore lista↔PDP
- Conservado en light: CTA WhatsApp, rangos de talle en cards, SEO/indexación, `InfoBanner` WA

**Exclusiones explícitas:** auth, carrito, Zustand, dashboard, admin, `lib/stock` sellable, analytics de búsqueda, SSR PDP completo `lib/pdp/*`.

---

## Stack

- **Framework**: Next.js 15 App Router (TypeScript)
- **Carpeta raíz**: `catalogo1/`
- **`basePath`**: `/catalogo` en `next.config.ts`
- **Constante**: `lib/constants/app.ts` → `BASE_PATH = "/catalogo"`
- **Backend**: Supabase (mismo proyecto que `/nj` y vanilla)
- **Estilos**: `../../styles.css` + `styles/globals.css`
- **Imágenes**: Cloudinary loader custom

## Variables de entorno

Copiar desde `nj/.env.local`:

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
```

No requiere redirect URLs OAuth en Supabase.

## Desarrollo

```bash
cd catalogo1
npm install
npm run dev
# → http://localhost:3002/catalogo
```

## Despliegue

- Vercel: `rootDirectory: catalogo1/`, `basePath` ya en `next.config.ts`
- Mismas env vars Supabase que `/nj`

## Diferencias vs `/nj`

| Área | `/nj` | `/catalogo` (`catalogo1`) |
|------|-------|---------------------------|
| Auth / dashboard | Sí | No |
| Carrito / pedidos | Sí | No |
| PDP CTA | Agregar al carrito | Consultar por WhatsApp |
| Bottom nav | Inicio, Buscar, Pedido, Perfil | Inicio, Buscar, WhatsApp |
| Header | Perfil + notificaciones | Icono WhatsApp |
| Cards | Sin rango de talles | Con rango de talles |
| Indexación | Off por defecto (test) | SEO activo |
| Puerto dev | 3001 | 3002 |

## Cutover futuro

1. Desarrollar en `nj/`
2. Sync `nj/` → `catalogo1/` (excl. `node_modules`, `.next`, auth/cart/admin)
3. Re-aplicar config `catalogo1`: `basePath`, puerto, módulo WhatsApp
4. Build + deploy `catalogo1/`
