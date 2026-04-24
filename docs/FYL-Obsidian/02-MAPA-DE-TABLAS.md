# 02 - Mapa de tablas

Este mapa resume tablas criticas. Para comportamiento real por modulo, usar las auditorias 14-19.

Nota: el usuario confirmo que los SQL analizados ya estan cargados y activos en Supabase.

## Tablas criticas

| Tabla | Estado | Uso | Riesgo | Nota fuente |
|---|---|---|---|---|
| `products` | ACTIVA | Producto base, metadata, visibilidad | Alto | [[14-AUDITORIA-MODULO-PRODUCTS]] |
| `product_variants` | ACTIVA | Variante/color/SKU/precio/activo/reserved | Alto | [[14-AUDITORIA-MODULO-PRODUCTS]], [[16-AUDITORIA-MODULO-STOCK]] |
| `variant_sizes` | ACTIVA DERIVADA | Talle y stock agregado por talle | Critico | [[16-AUDITORIA-MODULO-STOCK]] |
| `variant_warehouse_stock` | ACTIVA/DERIVADA | Stock por variante/deposito sin talle | Alto | [[16-AUDITORIA-MODULO-STOCK]] |
| `variant_size_warehouse_stock` | ACTIVA CANONICA | Stock por variante/talle/deposito | Critico | [[16-AUDITORIA-MODULO-STOCK]] |
| `stock_movements` | ACTIVA | Trazabilidad de movimientos | Medio/Alto | [[16-AUDITORIA-MODULO-STOCK]] |
| `warehouses` | ACTIVA | Depositos `general`, `venta-publico`, etc. | Alto | [[16-AUDITORIA-MODULO-STOCK]] |
| `orders` | ACTIVA | Cabecera pedido cliente/admin | Critico | [[17-AUDITORIA-MODULO-ORDERS]] |
| `order_items` | ACTIVA | Lineas de pedido, estados, cantidades | Critico | [[17-AUDITORIA-MODULO-ORDERS]] |
| `order_item_stock_sources` | ACTIVA | Trazabilidad de deposito por item | Alto | [[17-AUDITORIA-MODULO-ORDERS]], [[18-AUDITORIA-MODULO-PUBLIC-SALES]] |
| `carts` | ACTIVA | Carrito abierto por cliente | Alto | [[19-AUDITORIA-MODULO-CLIENTE-CARRITO]] |
| `cart_items` | ACTIVA | Lineas de carrito | Alto | [[19-AUDITORIA-MODULO-CLIENTE-CARRITO]] |
| `customers` | ACTIVA | Clientes web/admin/public sales | Alto | [[17-AUDITORIA-MODULO-ORDERS]], [[18-AUDITORIA-MODULO-PUBLIC-SALES]], [[19-AUDITORIA-MODULO-CLIENTE-CARRITO]] |
| `admins` | ACTIVA | Usuarios admin/colaboradores | Alto | [[08-PERMISOS-Y-ROLES]] |
| `admin_permissions` | ACTIVA | Permisos por modulo | Alto | [[08-PERMISOS-Y-ROLES]] |
| `public_sales` | ACTIVA | Venta mostrador/caja | Critico | [[18-AUDITORIA-MODULO-PUBLIC-SALES]] |
| `public_sale_items` | ACTIVA | Lineas de venta mostrador | Critico | [[18-AUDITORIA-MODULO-PUBLIC-SALES]] |
| `pending_sales` | ACTIVA | Ventas pendientes Caja 2/3 | Alto | [[18-AUDITORIA-MODULO-PUBLIC-SALES]] |
| `local_orders` | ACTIVA | Pedidos locales conectados a caja | Alto | [[18-AUDITORIA-MODULO-PUBLIC-SALES]] |
| `daily_sales` | ACTIVA | Cierres/resumen diario | Medio/Alto | [[18-AUDITORIA-MODULO-PUBLIC-SALES]] |

## Observaciones transversales

- Stock con talle: fuente real `variant_size_warehouse_stock`; `variant_sizes.stock_qty` se trata como derivado.
- Carrito: `cart_items.price_snapshot` es sensible porque viene desde frontend; revisar [[19-AUDITORIA-MODULO-CLIENTE-CARRITO]].
- Public Sales y Orders comparten stock, customers y algunos flujos de local orders.
- Cualquier cambio sensible debe revisar [[15-OBSERVACIONES-PRODUCTS-A-REVISAR]].

## Enlaces

- [[03-MAPA-DE-RPCS]]
- [[04-FLUJO-STOCK]]
- [[05-FLUJO-PEDIDOS]]
- [[08-PERMISOS-Y-ROLES]]
