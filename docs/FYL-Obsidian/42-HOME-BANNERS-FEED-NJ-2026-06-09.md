# 42 — Home NJ: banners, republicaciones y feed — 2026-06-09

**Estado:** Implementado en repo + migraciones **231, 232, 233** aplicadas en **fyl-core** (`dtfznewwvsadkorxwzft`) con aprobación explícita del usuario.  
**Alcance:** `/nj` (Next.js), admin `publications.html` + `quick-actions.html`, SQL canónico, estilos compartidos `styles.css`.  
**Relacionado:** [[41-MIGRACION-NEXTJS-NJ-2026-06-08]], [[24-CURATED-BANNER-V1-SCHEMA]], [[37-CURATED-BANNER-FRONTEND-OPERATIVO-2026-05-18]], [[13-RPCS-DEPLOY-STATE]], [[06-FLUJO-CATALOGO]]

---

## Resumen ejecutivo

Sesión de trabajo sobre el **home Next.js** (`/nj`):

1. Banner **Nuevos ingresos** (primera publicación real, ventana 7 días).
2. Banner dinámico **Curated** (`__curated__`) — jerarquía tipográfica del título.
3. Banner dinámico **especial** (`__curated_special__`) — tarjeta oscura, 3 fotos superpuestas, textos editables.
4. **Reingreso destacado** desde admin/publications — checkbox para volver al banner Nuevos ingresos sin confundir con primera publicación.
5. **Orden del feed** (grid bajo banners) — republicación reciente + mezcla Calzado/Ropa/Otros; fix scroll SWR.

---

## Stack visual del home (`nj/app/page.tsx`)

Orden en `aboveGridSlot` (de arriba hacia abajo):

| # | Componente | Fuente |
|---|------------|--------|
| 1 | `InfoBanner` | Estático — compra mínima |
| 2 | `NuevosIngresosBanner` | RPC / fallback — primera publicación 7 días |
| 3 | `FylOriginalsBanner` | `SupplierCode = FYL` + **curaduría slots 1–4** (paridad vanilla) |
| 4 | `CuratedSpecialBanner` | `tag_value = __curated_special__` |
| 5 | `CuratedBanner` | `tag_value = __curated__` |
| 6 | Grid catálogo | `CatalogShell` + infinite scroll |

**Nota:** El CuratedBanner ya **no** va insertado en el grid tras el 4.º producto; ambos banners curados viven en `aboveGridSlot`.

---

## 1. Banner Nuevos ingresos

### Objetivo

Mostrar productos cuya **primera publicación** cae en los últimos 7 días — alineado con admin/publications (Instagram “si” solo la primera vez). **Republicaciones normales no entran** salvo reingreso explícito (§4).

### Frontend

| Archivo | Rol |
|---------|-----|
| `nj/components/banners/NuevosIngresosBanner.tsx` | UI carrusel + link “Ver todo” |
| `nj/lib/banners/nuevos-ingresos.ts` | Fetch, RPC, fallback heurístico, mezcla por categoría |
| `nj/lib/banners/catalog-dates.ts` | `parseCatalogDateMs`, `catalogRecencyMs`, ventana 7 días |
| `nj/components/banners/BannerCarouselCard.tsx` | Tarjeta compartida carrusel |
| `styles.css` | `.nuevos-ingresos-banner` — barra lateral naranja, sin marco |

### Lógica

1. Intenta `rpc_get_nuevos_ingresos_products(p_days := 7)` → mapa `product_name → first_published_at`.
2. Cruza con `catalog_public_available_view` (stock + imagen).
3. Fallback sin RPC: heurística batch ±2 min + `nuevos_ingresos_highlight_at` reciente.
4. Mezcla round-robin por categoría (`mixProductsByCategory`); cantidad par en carrusel.

### SQL — migración 231

**Archivo:** `supabase/canonical/231_rpc_nuevos_ingresos_first_publish.sql`

- RPC `rpc_get_nuevos_ingresos_products(integer)` — `SECURITY DEFINER`, `min(publication_events.published_at)` por producto.
- Grants: `anon`, `authenticated`, `service_role`.

**Deploy:** 2026-06-09 en fyl-core.

---

## 2. Banner F&L Originals (NJ)

**Paridad con vanilla** (`scripts/fyl-originals-banner.js`, nota [[22-BANNER-FYL-ORIGINALS]]):

| Paso | NJ |
|------|-----|
| Fetch | `catalog_public_snapshot`, `SupplierCode = FYL` |
| Agrupación | `agruparFylOriginals` — `__recencyMs` por color (como vanilla) |
| Enrich | `enrichGroupedProductsWithVariantRecency` — `products` + `product_variants.last_published_at` |
| Curaduría | `curateFylOriginalsSlots` — slots 1–4 + resto |

**Slots:** (1) publicación más reciente, (2) fuerte (oferta/promo/stock), (3) empuje stock, (4) gancho diario determinístico por fecha local.

**Drift conocido:** vanilla opcionalmente llama `window.enrichProductsWithStock` antes de curar; NJ aún no enriquece stock en banner → `hasPositiveStock` deja pasar todo si no hay señal numérica (mismo fallback que vanilla sin enrich).

**Archivos:** `nj/lib/banners/fyl-originals.ts`, `nj/components/banners/FylOriginalsBanner.tsx`.

---

## 3. Banner dinámico Curated (`__curated__`)

Sin cambio de contrato de datos; ajustes de **presentación**:

- Clase wrapper `curated-dynamic-banner` en `CuratedBanner.tsx`.
- Título más grande (`clamp(21px–26px)`, peso 900), banda con gradiente + barra naranja (misma línea que Nuevos ingresos).
- “Ver todo” secundario (13px, naranja, sin subrayado default).
- Grilla carrusel 2×2, imágenes 1:1, fetch con fallback snapshot → vista live.

**Archivos:** `nj/components/banners/CuratedBanner.tsx`, `nj/lib/banners/curated-banner-fetch.ts`, `nj/lib/banners/curated-banner-layout.ts`, `styles.css`, `styles-desktop.css`.

---

## 4. Banner dinámico especial (`__curated_special__`)

### Objetivo

Misma funcionalidad que el banner curado (variantes manuales, slug, `/banner/{slug}`), **presentación distinta**: tarjeta marrón oscura, 3 imágenes de los **primeros 3 productos** seleccionados, textos editables.

### Discriminador DB

| Campo | Valor |
|-------|--------|
| `tag_value` | `__curated_special__` |
| `tag_filter` | `__curated_special__` |

Mismas tablas: `custom_product_banners` + `custom_product_banner_items`. Slug **único global** (no puede colisionar con `__curated__`).

### Textos editables (admin)

Guardados en `description` como JSON:

```json
{"overline":"OCASIÓN ESPECIAL","ctaLabel":"Ver selección"}
```

| Campo admin | Uso |
|-------------|-----|
| Etiqueta superior | `overline` |
| Título principal | `title` |
| Texto botón | `ctaLabel` |
| Subtítulo | Auto: `N productos seleccionados` |

Helpers: `nj/lib/banners/curated-banner-tags.ts` (`parseSpecialBannerMeta`, `serializeSpecialBannerMeta`).

### Frontend

| Archivo | Rol |
|---------|-----|
| `nj/components/banners/CuratedSpecialBanner.tsx` | Tarjeta clic → `/banner/{slug}` |
| `nj/lib/banners/curated-banner-tags.ts` | Constantes `CURATED_TAG`, `CURATED_SPECIAL_TAG` |
| `styles.css` | `.curated-special-banner*` — fotos con offset ~38px, rotación suave |

### Admin

**Sección:** `admin/quick-actions.html` → “Banner dinámico especial”  
**JS:** `initCuratedBannerAdmin({ preset: "special" })` — mismo módulo parametrizado que curated.

| Preset | `tag_value` | Prefijo DOM |
|--------|-------------|-------------|
| `curated` | `__curated__` | `cba-` |
| `special` | `__curated_special__` | `csba-` |

**Archivo:** `admin/curated-banner-admin.js` — presets `BANNER_ADMIN_PRESETS`, preview `special` vs `carousel`.

### Página colección

`nj/app/banner/[slug]/page.tsx` + `fetchCuratedGroupedProductsBySlug` aceptan slug de **ambos** tags (`in('__curated__','__curated_special__')`).

### Vanilla guard

`scripts/custom-banner.js` excluye ambos placeholders del banner legacy por tags:

```js
.not("tag_value", "in", '("__curated__","__curated_special__")')
```

### SQL — migración 233

**Archivo:** `supabase/canonical/233_curated_special_banner_rpc.sql`

- `rpc_get_public_curated_banner_by_slug` resuelve slug con `tag_value IN ('__curated__','__curated_special__')`.

**Deploy:** 2026-06-09 en fyl-core.

---

## 5. Reingreso destacado (admin publications)

### Problema

Productos **ya publicados** que reingresan con alta demanda deben poder volver al banner Nuevos ingresos **sin** tratar cada republicación como primera publicación.

### Solución

1. Columna `products.nuevos_ingresos_highlight_at timestamptz`.
2. Checkbox **“Nuevos ing.”** en tarjetas **ya publicadas** (`admin/publications.html` / `publications.js`).
3. Al **Actualizar** con checkbox marcado → `nuevos_ingresos_highlight_at = now()`.
4. RPC 232 incluye highlights en ventana de 7 días (fecha efectiva = `max(first_pub, highlight)`).

### Admin UX

- Checkbox visible solo si `last_published_at` / `color_publication_at` del color.
- Habilitado cuando también está marcada la publicación (como Oferta).
- Estado en `localStorage`: `publication_nuevos_ingresos_highlight`.
- Solo aplica si el producto **ya estaba publicado** antes del update (`wasPublishedBefore`).

### SQL — migración 232

**Archivo:** `supabase/canonical/232_nuevos_ingresos_rehighlight.sql`

- `ALTER TABLE products ADD COLUMN nuevos_ingresos_highlight_at`.
- Reemplaza RPC `rpc_get_nuevos_ingresos_products` (UNION first_pub + highlight).

**Deploy:** 2026-06-09 en fyl-core (post 231).

### Rollback (232)

```sql
DROP FUNCTION IF EXISTS public.rpc_get_nuevos_ingresos_products(integer);
ALTER TABLE public.products DROP COLUMN IF EXISTS nuevos_ingresos_highlight_at;
```

---

## 6. Orden del feed (grid bajo banners)

### Problema detectado

- SSR (`getCatalogPage`) aplicaba `intercalarProductos`.
- Tras cargar catálogo con SWR (`useCatalog`), el feed volvía al orden lineal por `FechaPublicacion` → **se perdía la mezcla por categoría** al hacer scroll.
- Patrón viejo 3/2/3/2/2/2 enterraba **Otros** (menor inventario).

### Solución

**Archivo:** `nj/lib/utils/catalog.ts`

| Función | Comportamiento |
|---------|----------------|
| `catalogRecencyMs` | `max(FechaPublicacion, FechaIngreso)` — republicación admin |
| `compareCatalogRecency` | Sort descendente por recencia |
| `catalogFeedBucket` | `Calzado` \| `Ropa` \| `Otros` (todo Otros unificado) |
| `intercalarProductos` | **Round-robin** 1 Calzado → 1 Ropa → 1 Otros por vuelta |

**Archivo:** `nj/hooks/useCatalog.ts`

- Tras merge de páginas SWR: si `categoria === "all"` && sin tags → `intercalarProductos(merged)`.
- Otras categorías: sort por `compareCatalogRecency` solamente.

**Paridad vanilla:** `scripts/main-supabase.js` sigue con `intercalarProductosPorCategoria` (patrón 3/2/3…). **Drift intencional** hasta unificar en cutover NJ.

### Verificación

1. Home `/nj` — primeras ~20 cards mezclan Calzado/Ropa/Otros.
2. Scroll — orden se mantiene (no vuelve a bloques monolíticos de Calzado).
3. Producto republicado hoy en Otros aparece arriba **dentro de Otros** y en slot Otros del round-robin.

---

## Migraciones Supabase (registro)

| # | Archivo | Objeto | Deploy fyl-core |
|---|---------|--------|-------------------|
| 231 | `231_rpc_nuevos_ingresos_first_publish.sql` | `rpc_get_nuevos_ingresos_products` | ✅ 2026-06-09 |
| 232 | `232_nuevos_ingresos_rehighlight.sql` | columna `nuevos_ingresos_highlight_at` + RPC ampliado | ✅ 2026-06-09 |
| 233 | `233_curated_special_banner_rpc.sql` | `rpc_get_public_curated_banner_by_slug` multi-tag | ✅ 2026-06-09 |

Post-deploy verificación 231/232:

```sql
SELECT count(*) FROM rpc_get_nuevos_ingresos_products(7);
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'products' AND column_name = 'nuevos_ingresos_highlight_at';
```

---

## Archivos tocados (índice rápido)

### Next.js `/nj`

- `app/page.tsx`
- `components/banners/NuevosIngresosBanner.tsx`, `CuratedBanner.tsx`, `CuratedSpecialBanner.tsx`, `BannerCarouselCard.tsx`
- `lib/banners/nuevos-ingresos.ts`, `curated-banner-fetch.ts`, `curated-banner-layout.ts`, `curated-banner-tags.ts`, `catalog-dates.ts`
- `lib/utils/catalog.ts`, `hooks/useCatalog.ts`, `lib/supabase/queries.ts`

### Admin

- `admin/publications.js`, `admin/publications.html`
- `admin/curated-banner-admin.js`, `admin/quick-actions.html`, `admin/quick-actions.js`

### Estilos / vanilla

- `styles.css`, `styles-desktop.css`, `nj/styles/globals.css` (compra mínima compacta)
- `scripts/custom-banner.js`

### SQL

- `supabase/canonical/231_*.sql`, `232_*.sql`, `233_*.sql`

---

## Deuda / pendientes

| Item | Notas |
|------|-------|
| Paridad feed Vanilla ↔ NJ | Unificar `intercalarProductosPorCategoria` vs round-robin NJ |
| Banner especial en `index.html` | Solo implementado en `/nj` por ahora |
| `getCuratedBanners()` queries.ts | Sin filtro `tag_value`; metadata puede mezclar tipos |
| Docs Obsidian 24 | Actualizar convención `__curated_special__` en tabla tag_value |
| Tests automatizados | Sin tests unitarios para `intercalarProductos` round-robin |

---

## Referencias cruzadas

- [[41-MIGRACION-NEXTJS-NJ-2026-06-08]] — arquitectura base `/nj`
- [[24-CURATED-BANNER-V1-SCHEMA]] — schema ítems + variant_id
- [[37-CURATED-BANNER-FRONTEND-OPERATIVO-2026-05-18]] — curated vanilla
- [[13-RPCS-DEPLOY-STATE]] — estado RPCs (actualizar filas 231–233)
- [[36-CATALOGO-SNAPSHOT-REFRESH-2026-05-15]] — refresh snapshot tras publicar

---

*Creado: 2026-06-09. Autor: agente Cursor. Bitácora de sesión home NJ + admin publications + SQL.*
