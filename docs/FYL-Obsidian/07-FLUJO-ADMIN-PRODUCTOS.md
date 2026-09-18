# 07 - Flujo admin: productos y variantes

Para la auditoria real del modulo Products, ver [[14-AUDITORIA-MODULO-PRODUCTS]].

## Pantallas principales

| Pantalla/archivo | Uso |
|---|---|
| `admin/products.html` + `admin/products.js` | Alta/edicion rica de productos, variantes, imagenes, costos, stock inicial. La descripcion tiene corrector de ortografia en espanol (`Revisar ortografia`, LanguageTool + `spellcheck` nativo). |
| `admin/fyl-products.html` + `admin/fyl-products.js` | Edicion masiva/operativa |
| `admin/incomplete-products.html` + `admin/incomplete-products.js` | Completar productos pendientes/incompletos |
| `admin/import-export.js` | Import/export e inventario |

## Tablas/RPCs relacionadas

- Tablas: `products`, `product_variants`, `variant_sizes`, `variant_images`, `color_price_offers`, tags, suppliers, colors, stock.
- RPCs: `rpc_save_product_variant_initial_stock`, `rpc_set_variant_size_stock_batch`, `rpc_set_variant_warehouse_stock_batch`, `assign_qr_code_to_variant_size`.

## Precio de oferta por variante (2026-08-04)

En `admin/products.html`, cada fila de variante tiene:

- **Precio recomendado** → se guarda en `product_variants.price` (precio base).
- **Precio de oferta** + check **Oferta** → se sincroniza con `color_price_offers` al guardar.

Comportamiento:

- Check ON + precio > 0 → upsert oferta `status=active` (fecha fin abierta `2099-12-31` si no había fechas vigentes).
- Check OFF → marca la oferta existente como `inactive`.
- El catálogo ya usa `OfertaActiva` / `PrecioOferta` de la vista pública: con oferta activa, el cliente ve el precio de oferta en lugar del recomendado.
- Compatible con `admin/offers.html` (misma tabla); campañas/fechas/imagen se siguen gestionando ahí si hace falta más detalle.
- En `admin/publications.html`, al cargar productos se leen las ofertas activas: la casilla **Oferta** queda tildada y el precio mostrado es el de oferta (base tachado).
- Precio efectivo en operación (`get_effective_price` → `color_price_offers`):
  - **PASS:** PAU, public-sales (QR/manual), historiales (`price_snapshot` / `sale_amount`), daily-sales (lee montos históricos).
  - **Fix 2026-08-04:** modal Nuevo/Editar pedido en `order-creator.js` también persiste oferta en `order_items.price_snapshot` (antes usaba precio de lista).

## NJ `/products` y match de color (2026-09-04)

`/products` **no usa RPC**. Guarda con `setColorOffer()` (`nj/lib/products/variants.ts`): insert/update directo de `color_price_offers`, `status=active`, `start_date=hoy`, `end_date=hoy+30`. Admin vanilla sigue usando fin `2099-12-31` si no hay fechas.

`get_effective_price()` y la vista/snapshot hacen **match exacto** de `color`. El frontend NJ compara en lowercase. El artículo 8000 quedó coherente usando el color canónico de la variante (`suela`, no `Suela`). Normalización global de case = fase siguiente.

Art. 8000 (producto `437dd86d-…`): lista Suela/Negro = 28500; oferta activa solo `suela` = 20000 (`3502948e-…`, 2026-09-04 → 2026-10-04).

**335 (2026-09-04):** `rpc_checkout_cart()` cobra `get_effective_price(variant_id)`. `cart_items.price_snapshot` ya no es autoridad monetaria. Wrapper `rpc_checkout_cart(uuid, jsonb)` intacto (replay). Ver [[60-CHECKOUT-EFFECTIVE-PRICE-335-2026-09-04]].

## Costos y campos sensibles

Campos sensibles:

- `cost`
- `price_percentage`
- `logistic_amount`
- `recommended_price` si depende de costo

El frontend oculta/limita costos a `super_admin`, pero la proteccion real debe validarse en DB/RLS/triggers. Ver [[14-AUDITORIA-MODULO-PRODUCTS]], [[08-PERMISOS-Y-ROLES]] y [[15-OBSERVACIONES-PRODUCTS-A-REVISAR]].

### Costo estimado desde precio de venta (2026-08-18)

Si un colaborador (no `super_admin`) crea el producto, no puede cargar `cost`. En `admin/products.html`, cuando el admin supremo abre ese producto:

- Si no hay costo, o `products.cost_is_estimated = true`, el costo se calcula al reves:
  - `costo = (precio_venta - monto_logistico) / (1 + % / 100)`
- Usa el % y el envio colocados en el producto (o 30% / $500 si no hay).
- El campo Costo queda en amarillo claro y no pisa el precio de venta si se cambia % o envio: se recalcula el costo.
- Al guardar, persiste `cost` y `cost_is_estimated`.
- Si el admin supremo edita el costo a mano, deja de ser estimado y vuelve la formula normal (el costo manda el precio recomendado).

## Cruces

- Stock: [[16-AUDITORIA-MODULO-STOCK]]
- Catalogo cliente: [[06-FLUJO-CATALOGO]]
- Carrito/precios: [[19-AUDITORIA-MODULO-CLIENTE-CARRITO]]

## Riesgos

- Mutaciones directas desde frontend sobre tablas sensibles.
- Costo/precio protegido solo en UI.
- RPCs de stock validando solo pertenencia a `admins` y no permiso granular.

## Admin buscador `/nj` (2026-09-04)

No es CRUD de productos ni de tags. Vocabulario de búsqueda:

- `/nj/admin/search` — dashboard + oportunidades desde `search_events`
- `/nj/admin/search/[canonical]` — detalle keyword / aliases
- Permiso `search`. Desactivar > borrar. Sin alta automática de aliases.

Hub: [[59-NJ-BUSCADOR-SMART-SEARCH]]. Apply: [[41-SEARCH-ADMIN-FASE5-2026-09-03]].

## Enlaces

- [[14-AUDITORIA-MODULO-PRODUCTS]]
- [[04-FLUJO-STOCK]]
- [[08-PERMISOS-Y-ROLES]]
- [[59-NJ-BUSCADOR-SMART-SEARCH]]
