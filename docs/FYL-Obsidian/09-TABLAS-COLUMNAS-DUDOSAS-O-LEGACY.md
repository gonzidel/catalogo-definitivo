# 09 - Tablas, columnas y piezas dudosas o legacy

Principio: no borrar nada sin proceso aparte. Esta nota clasifica evidencia detectada en repo y la relaciona con las auditorias modulares.

## RPCs o funciones sin llamada viva clara

| Item | Evidencia | Clasificacion |
|---|---|---|
| `rpc_update_cart_item_quantity` | Existe `supabase/canonical/124_rpc_update_cart_item_quantity.sql`; no se detecto llamada en el flujo vivo JS revisado. | DUDOSA / posible API externa |
| `rpc_get_or_create_cart` | Aparece en `scripts/cart.js`, que no es cargado por `index.html`. | LEGACY / ruta no principal |
| `rpc_reserve_item` | Aparece en `scripts/cart.js`, que no es cargado por `index.html`. | LEGACY / ruta no principal |
| `rpc_submit_cart` | Aparece en `scripts/cart.js`, que no es cargado por `index.html`. | LEGACY / ruta no principal |
| `get_user_cart`, `get_cart_items_simple`, `clear_cart_items`, `add_cart_item` | Definidas como `SECURITY DEFINER` en SQL viejo de carrito; no aparecen en flujo vivo principal. | LEGACY / revisar grants |
| `get_meta_feed` | Definida en SQL; sin llamada JS detectada en esta auditoria. | DUDOSA |
| `rpc_set_transport_before_close` | Definida en SQL; sin llamada JS detectada en esta auditoria. | DUDOSA |
| `rpc_remove_missing_order_item` | Definida en SQL; no aparece como llamada en JS principal. | DUDOSA |

## Rutas de carrito

| Ruta | Estado | Nota |
|---|---|---|
| `scripts/cart-persistent.js` | ACTIVA | Flujo vivo de catalogo/sticky cart. Ver [[19-AUDITORIA-MODULO-CLIENTE-CARRITO]]. |
| `client/dashboard-instant.js` | ACTIVA | Carga carrito y ejecuta checkout con `rpc_checkout_cart(uuid,jsonb)`. |
| `client/cart.html` + `client/cart.js` | ACTIVA o accesible, pero divergente | No usa `rpc_checkout_cart`; marca `carts.status = pending`. Revisar si debe seguir disponible. |
| `client/cart-fixed.js` | DUDOSA | Variante corregida, no detectada como cargada por `client/cart.html`. |
| `scripts/cart.js` | LEGACY / ruta no principal | Contiene RPCs viejas de carrito. |

## Multiples definiciones SQL

| Funcion | Estado |
|---|---|
| `rpc_checkout_cart` | Muchas versiones historicas. Segun auditoria actual, firma viva JS: `rpc_checkout_cart(uuid,jsonb)`, wrapper `174`, delega en firma interna. |
| `rpc_create_public_sale` | Muchas versiones historicas. Ver [[18-AUDITORIA-MODULO-PUBLIC-SALES]]. |
| `rpc_void_public_sale` | Muchas versiones historicas. Ver [[18-AUDITORIA-MODULO-PUBLIC-SALES]]. |

Nota: el usuario confirmo que los SQL analizados ya estan cargados y activos en Supabase. El riesgo aqui es que el repo conserva historia que puede confundir futuras modificaciones.

## Columnas/flags

- `order_items.admin_confirmed_missing`: no legacy. Se usa para flujo manual y UI de "Apartado manual" / "Falta manual". Ver [[04-FLUJO-STOCK]] y [[17-AUDITORIA-MODULO-ORDERS]].
- `price_snapshot` en `cart_items`: activo, pero sensible. Puede venir desde frontend; revisar que checkout recalcule precio desde DB. Ver [[19-AUDITORIA-MODULO-CLIENTE-CARRITO]].
- `stock_qty` en `variant_sizes`: derivado; no escribir directo. Ver [[16-AUDITORIA-MODULO-STOCK]].

## Enlaces

- [[03-MAPA-DE-RPCS]]
- [[15-OBSERVACIONES-PRODUCTS-A-REVISAR]]
- [[19-AUDITORIA-MODULO-CLIENTE-CARRITO]]
- [[99-AUDITORIA-DOCUMENTACION]]
