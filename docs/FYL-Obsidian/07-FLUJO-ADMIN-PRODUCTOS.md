# 07 - Flujo admin: productos y variantes

Para la auditoria real del modulo Products, ver [[14-AUDITORIA-MODULO-PRODUCTS]].

## Pantallas principales

| Pantalla/archivo | Uso |
|---|---|
| `admin/products.html` + `admin/products.js` | Alta/edicion rica de productos, variantes, imagenes, costos, stock inicial |
| `admin/fyl-products.html` + `admin/fyl-products.js` | Edicion masiva/operativa |
| `admin/incomplete-products.html` + `admin/incomplete-products.js` | Completar productos pendientes/incompletos |
| `admin/import-export.js` | Import/export e inventario |

## Tablas/RPCs relacionadas

- Tablas: `products`, `product_variants`, `variant_sizes`, `variant_images`, tags, suppliers, colors, stock.
- RPCs: `rpc_save_product_variant_initial_stock`, `rpc_set_variant_size_stock_batch`, `rpc_set_variant_warehouse_stock_batch`, `assign_qr_code_to_variant_size`.

## Costos y campos sensibles

Campos sensibles:

- `cost`
- `price_percentage`
- `logistic_amount`
- `recommended_price` si depende de costo

El frontend oculta/limita costos a `super_admin`, pero la proteccion real debe validarse en DB/RLS/triggers. Ver [[14-AUDITORIA-MODULO-PRODUCTS]], [[08-PERMISOS-Y-ROLES]] y [[15-OBSERVACIONES-PRODUCTS-A-REVISAR]].

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
