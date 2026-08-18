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

## Enlaces

- [[14-AUDITORIA-MODULO-PRODUCTS]]
- [[04-FLUJO-STOCK]]
- [[08-PERMISOS-Y-ROLES]]
