# 17 - Auditoria modulo Orders

Estado: auditoria de codigo y SQL del repo, sin cambios aplicados.
Fecha: 2026-04-24.
Modulo: Orders / Pedidos.

## 1. Alcance

Archivos revisados:

| Archivo | Rol actual |
|---|---|
| `admin/orders.js` | Panel principal de pedidos activos/apartados/cerrados, cambios de estado, cancelaciones y envio a local. |
| `admin/order-creator.js` | Creacion/edicion admin de pedidos, clientes, items y descuento de stock. |
| `admin/closed-orders.js` | Pedidos cerrados, transporte, etiquetas, envio y listas de despacho. |
| `admin/sent-orders.js` | Pedidos enviados, reprogramacion, devolucion y transporte. |
| `admin/local-order-edit.js` | Edicion de pedidos locales / venta al publico. |
| `client/dashboard-instant.js` | Checkout cliente, lectura de pedidos, cancelaciones/reaperturas desde dashboard. |
| `client/dashboard-simple.js` | Dashboard simple con lectura de carrito/pedidos. |

SQL relevante:

| SQL | Rol |
|---|---|
| `supabase/canonical/10_checkout_flow.sql` | RLS base de `orders`/`order_items`, checkout, cerrar pedido y cancelar items. |
| `supabase/canonical/174_rpc_checkout_cart_strong_idempotency.sql` | Wrapper/idempotencia fuerte de `rpc_checkout_cart`. |
| `supabase/canonical/140_rpc_remove_order_item_restore_stock.sql` | Quitar item admin y restaurar stock. |
| `supabase/canonical/129_rpc_split_order_item_status.sql` | Split de item en picked/waiting/missing. |
| `supabase/canonical/163_stage1_stock_hardening.sql` | Cancelacion completa y endurecimiento stock/pedidos. |
| `supabase/canonical/166_rpc_apply_order_stock_deduction.sql` | Descuento de stock en pedido admin. |
| `supabase/canonical/179_rpc_admin_manual_inject_and_deduct.sql` | Inyeccion/deduccion manual en pedidos admin. |
| `supabase/canonical/151_fix_security_linter_alerts.sql` | RLS para `order_item_stock_sources` y `order_notifications`. |

## 2. Tablas usadas por Orders

| Tabla/vista | Uso detectado | Fuente |
|---|---|---|
| `orders` | Tabla principal de pedidos; lectura, insert, update, delete y transiciones. | `admin/orders.js`, `admin/order-creator.js`, `client/dashboard-instant.js`. |
| `order_items` | Items del pedido; lectura, insert, delete, cambios de status. | `admin/orders.js:1307-1320`, `admin/order-creator.js:3416-3419`, `client/dashboard-instant.js:6087-6090`. |
| `order_item_stock_sources` | Trazabilidad de fuente de stock por item. | SQL `151...:20-42`; usada por RPCs y auditoria. |
| `customers` | Datos del cliente asociado al pedido. | `admin/orders.js`, `admin/order-creator.js`, `closed-orders.js`, `sent-orders.js`, cliente. |
| `customer_notifications` | Notificaciones al cliente por eventos de pedido. | `admin/orders.js:6112-6124`, `closed-orders.js`, `sent-orders.js`, cliente. |
| `products` | Busqueda/visualizacion de productos en pedidos. | `admin/orders.js`, `admin/order-creator.js`, cliente. |
| `product_variants` | Variante, precio, imagen y stock relacionado. | `admin/orders.js`, `order-creator.js`, `sent-orders.js`, cliente. |
| `variant_sizes` | Talles para disponibilidad/pedidos locales. | `admin/order-creator.js`, `local-order-edit.js`. |
| `variant_size_warehouse_stock` | Stock por talle/deposito para disponibilidad y descuento. | `admin/orders.js:3175`, `admin/order-creator.js:1331`, cliente. |
| `variant_warehouse_stock` | Stock sin talle/agregado por deposito. | `admin/orders.js:3199`, `admin/order-creator.js:1247`. |
| `warehouses` | Resolucion de depositos `general` y `venta-publico`. | `admin/orders.js:3059`, `order-creator.js:1166`, cliente. |
| `payment_methods` | Metodos de pago para cierre/pedidos enviados. | `admin/orders.js`, `sent-orders.js`. |
| `transports` | Transporte del cliente/pedido. | `admin/orders.js`, `closed-orders.js`, `sent-orders.js`. |
| `shipping_lists` | Listas de envio/despacho. | `closed-orders.js`. |
| `local_orders` | Pedidos locales. | `local-order-edit.js`. |
| `public_sales_customers` | Cliente de venta publica/local. | `local-order-edit.js`. |

## 3. Flujo actual

### Checkout cliente

1. El cliente confirma carrito desde `client/dashboard-instant.js`.
2. Se genera `operation_id` y request metadata (`client/dashboard-instant.js:2840-2848`).
3. Se llama `rpc_checkout_cart` (`client/dashboard-instant.js:2850-2853`).
4. En SQL hay multiples definiciones/versiones historicas de `rpc_checkout_cart`; la auditoria detecto 9 `CREATE OR REPLACE FUNCTION`.
5. RLS base permite al cliente leer sus propios pedidos/items (`10_checkout_flow.sql:194-207`, `10_checkout_flow.sql:234-243`).

### Pedidos admin

1. `admin/order-creator.js` crea `orders` directo (`admin/order-creator.js:3363-3373`).
2. Inserta `order_items` directo (`admin/order-creator.js:3416-3419`).
3. Luego descuenta stock con RPCs:
   - `rpc_admin_manual_inject_and_deduct` para items manuales (`admin/order-creator.js:3105-3108`).
   - `rpc_apply_order_stock_deduction` via `updateStockBatch` para items normales.
4. Si falla el descuento, intenta rollback manual borrando `order_items` y `orders` (`admin/order-creator.js:3441-3462`).
5. Si no puede rollback, marca el pedido como `stock_pending` (`admin/order-creator.js:3473-3489`).

### Gestion admin de pedidos

1. `admin/orders.js` carga permisos frontend `orders:view/edit/delete` (`admin/orders.js:111-116`).
2. Cambios de item usan RPCs:
   - `rpc_update_order_item_status` (`admin/orders.js:5339-5343`).
   - `rpc_split_order_item_status` (`admin/orders.js:5531-5537`).
   - `rpc_remove_order_item_restore_stock` (`admin/orders.js:1318-1320`, `admin/orders.js:6466-6468`).
3. Cierre/envio/cancelacion usan RPCs:
   - `rpc_close_order` (`admin/orders.js:6028-6031`).
   - `rpc_mark_order_as_sent` (`admin/orders.js:6096-6098`).
   - `rpc_send_order_to_local` (`admin/orders.js:6174-6176`).
   - `rpc_cancel_order_full` (`admin/orders.js:6528-6530`).

### Cliente dashboard despues del checkout

1. El cliente puede cerrar/reabrir/cancelar items por RPCs (`rpc_close_order`, `rpc_reopen_order`, `rpc_cancel_order_item`, etc.).
2. Hay fallbacks/direct writes en cancelacion completa de pedido: `orders.delete`, `orders.update`, `order_items.delete` (`client/dashboard-instant.js:6100`, `client/dashboard-instant.js:6130`, `client/dashboard-instant.js:6142-6146`).
3. Esto depende fuertemente de que RLS impida acciones no autorizadas y que esos fallbacks no rompan trazabilidad de stock.

## 4. RPCs criticas

| RPC | Llamada en JS | Definiciones SQL detectadas | SECURITY DEFINER | Modifica | Riesgo |
|---|---:|---:|---:|---|---|
| `rpc_checkout_cart` | Si, cliente | 9 | Si | `orders`, `order_items`, carrito, stock/fuentes segun version. | CRITICA/DUDOSO: muchas versiones; version desplegada define stock e idempotencia real. |
| `rpc_close_order` | Si, admin y cliente | 6 | Si | `orders` y posiblemente stock segun version. | ALTA/DUDOSO: versiones con y sin descuento/stock; confirmar deploy. |
| `rpc_cancel_order_item` | Si, cliente | 3 | Si | `order_items`, `orders`, stock segun version. | ALTA/DUDOSO: varias versiones historicas. |
| `rpc_remove_order_item_restore_stock` | Si, admin | 1 | Si | `order_items`, `orders`, stock/fuentes. | ALTA: valida admin general; toca stock cruzado. |
| `rpc_update_order_item_status` | Si, admin | 1 | Si | `order_items`, `orders`. | ALTA: valida admin general, no permiso granular DB detectado. |
| `rpc_split_order_item_status` | Si, admin | 1 | Si | `order_items`, stock/fuentes. | ALTA: parte un item en picked/waiting/missing; toca flujo de stock. |
| `rpc_cancel_order_full` | Si, admin | 1 | Si | `orders`, `order_items`, stock/fuentes. | ALTA: cancelacion completa con devolucion de stock. |
| `rpc_apply_order_stock_deduction` | Si, admin creator | 1 | Si | `variant_size_warehouse_stock`, `order_item_stock_sources`, `reserved_qty`. | ALTA: valida admin general, no `orders:edit`/`stock:edit`. |
| `rpc_admin_manual_inject_and_deduct` | Si, admin creator | 1 | Si | Stock/pedido manual. | ALTA: valida admin general. |
| `rpc_mark_order_as_sent` | Si, admin | 4 | Si | `orders`, notificaciones. | ALTA/DUDOSO: varias versiones. |
| `rpc_send_order_to_local` | Si, admin | 2 | Si | `orders`, `local_orders`, cliente local. | ALTA/DUDOSO: versiones sin auth/admin detectadas en bloque inicial. |
| `rpc_create_public_sale` | Si, local-order-edit | 6 | Si | Ventas publicas, stock, clientes locales. | CRITICA/DUDOSO: muchas versiones y cruza Stock/Orders/Public Sales. |
| `rpc_void_public_sale` | No en estos JS de Orders, pero relacionada | 5 | Si | Anulacion venta publica y stock. | CRITICA/DUDOSO: muchas versiones. |

## 5. RLS y permisos detectados

| Area | Detectado | Comentario |
|---|---|---|
| `orders` RLS | Si | `10_checkout_flow.sql:194` habilita RLS; cliente self-select `10...:205-207`; admin manage `10...:219-222`. |
| `order_items` RLS | Si | `10_checkout_flow.sql:195`; cliente self-select `10...:234-243`; admin manage `10...:255-258`. |
| `order_item_stock_sources` RLS | Si | `151...:30` habilita RLS; admin manage `151...:38-42`. |
| Permisos frontend admin | Si | `admin/orders.js:111-116` usa `orders:view/edit/delete`. |
| Permiso granular DB en RPCs admin | No detectado | Las RPCs criticas revisadas validan `public.admins` o ownership, no `admin_permissions`. |
| Cliente owner checks | Si en varias RPCs | Ejemplo `rpc_close_order` permite admin o owner (`10...:527-531`); `rpc_cancel_order_item` chequea owner/admin (`10...:692-700`). |

## 6. Cruces con otros modulos

| Cruce | Riesgo |
|---|---|
| Orders + Stock | Pedidos admin inserta order/items directo y descuenta stock despues. Si falla la RPC, hay rollback manual o `stock_pending`; no es una transaccion unica end-to-end desde frontend. |
| Orders + Stock | Cancelar/remover items debe devolver stock usando fuentes (`order_item_stock_sources`). Si una ruta borra directo `order_items`/`orders`, puede perder trazabilidad. |
| Orders + Products | Orders lee `products`/`product_variants` para nombres, precios, imagenes y disponibilidad. Si Products cambia modelo de stock/precio, Orders puede quedar desactualizado. |
| Orders + Customers | Orders actualiza transporte/notificaciones/datos de cliente desde varias pantallas (`orders`, `closed-orders`, `sent-orders`). Las reglas de permisos deberian ser consistentes con Customers. |
| Orders + Public Sales/Local Orders | `local-order-edit.js` usa `rpc_create_public_sale` y `local_orders`; comparte stock con venta publica. Versionado de RPCs es critico. |

## 7. Documentacion vs codigo

| Documento | Estado | Comentario |
|---|---|---|
| `05-FLUJO-PEDIDOS.md` | Confiable pero incompleto | Describe flujo general, pero no detalla todas las pantallas, RPCs, fallbacks ni direct writes. |
| `03-MAPA-DE-RPCS.md` | Parcial | Lista RPCs clave, pero no refleja la cantidad de versiones multiples ni las llamadas nuevas/locales. |
| `04-FLUJO-STOCK.md` | Confiable para concepto | Marca que pedidos descuentan stock, pero Orders necesita mapa propio por rutas de cancelacion/stock_pending. |
| `99-AUDITORIA-DOCUMENTACION.md` | Confiable como alerta general | Ya marca dudas sobre pedidos/stock; esta nota agrega evidencia puntual. |
| `13-RPCS-DEPLOY-STATE.md` | Importante/DUDOSO | Debe usarse para cerrar que version real de RPCs esta desplegada. |

## 8. Riesgos prioritarios

1. CRITICA / DUDOSO: `rpc_checkout_cart`, `rpc_close_order`, `rpc_create_public_sale` y otras RPCs tienen multiples definiciones; no se puede inferir con certeza que version esta desplegada.
2. CRITICA: hay rutas cliente/admin con escrituras directas a `orders`/`order_items`; si RLS real es permisiva o distinta al repo, DevTools podria saltar flujos con trazabilidad.
3. ALTA: pedidos admin no crea orden+items+descuento de stock como una unica transaccion DB; depende de rollback manual o `stock_pending`.
4. ALTA: RPCs admin criticas validan admin general, no permiso granular DB (`orders:edit`, `orders:delete`, `stock:edit`).
5. ALTA: cancelaciones/remociones cruzan `order_item_stock_sources`; cualquier ruta que borre directo puede dejar stock/fuentes inconsistentes.

## 9. Propuestas sin aplicar

1. Confirmar en Supabase real `pg_get_functiondef` de RPCs criticas de Orders y fijar "version vigente".
2. Revisar si las escrituras directas de `client/dashboard-instant.js` a `orders`/`order_items` deben reemplazarse por RPCs unicas.
3. Evaluar una RPC transaccional para pedido admin: crear/editar orden, items, descuento de stock y fuentes en una sola funcion.
4. Agregar validaciones DB granulares en RPCs admin: `orders:edit`, `orders:delete`, `stock:edit`, `shipping:edit`.
5. Documentar formalmente los estados `active`, `closing_soon`, `closed`, `sent`, `devolucion`, `stock_pending`, `cancelled`, `picked`, `waiting`, `missing`.
