# 03 — Flujos: pedidos, stock, venta pública (FYL)

> Alineado a `docs/STOCK_GOVERNANCE.md`, `supabase/canonical/10_checkout_flow.sql`, `124_*`, `174_*`, y patrones en `admin/order-creator.js` / `client/dashboard-instant.js`. Donde haya múltiples rutas, se indica.

## 1. Checkout cliente (B2B)

1. `cart_items` bajo el `carts` del `customer` autenticado.
2. Cliente llama `rpc_checkout_cart(p_operation_id, p_request jsonb)` — ver [[05-IDEMPOTENCIA-RPC-OPERATIONS]], [[04-RPCS-CRITICAS]].
3. El servidor: valida `variant_id` por línea, bloquea carrito, descuenta stock por talle/depósito (delegación a lógica en `124` / base `10_checkout_flow`), genera/actualiza `orders` y `order_items` (+ fuentes de stock), vacía el carrito.
4. Cada ítem de carrito **debe** tener `variant_id` no nulo; si no, error explícito en flujo (ver [[19-AUDITORIA-MODULO-CLIENTE-CARRITO]] §11).

**Pedido “activo”** típico: `orders.status` en `active` | `closing_soon` | `closed` (según reglas de negocio) hasta cierre o envío.

## 2. Carrito

- Persistencia en `carts` / `cart_items` con RLS; merge localStorage al login.
- Reserva vía lógica de negocio y `reserved_qty` / fuentes: ver [[06-RESERVED-QTY-Y-RECONCILE]] (vista `cart_reserved` en 175 comenta suma de `cart_items` abiertas).

## 3. Pedido activo (cliente) vs admin

| Vista cliente | Técnico |
|---------------|---------|
| “Mi pedido” | `orders` + `order_items` filtrado por `customer_id`, estados no enviados/cancel |
| Líneas con cantidad | `order_items.status` entre `pending`, `picked`, `missing`, `waiting`, etc. |

**admin_confirmed_missing / “manual confirmado”:** ítem en `missing` (u otro) pero con bandera de confirmación manual — el **cliente** lo ve como “confirmado” a efectos de copy/resumen; el **stock** sigue reglas de negocio. Detalle de copy en `dashboard-instant.js` (funciones de contadores/resumen) y comentarios en [[08-UI-CANONICA-Y-FALLBACKS]].

**Missing “real”:** sin stock; no debe mostrarse como “disponible”.

## 4. Apartado, picked, waiting

- **Descuento de stock (admin al confirmar / preparar):** `rpc_apply_order_stock_deduction` con items `variant_id` + talle + `warehouse_id` (ver 166, [[04-RPCS-CRITICAS]]).
- **Marcar líneas en picked (admin):** `rpc_mark_order_items_picked` con `p_operation_id` (177, idempotente).
- **Estados** `waiting` / `picked` / etc.: en `order_items` y lógica de `orders.js` / negocio (ver [[17-AUDITORIA-MODULO-ORDERS]] si hace falta mapeo fino). *Pendiente de verificación:* lista exacta de transiciones en una sola tabla SQL.

## 5. stock_pending (admin)

- Estado de **pedido** `stock_pending` cuando, tras un fallo al aplicar stock, el sistema no puede garantizar coherencia y se marca en `orders` para intervención (ver comentarios en `admin/order-creator.js` ~3433+).
- No es un estado de *producto* `pending_stock` (aunque `products.status` puede usar `pending_stock` para carga — ver gobernanza).

## 6. Cancelaciones y devoluciones

- **Cancelar ítem / devolver stock:** RPCs de cancelación (familia `126`, `85`, etc. según evolución) — al cancelar, se eliminan o ajustan filas y `order_item_stock_sources` según lógica actual.
- **Devolución de pedido:** `rpc_mark_order_as_devolucion` con idempotencia fuerte (172, operaciones).

## 7. Venta pública (POS)

- Crear: `rpc_create_public_sale` (171+).
- Anular: `rpc_void_public_sale` (170+).
- Ambas con `p_operation_id` y replay (ver [[05-IDEMPOTENCIA-RPC-OPERATIONS]]).

## 8. Envío a “local” (si aplica al tenant)

- RPCs bajo `18_local_orders.sql` / 142+ (`rpc_send_order_to_local`, idempotente). Bloquea si el pedido está en `stock_pending` (ver 142 comentario condicional).

## Enlaces

- [[02-MODELO-STOCK-ACTUAL]] · [[04-RPCS-CRITICAS]] · [[05-FLUJO-PEDIDOS]] (vault legado) · [[19-AUDITORIA-MODULO-CLIENTE-CARRITO]]
