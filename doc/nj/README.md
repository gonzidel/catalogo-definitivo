# FYL Next.js `/nj` — Documentación Técnica

> Nota canónica del frontend Next.js 15 App Router montado en `/nj`.
> Última actualización: 2026-06-08

## Índice

| Tema | Archivo |
|------|---------|
| Arquitectura y stack | este archivo (sección Stack) |
| Autenticación y dashboard | `doc/nj/auth-dashboard.md` |
| Carrito y flujo de pedidos | `doc/nj/cart-order-flow.md` |
| Buscador inteligente | `doc/nj/smart-search.md` |
| Filtros y categorías | `doc/nj/filters-categories.md` |
| Banners y CMS dinámico | `doc/nj/banners.md` |

---

## Stack

- **Framework**: Next.js 15 App Router (TypeScript)
- **Carpeta raíz**: `E:\PROYECTOS\CATALOGO DEFINITIVO\nj\`
- **`basePath`**: `/nj` en `next.config.ts` → todos los `href` internos usan rutas sin `/nj` (Next.js lo agrega)
- **Backend**: Supabase (mismo proyecto que el frontend Vanilla JS)
- **Estado cliente**: Zustand (`store/cart.ts`) con `persist` a localStorage
- **Estilos**: importa `../../styles.css` directamente + estilos inline en componentes
- **Imágenes**: `next/image` con loader Cloudinary custom

## Principios de arquitectura

- **Server Components** para shells de página e ISR
- **Client Components** (`"use client"`) para todo lo interactivo
- **Sin frameworks CSS** — sólo clases existentes de `styles.css` + inline styles
- **Sin modificar** archivos fuera de `/nj/`
- **Supabase SSR** (`@supabase/ssr`) para auth server-side; `createBrowserClient` en cliente

## Estructura de carpetas

```
nj/
├── app/
│   ├── page.tsx              # Home (catálogo público)
│   ├── layout.tsx            # Root layout, Header, BottomNav
│   ├── producto/[id]/        # PDP (Product Detail Page)
│   ├── login/                # Login (Google OAuth + Magic Link)
│   ├── dashboard/            # Dashboard protegido
│   └── auth/callback/        # OAuth callback route handler
├── components/
│   ├── catalog/              # CatalogShell, ProductCard, SkeletonCard
│   ├── banners/              # PromoBanner, FylOriginalsBanner, CuratedBanner, InfoBanner
│   ├── cart/                 # CartTab, ActiveOrderTab, AddToCartButton
│   ├── filters/              # CategoryTabs, SizeFilterSheet
│   ├── layout/               # Header, HeaderActions, BottomNav
│   ├── pdp/                  # PdpGallery, PdpSizePicker, PdpInteractive, PdpLoader
│   └── search/               # SearchBar
├── hooks/
│   └── useCart.ts            # Sync carrito ↔ Supabase
├── lib/
│   ├── supabase/
│   │   ├── client.ts         # createBrowserClient
│   │   ├── server.ts         # createSupabaseServerClient (async, cookies)
│   │   └── queries.ts        # fetchRawRows, fetchProduct, etc.
│   └── utils/
│       ├── catalog.ts        # agruparProductos, CATEGORIAS_MAP
│       └── search.ts         # searchProducts, buildSuggestions, levenshtein
├── store/
│   └── cart.ts               # Zustand store (persist)
└── middleware.ts             # Protección de rutas /dashboard
```

## Despliegue

- Dev: `npm run dev` desde `/nj/` → `http://localhost:3001/nj`
- Prod: Vercel, `rootDir: nj/`, `basePath: '/nj'`
- Variables de entorno: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- Redirect URLs en Supabase: `http://localhost:3001/nj/auth/callback`, producción equivalente
