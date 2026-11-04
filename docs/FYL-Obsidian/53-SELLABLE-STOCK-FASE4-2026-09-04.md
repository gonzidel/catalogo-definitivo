# 53 — Sellable stock: Fase 4 superficies públicas — 2026-09-04

## Qué cambió

Todas las superficies públicas de listado deciden disponibilidad con la misma semántica sellable (Fase 1):

- producto comprable ⇔ `hasAnyStock === true` / algún color `hasStock === true`
- color comprable ⇔ `hasStock === true`
- unknown **nunca** equivale a comprable

El snapshot / `catalog_public_available_view` ya filtra por sellable. El enrich **ya no** consulta `variant_sizes.stock_qty` ni pisa esa señal.

## Pipeline

```text
catalog_public_available_view  (sellable canónico, live)
        ↓ refresh admin / futuro Fase 5
catalog_public_snapshot
        ↓ getCatalogPage / getAllCatalogProducts
agruparProductos  → cada color del snapshot: hasStock=true
        ↓ CatalogShell
useCatalog + useEnrichedCatalog
        ↓ enrich: solo imágenes / hex / display number
ProductCard / BannerCarouselCard / CuratedBanner
```

Búsqueda ampliada: `products` activos fuera del snapshot → `hasAnyStock=false` + badge `Sin stock`.

Curated: snapshot/vista → `hasStock=true`. Si el variant_id no está → fallback `product_variants` + imagen con `hasStock=false` (se conserva la pieza editorial).

FyL Originals: misma agrupación (`hasStock=true` si está en snapshot). Curaduría prefiere `productIsPurchasable`; si el pool entero es OOS no vacía el carrusel.

Nuevos ingresos: sigue leyendo la vista live. Sin cambio funcional.

## Superficies

| Superficie | OOS total |
|---|---|
| Home / categorías / ofertas | no entra al grid normal |
| Búsqueda `?q=` | visible + `Sin stock` |
| Banner / página `/banner/[slug]` (`fixedProductSet`) | visible + `Sin stock` |
| FyL carrusel / `/coleccion/fyl-originals` | visible + `Sin stock` solo si el ítem está en el set curado |
| PDP / CartTab | no tocado (Fase 2) |

## Qué NO se tocó

- `rpc_checkout_cart` / wrapper / 309
- PDP, CartTab, Zustand, `addItem`
- OISS, `reserved_qty`, reconcile, cart zombies
- vanilla, cron, invalidación automática del snapshot

## Stale residual (Fase 5)

Al corte 2026-09-04: 664 arts en vista vs 665 en snapshot; **3 variantes** en snapshot ya no están en la vista live (`R2474` Negro XL, `R2650` Gris 2, `R2664` Azul Nev 42). Home puede mostrarlas como disponibles hasta el próximo refresh. El PDP live las verá OOS.

No se agregaron N RPCs por card para tapar esos minutos.

## Tests

`npx tsx lib/stock/catalog-availability.selftest.ts` — ALL PASS (casos 1–7).

## Próximo (Fase 5) — implementado

Ver [[54-SELLABLE-STOCK-FASE5-2026-09-04]].
