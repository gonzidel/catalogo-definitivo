# 03 - Mapa de RPCs y funciones SQL

Metodologia: busqueda de `supabase.rpc(...)` en JS/HTML y `CREATE OR REPLACE FUNCTION` en SQL. Este mapa no reemplaza las auditorias modulares. Para comportamiento real por modulo, ver [[14-AUDITORIA-MODULO-PRODUCTS]], [[16-AUDITORIA-MODULO-STOCK]], [[17-AUDITORIA-MODULO-ORDERS]], [[18-AUDITORIA-MODULO-PUBLIC-SALES]] y [[19-AUDITORIA-MODULO-CLIENTE-CARRITO]].

Nota de contexto: el usuario confirmo que los SQL analizados ya estan cargados y activos en Supabase. Este archivo sigue marcando multiples versiones como riesgo de mantenimiento/documentacion.

## RPCs criticas

| RPC | Estado repo | Modulo | Toca stock/pedidos/costos | Nota fuente |
|---|---|---|---|---|
| `rpc_checkout_cart(uuid,jsonb)` | ACTIVA | Cliente/Carrito | Stock + pedidos + carrito | [[19-AUDITORIA-MODULO-CLIENTE-CARRITO]] |
| `rpc_checkout_cart()` | ACTIVA interna | Cliente/Carrito | Stock + pedidos + carrito | [[19-AUDITORIA-MODULO-CLIENTE-CARRITO]] |
| `rpc_apply_order_stock_deduction` | ACTIVA | Orders/Admin | Stock + pedidos | [[17-AUDITORIA-MODULO-ORDERS]], [[16-AUDITORIA-MODULO-STOCK]] |
| `rpc_admin_manual_inject_and_deduct` | ACTIVA | Orders/Admin | Stock + pedidos | [[17-AUDITORIA-MODULO-ORDERS]], [[16-AUDITORIA-MODULO-STOCK]] |
| `rpc_remove_order_item_restore_stock` | ACTIVA | Orders | Stock + pedidos | [[17-AUDITORIA-MODULO-ORDERS]] |
| `rpc_save_product_variant_initial_stock` | ACTIVA | Products/Stock | Stock inicial | [[14-AUDITORIA-MODULO-PRODUCTS]], [[16-AUDITORIA-MODULO-STOCK]] |
| `rpc_set_variant_size_stock_batch` | ACTIVA | Stock | Stock por talle | [[16-AUDITORIA-MODULO-STOCK]] |
| `rpc_set_variant_warehouse_stock_batch` | ACTIVA | Stock | Stock sin talle | [[16-AUDITORIA-MODULO-STOCK]] |
| `rpc_create_public_sale` | ACTIVA | Public Sales | Stock + ventas + creditos segun caso | [[18-AUDITORIA-MODULO-PUBLIC-SALES]] |
| `rpc_void_public_sale` | ACTIVA | Public Sales | Reversion stock/venta | [[18-AUDITORIA-MODULO-PUBLIC-SALES]] |
| `rpc_update_cart_item_quantity` | DUDOSA en JS vivo | Carrito | Carrito | [[19-AUDITORIA-MODULO-CLIENTE-CARRITO]], [[09-TABLAS-COLUMNAS-DUDOSAS-O-LEGACY]] |

## Pedidos y cliente

| RPC | Donde aparece |
|---|---|
| `rpc_close_order` | `client/dashboard-instant.js`, `admin/orders.js` |
| `rpc_cancel_order_item` | `client/dashboard-instant.js` |
| `rpc_cancel_order_item_units` | `client/dashboard-instant.js` |
| `rpc_delete_empty_order` | `client/dashboard-instant.js` |
| `rpc_reopen_order` | `client/dashboard-instant.js` |
| `rpc_mark_order_items_picked` | `admin/orders.js` |
| `rpc_update_order_item_status` | `admin/orders.js`, `admin/public-sales.js` |
| `rpc_split_order_item_status` | `admin/orders.js` |
| `rpc_cancel_order_full` | `admin/orders.js` |
| `rpc_send_order_to_local` | `admin/orders.js` |

Detalle: [[17-AUDITORIA-MODULO-ORDERS]].

## Stock

| RPC | Donde aparece |
|---|---|
| `rpc_move_size_stock` | `admin/move-stock.js` |
| `get_variant_stock_by_warehouse` | `admin/search.js`, `admin/public-sales.js` |
| `rpc_reconcile_stock` | `admin/stock-audit.js` |

Detalle: [[16-AUDITORIA-MODULO-STOCK]].

## Public Sales

| RPC | Uso |
|---|---|
| `rpc_create_public_sale` | Crea venta publica, usado por caja y local-order edit |
| `rpc_void_public_sale` | Anula venta publica |
| `rpc_get_public_sale_details` | Detalle de venta |
| `rpc_get_public_sales_history` | Historial |
| `rpc_create_pending_sale` / `rpc_complete_pending_sale` | Caja 2/3 y pendientes |
| `rpc_get_pending_sales` / `rpc_mark_pending_sale_processing` | Pendientes |
| `rpc_create_public_customer` / `rpc_search_public_customer` | Clientes de venta publica |
| `rpc_add_return_credit` / `rpc_add_customer_credit` | Creditos |
| `rpc_get_local_orders`, `rpc_get_local_order_items`, `rpc_create_local_order`, `rpc_update_local_order`, `rpc_delete_local_order`, `rpc_load_local_order_to_sale` | Pedidos locales |

Detalle: [[18-AUDITORIA-MODULO-PUBLIC-SALES]].

## Carrito

Flujo vivo según [[19-AUDITORIA-MODULO-CLIENTE-CARRITO]]:

- `index.html` carga `scripts/cart-persistent.js`.
- `client/dashboard.html` carga `scripts/cart-persistent.js` y `client/dashboard-instant.js`.
- Checkout real: `rpc_checkout_cart(uuid,jsonb)` desde `client/dashboard-instant.js`.
- El carrito usa inserts/upserts directos a `carts` y `cart_items` (via `scripts/cart-persistent.js`), no RPCs de carrito legacy.

### RPCs de carrito legacy (no usadas en flujo vivo)

Estas RPCs existen en el repo y posiblemente en Supabase, pero **no son llamadas por el flujo principal actual**. Revisar grants antes de cualquier operación de seguridad. Ver [[09-TABLAS-COLUMNAS-DUDOSAS-O-LEGACY]] y [[13-RPCS-DEPLOY-STATE]].

| RPC / Función | Definida en | Clasificación | Riesgo |
|---|---|---|---|
| `rpc_get_or_create_cart` | `scripts/cart.js` (no cargado por index) | LEGACY | Bajo si no tiene grants amplios |
| `rpc_reserve_item` | `scripts/cart.js` (no cargado por index) | LEGACY | Bajo si no tiene grants amplios |
| `rpc_submit_cart` | `scripts/cart.js` (no cargado por index) | LEGACY | Bajo si no tiene grants amplios |
| `get_user_cart` | `08_cart_items_flexible_fixed.sql` | LEGACY / REVISAR GRANTS | ALTO si tiene `EXECUTE TO authenticated` |
| `get_cart_items_simple` | `08_cart_items_flexible_fixed.sql` | LEGACY / REVISAR GRANTS | ALTO si tiene `EXECUTE TO authenticated` |
| `clear_cart_items` | `08_cart_items_flexible_fixed.sql` | LEGACY / REVISAR GRANTS | ALTO — puede vaciar carrito ajeno si grants son amplios |
| `add_cart_item` | `08_cart_items_flexible_fixed.sql` | LEGACY / REVISAR GRANTS | ALTO si tiene `EXECUTE TO authenticated` |
| `rpc_update_cart_item_quantity` | `124_rpc_update_cart_item_quantity.sql` | DUDOSA — posible API externa | Verificar si hay consumidor fuera del JS auditado |

**Verificación pendiente (FASE 4):** consultar grants reales con la query de `information_schema.routine_privileges` en [[13-RPCS-DEPLOY-STATE]].

## Clientes, colaboradores, compras y estadisticas

| RPC | Area |
|---|---|
| `rpc_link_or_create_customer` | Cliente/carrito/perfil |
| `rpc_link_public_sales_customer` | Vinculo cliente web con public sales |
| `rpc_create_admin_customer`, `rpc_update_admin_customer`, `rpc_delete_admin_customer` | Admin customers/order creator |
| `rpc_bulk_create_customers` | Imports |
| `is_super_admin` | Permisos |
| `create_collaborator_with_account`, `add_collaborator_to_admins`, `add_collaborator_by_email` | Colaboradores |
| `purchase_create_rule_version`, `purchase_register_receipt` | Compras/proveedores |
| `get_dashboard_kpis`, `get_customer_kpis`, `get_sales_timeseries`, `get_top_*` | Estadisticas |

## Enlaces

- [[13-RPCS-DEPLOY-STATE]]
- [[15-OBSERVACIONES-PRODUCTS-A-REVISAR]]
- [[99-AUDITORIA-DOCUMENTACION]]
