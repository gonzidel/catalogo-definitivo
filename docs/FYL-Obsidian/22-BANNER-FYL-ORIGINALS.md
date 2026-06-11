# 22 — Banner FYL Originals (home)

## Alcance

Esta nota documenta el comportamiento del banner `FYL Originals` en home mobile-first.

- Archivo principal: `scripts/fyl-originals-banner.js`
- Contenedor HTML: `#fyl-originals-banner` + `#fyl-originals-scroll`
- No modifica catalogo general, PDP, checkout, carrito ni dashboard.

---

## Flujo end-to-end actual

1. Home dispara `loadAndShowFYLBanner()`.
2. `loadFYLOriginals()` consulta `catalog_public_view` filtrando `SupplierCode = FYL`, ordenado por `FechaIngreso DESC`.
3. Se agrupa por `Articulo` y se arma `DetalleColor`.
4. Si existe `window.enrichProductsWithStock`, se enriquece stock/variantes.
5. Se aplica `curateFylOriginalsSlots(products, new Date())`.
6. `renderFYLOriginalsBanner(curatedProducts)` pinta carrusel horizontal.
7. `setupFYLScrollListener(...)` agrega mas cards por bloques al llegar a 80% de scroll.

---

## Curaduria de slots (solo FYL Originals)

Funcion principal: `curateFylOriginalsSlots(products, now)`.

### Reglas de elegibilidad (slots 1-4)

Solo entran productos:

- activos (`isActiveProduct`)
- renderizables con imagen (`isRenderableProduct`)
- con stock positivo (`hasPositiveStock`)
- con identidad segura (`getProductIdentity`)

### Identidad segura (dedupe)

Prioridad:

1. `sku`
2. `variant_id` / `variantId`
3. `Articulo + Color` (color principal)

Helper: `dedupeBySafeIdentity(products)`.

### Seleccion de slots

- Slot 1: `scoreRecentProduct` (novedad/reciente por fecha)
- Slot 2: `scoreStrongProduct` (fuerte/destacado: oferta/promo + stock + recencia)
- Slot 3: `scorePushProduct` (empuje: stock alto con penalizacion por recencia)
- Slot 4: gancho diario deterministico (ver seccion siguiente)

No se permiten duplicados entre slots (helper `excludeProducts`).

---

## Slot 4 diario deterministico

Objetivo: rotar cada 24h y mantenerse estable durante el mismo dia.

### Fecha local

`buildLocalDateKey(new Date())` genera `YYYY-MM-DD` local (no UTC).

### Pool final de slot 4

1. Excluir slots 1, 2 y 3.
2. Intentar pool visualmente distinto con `isVisuallyDistinctFromTop3` (categoria/color).
3. Si no hay candidatos distintos, usar pool base restante.

### Seleccion deterministica por indice

Funcion: `pickDailyHookByDateIndex(pool, dateKey)`.

Regla:

- ordenar pool por identidad segura (estable frente a orden de entrada)
- `hash = stableStringHash(dateKey)`
- `index = hash % pool.length`
- devolver `poolOrdenado[index]`

Esto evita seleccionar siempre el hash minimo y mantiene rotacion diaria estable.

---

## Render y UX del carrusel

- Render inicial: hasta `PRODUCTS_PER_PAGE = 10`.
- Scroll horizontal con carga incremental por bloques de 10.
- Cards: imagen, badge, precio, puntos de color (max 3 + `+`).
- El cuarto producto debe quedar parcialmente visible en 360px por configuracion actual de layout/carrusel (sin cambios de estilo en esta implementacion).

---

## Navegacion y click de cards

`setupFYLCardListeners(...)` abre el PDP modal del catalogo (misma UX que las cards generales). Orden actual:

1. **`tryOpenPdpFromSku(sku)`** desde `data-sku` de la card:
   - `abrirModalPorSKU` (camino rapido si el SKU esta en `skuIndex` en memoria).
   - Si no abre: **`abrirPdpPorSkuIfPossible`** (skeleton + fetch a Supabase por SKU), expuesto en `window` desde `main-supabase.js`.
2. Mismo intento con un SKU derivado de **`DetalleColor.variantDetails`** del producto en `fylProducts` (stock preferido, si no primer SKU).
3. **`abrirModalConResultado`** si no hay SKU usable en variantes pero el producto esta cargado.
4. Fallback: simular click en **`.card.producto`** del grid si esa card existe (home paginado puede no tenerla).

### Reparo 2026-04 — PDP que no abria al tocar la card

**Sintoma:** En `/catalogo` e `index`, al tocar un producto del banner F&L Originals el PDP no abria; la consola podia quedar en silencio.

**Causa principal:** `obtenerSKUDefecto` en `fyl-originals-banner.js` solo recorria `variantDetails` si existia **`window.skuIndex`**. En `main-supabase.js` el mapa es una variable interna `skuIndex` y **no se publica en `window`**, asi que el helper devolvia casi siempre `null` y **`data-sku`** quedaba vacio. El primer paso del clic fallaba sin mensaje obvio.

**Correccion:** Misma heuristica que `obrirModalPorSKU` / `obtenerSKUDefecto` del catalogo: recorrer `DetalleColor` → `variantDetails` sin depender de `window.skuIndex`. Ademas encadenar **`abrirPdpPorSkuIfPossible`** cuando el SKU no esta aun en memoria.

**Archivos:** `scripts/fyl-originals-banner.js`; cache bust en `catalogo.html` e `index.html` (`fyl-originals-banner.js?v=...`).

**Estado:** Validado en uso (PDP abre correctamente tras el despliegue).

---


## Riesgos conocidos y mitigaciones

- Duplicados: dedupe por identidad segura + exclusiones por set entre slots.
- Productos sin stock: filtrados fuera de slots 1-4.
- Productos sin imagen: filtrados fuera de slots 1-4.
- Dataset pobre (<4 elegibles): se completan slots disponibles y el resto sigue flujo normal.
- Performance: scoring lineal + ordenamientos acotados; ejecucion una vez por carga.

---

## Checklist de validacion manual (mobile 360px)

- Home muestra 3 productos principales + 4to parcial como gancho.
- Refresh en mismo dia no cambia slot 4.
- Cambio de dia local rota slot 4.
- Slot 4 no duplica slots 1-3.
- No aparecen sin stock/sin imagen en slots 1-4.
- Click de card FYL abre PDP (modal + fetch si hace falta); ver seccion *Reparo 2026-04* arriba.
- Catalogo general conserva su orden habitual.

---

## Referencias de codigo

- `scripts/fyl-originals-banner.js`
- `scripts/main-supabase.js` (invocacion desde home)
- `styles.css` (layout visual carrusel)

### Paridad Next.js (`/nj`)

Desde 2026-06-09 el banner NJ replica la misma curaduria:

- `nj/lib/banners/fyl-originals.ts` — `agruparFylOriginals`, `enrichGroupedProductsWithVariantRecency`, `curateFylOriginalsSlots`, `fetchFylOriginalsCurated`
- `nj/components/banners/FylOriginalsBanner.tsx` — SWR sobre `fetchFylOriginalsCurated`

Sin `enrichProductsWithStock` en NJ (ver drift en nota [[42-HOME-BANNERS-FEED-NJ-2026-06-09]] §2).

