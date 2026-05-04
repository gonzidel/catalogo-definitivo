# 09 - Tablas, columnas y piezas dudosas o legacy

Principio: no borrar nada sin proceso aparte. Esta nota clasifica evidencia detectada en repo y la relaciona con las auditorias modulares.

## RPCs o funciones sin llamada viva clara

| Item | Evidencia | Clasificacion |
|---|---|---|
| `rpc_update_cart_item_quantity` | EXECUTE confirmado a `anon`, `authenticated` y `PUBLIC` (FASE 4 — 2026-05-04). | **ALTO — revocar grants (FASE 6/7)** |
| `rpc_get_or_create_cart` | EXECUTE confirmado a `anon`, `authenticated` y `PUBLIC` (FASE 4). Aparece en `scripts/cart.js` no cargado por `index.html`. | **ALTO — revocar grants (FASE 6/7)** |
| `rpc_reserve_item` | EXECUTE confirmado a `anon`, `authenticated` y `PUBLIC` (FASE 4). Puede reservar stock sin flujo canónico. | **ALTO — revocar grants (FASE 6/7)** |
| `rpc_submit_cart` | EXECUTE confirmado a `anon`, `authenticated` y `PUBLIC` (FASE 4). Checkout alternativo legacy que NO descuenta stock correctamente. | **CRÍTICO — revocar grants (FASE 6/7)** |
| `get_user_cart`, `get_cart_items_simple`, `clear_cart_items`, `add_cart_item` | Definidas como `SECURITY DEFINER`; EXECUTE confirmado a `anon`, `authenticated` y `PUBLIC` (FASE 4 — 2026-05-04). | **CRÍTICO — revocar grants (FASE 6/7)** |
| `get_meta_feed` | Definida en SQL; sin llamada JS detectada en esta auditoria. | DUDOSA |
| `rpc_set_transport_before_close` | Definida en SQL; sin llamada JS detectada en esta auditoria. | DUDOSA |
| `rpc_remove_missing_order_item` | Definida en SQL; no aparece como llamada en JS principal. | DUDOSA |

## Rutas de carrito

| Ruta | Estado | Nota |
|---|---|---|
| `scripts/cart-persistent.js` | ACTIVA | Flujo vivo de catalogo/sticky cart. Ver [[19-AUDITORIA-MODULO-CLIENTE-CARRITO]]. |
| `client/dashboard-instant.js` | ACTIVA | Carga carrito y ejecuta checkout con `rpc_checkout_cart(uuid,jsonb)`. |
| `client/cart.html` + `client/cart.js` | **DECISION TOMADA — PENDIENTE IMPLEMENTAR** | No usa `rpc_checkout_cart`; su checkout solo marca `carts.status = pending` sin crear pedido ni descontar stock. **Decisión 2026-05-04:** debe redirigirse al dashboard o eliminarse. No debe mantenerse como checkout funcional separado. Implementación exacta (redirección JS, HTTP redirect, o eliminación de archivos) se define en FASE 6 del roadmap. Ver [[11-DECISIONES-TECNICAS]] §D5. |
| `client/cart-fixed.js` | DUDOSA | Variante corregida de `client/cart.js`, no detectada como cargada por `client/cart.html`. |
| `scripts/cart.js` | LEGACY / ruta no principal | Contiene RPCs viejas de carrito (`rpc_get_or_create_cart`, `rpc_reserve_item`, `rpc_submit_cart`). No es cargado por `index.html`. |

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
