# 05 - Flujo de pedidos

Esta nota resume pedidos. Para la auditoria real del modulo, ver [[17-AUDITORIA-MODULO-ORDERS]]. Para el origen cliente/carrito, ver [[19-AUDITORIA-MODULO-CLIENTE-CARRITO]].

## Pedido cliente desde carrito/dashboard

1. El catalogo y dashboard usan `scripts/cart-persistent.js` para carrito persistente/localStorage/Supabase.
2. `client/dashboard-instant.js` carga el carrito abierto desde `carts` y `cart_items`.
3. Al confirmar, genera o reutiliza `operation_id`.
4. Llama `rpc_checkout_cart(p_operation_id, p_request)`.
5. La firma nueva `rpc_checkout_cart(uuid,jsonb)` valida `auth.uid()`, usa idempotencia fuerte, bloquea el carrito activo y delega a `rpc_checkout_cart()` interna.
6. La firma interna descuenta stock por talle/deposito, crea o reutiliza `orders`, inserta `order_items`, registra `order_item_stock_sources` y vacia el carrito.

Riesgo documentado: `price_snapshot` llega desde frontend y debe tratarse como dato no confiable salvo que DB recalcule precio final. Ver [[19-AUDITORIA-MODULO-CLIENTE-CARRITO]] y [[15-OBSERVACIONES-PRODUCTS-A-REVISAR]].

## Ruta legacy de carrito

`client/cart.html` carga `client/cart.js`. Esa ruta lee/escribe `carts` y `cart_items` directo y su boton de checkout marca `carts.status = pending`, sin pasar por `rpc_checkout_cart`. Si sigue accesible, puede divergir del flujo principal. Ver [[19-AUDITORIA-MODULO-CLIENTE-CARRITO]].

## Pedido admin

- Pantalla principal: `admin/order-creator.js`.
- Crea/selecciona cliente, arma items, reparte cantidades entre `general` y `venta-publico`.
- Descuento automatico: `rpc_apply_order_stock_deduction`.
- Confirmacion manual/faltante: `rpc_admin_manual_inject_and_deduct`.
- Ver [[16-AUDITORIA-MODULO-STOCK]] y [[17-AUDITORIA-MODULO-ORDERS]].

## Estados de `order_items`

| Estado | Uso |
|---|---|
| `reserved` | Reservado/base de pedido |
| `picked` | Apartado |
| `picked` + `admin_confirmed_missing` | Apartado manual |
| `waiting` | Espera, usado para flujo ligado a deposito venta-publico/local |
| `missing` | Falta |
| `missing` + `admin_confirmed_missing` | Falta manual |
| `cancelled` | Cancelado |

## RPCs frecuentes

| Accion | RPC |
|---|---|
| Checkout cliente | `rpc_checkout_cart(uuid,jsonb)` |
| Cerrar pedido | `rpc_close_order` |
| Reabrir pedido | `rpc_reopen_order` |
| Cancelar item cliente | `rpc_cancel_order_item`, `rpc_cancel_order_item_units` |
| Borrar pedido vacio | `rpc_delete_empty_order` |
| Picking admin | `rpc_mark_order_items_picked`, `rpc_update_order_item_status`, `rpc_split_order_item_status` |
| Quitar/restaurar stock | `rpc_remove_order_item_restore_stock` |
| Cancelar pedido completo | `rpc_cancel_order_full` |
| Enviar a local | `rpc_send_order_to_local` |

## Cruces

- Stock: [[04-FLUJO-STOCK]], [[16-AUDITORIA-MODULO-STOCK]]
- Carrito: [[19-AUDITORIA-MODULO-CLIENTE-CARRITO]]
- Public Sales/local orders: [[18-AUDITORIA-MODULO-PUBLIC-SALES]]
- Observaciones: [[15-OBSERVACIONES-PRODUCTS-A-REVISAR]]
