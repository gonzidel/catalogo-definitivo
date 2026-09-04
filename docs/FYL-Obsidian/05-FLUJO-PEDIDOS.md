# 05 - Flujo de pedidos

Esta nota resume pedidos. Para la auditoria real del modulo, ver [[17-AUDITORIA-MODULO-ORDERS]]. Para el origen cliente/carrito, ver [[19-AUDITORIA-MODULO-CLIENTE-CARRITO]].

## Pedido cliente desde carrito/dashboard

1. El catalogo y dashboard usan `scripts/cart-persistent.js` para carrito persistente/localStorage/Supabase.
2. `client/dashboard-instant.js` carga el carrito abierto desde `carts` y `cart_items`.
3. Al confirmar, genera o reutiliza `operation_id`.
4. Llama `rpc_checkout_cart(p_operation_id, p_request)`.
5. La firma nueva `rpc_checkout_cart(uuid,jsonb)` valida `auth.uid()`, usa idempotencia fuerte, bloquea el carrito activo y delega a `rpc_checkout_cart()` interna.
6. La firma interna descuenta stock por talle/deposito, crea o reutiliza `orders`, inserta `order_items`, registra `order_item_stock_sources` y vacia el carrito.

### Plazo retiro local (36 h) — stock diferido (309)

Clientes en **Resistencia, Barranqueras, Puerto Vilelas o Fontana** (Chaco):

1. **Checkout** (`rpc_checkout_cart`): valida stock disponible pero **no lo descuenta**. Ítems → `awaiting_apartado`. `orders.local_deferred_pickup = true`, `dismantle_at` y `expires_at` = NULL.
2. **Cliente** (`ActiveOrderTab`): spinner + copy “todavía no fue apartado”; **sin countdown** hasta apartado.
3. **Admin retiro** (`/nj/admin/retiro`, Kanban `scope=local_pickup`): pedidos con transporte Retira local / Retiro de Local, `local_deferred_pickup`, o geo del dashboard (`isDashboardRetiroLocalZone`: Chaco especial + Corrientes Capital), aunque el customer tenga un `transport_id` viejo tipo MyM. Botón Apartar → `rpc_mark_order_items_picked` descuenta stock, crea `order_item_stock_sources`, pasa a `picked`. En el **primer** apartado del pedido: `dismantle_at := fn_compute_local_pickup_deadline(now())`, `expires_at := dismantle_at - 12 h`.
   - En la columna **Apartados** del Kanban NJ de Retiro, el botón **"Local" / "Depósito"** solo mueve entre `/nj/admin/orders` y `/nj/admin/retiro` mediante `orders.notes.kanban_scope` (no envía a `admin/public-sales.html`).
   - **Espera en Zona (312):** ítems `awaiting_apartado` pueden marcarse ⏳ (Fábrica / **Depósito** en Retiro). `rpc_mark_order_item_waiting_source` guarda depósito preferido en `order_item_stock_sources` con `order_items.deferred_stock_pending = true` **sin** descontar stock. Al confirmar ✓ en columna **Espera**, `fn_commit_deferred_order_item_stock` descuenta **solo** del depósito elegido y pasa a Apartados. Cancelar/quitar ítems con `deferred_stock_pending` no devuelve stock fantasma.
   - **UI Espera Depósito (Retiro):** tarjetas/etiquetas **moradas** (pendiente confirmación del depósito), distinto del verde **Local** en Pedidos. Esos pedidos también aparecen en **Pedidos → Espera** (morado) para que el área confirme con ✓.
   - **UI Espera Local (Pedidos):** tarjetas/etiquetas **verdes** (depósito venta-publico). Esos pedidos también aparecen en **Retiro → Espera** (verde) para confirmar o rechazar con ✓/✕ — simétrico al flujo Depósito anterior.
   - **Retiro común** (Margarita Belén, Corrientes, etc.): espera igual que Pedidos — stock ya descontado en checkout.
4. **Sin stock antes de apartar**: `fn_refresh_awaiting_apartado_availability` / `rpc_refresh_my_order_availability` → ítem `missing`.
5. **Maintenance**: pedidos con `dismantle_at IS NULL` no expiran.

`admin/orders.html` (legacy Pedidos) **no lista** el tablero Retiro: ver [[17-AUDITORIA-MODULO-ORDERS]] §17. El Kanban NJ no cambió.

Regla de countdown: 36 h, día hábil siguiente **15:00 AR** (`fn_compute_local_pickup_deadline`, migración `307`).

**Reglas adicionales zona local:** sin mínimo de 4 unidades para cerrar; **sin** botón ni RPC de prórroga 24 h (`308`).

### Mensajes WhatsApp + campana (Retiro, 314)

Tablero **Retiro** (`/nj/admin/retiro`, `scope=local_pickup`) comparte la campana y el borrador **Mensaje / Enviar** de Pedidos (mobile y desktop).

| Tipo de pedido | Criterio | Textos |
|---|---|---|
| **Normal en Retiro** | sin `local_deferred_pickup` | Idénticos a Pedidos (`fn_build_customer_status_message`) |
| **Local diferido** | `local_deferred_pickup = true` | Template retiro + plazo (`fn_build_retiro_local_customer_status_message`) |

**Flujo espera → campana (igual Pedidos):**

1. Activos: marcar ✓ / ⏳ / ✕ y **Confirmar** con ítem en espera Depósito (o Fábrica solo en local diferido) → **no** mensaje inmediato; `rpc_upsert_admin_local_wait_snapshot` guarda `prior_confirmed_count`, `prior_missing_labels`, `waiting_*_item_ids`.
2. Columna **Espera**: resolver ✓ o ✕ → `rpc_record_admin_local_wait_resolution` por ítem.
3. Al resolver el **último** ítem en espera → INSERT en `admin_order_message_notifications` con mensaje **completo** (prior + resoluciones).

Frontend: `nj/lib/orders/customer-status-message.ts`, `local-wait-notifications.ts`, `OrderMessageBell` filtrado por `orderBelongsOnKanban` + `isCustomerSourcedOrder`. Migración: `314_retiro_local_message_templates.sql` (**aplicada en fyl-core prod, 2026-09-01**).

**Regla campana (espera / por vencer / retiro y envíos):** solo pedidos **auto-gestionados por la clienta** (`isCustomerSourcedOrder` / `fn_order_is_customer_self_managed`). Pedidos `admin` / `pau` / `nj/admin*` → sin snapshot ni `local_wait_resolved` ni aviso expiry en campana. Migración **322 aplicada** en fyl-core 2026-09-03.

Pedidos activos creados **antes** de 309 (stock ya descontado al checkout) siguen reglas viejas hasta cerrar/expirar.

Riesgo documentado: `price_snapshot` llega desde frontend y debe tratarse como dato no confiable salvo que DB recalcule precio final. Ver [[19-AUDITORIA-MODULO-CLIENTE-CARRITO]] y [[15-OBSERVACIONES-PRODUCTS-A-REVISAR]].

## Ruta legacy de carrito

`client/cart.html` carga `client/cart.js`. Esa ruta lee/escribe `carts` y `cart_items` directo y su boton de checkout marca `carts.status = pending`, sin pasar por `rpc_checkout_cart`. Si sigue accesible, puede divergir del flujo principal. Ver [[19-AUDITORIA-MODULO-CLIENTE-CARRITO]].

## Pedido admin

- Pantalla principal: `admin/order-creator.js`.
- Crea/selecciona cliente, arma items, reparte cantidades entre `general` y `venta-publico`.
- Descuento automatico: `rpc_apply_order_stock_deduction`.
- Confirmacion manual/faltante: `rpc_admin_manual_inject_and_deduct`.
- Ver [[16-AUDITORIA-MODULO-STOCK]] y [[17-AUDITORIA-MODULO-ORDERS]].

## Pedido local (public-sales) ↔ Kanban Retiro (311 + 313)

Desde `admin/public-sales.html` → Guardar Pedido (`rpc_create_local_order`):

1. Crea `local_orders` + `local_order_items` y **descuenta stock** (venta-publico / general).
2. Espeja en `orders` / `order_items` vía `rpc_mirror_local_order_to_retiro`:
   - `notes.kanban_scope = local_pickup` + `local_deferred_pickup = true` → tablero **Retiro**
   - ítems en `picked` (stock ya descontado) → columna **Apartados**
   - `local_orders.retiro_mirror_order_id` apunta al pedido espejo (**313**)
   - `local_orders.source_order_id` solo si el local viene del Kanban Pedidos (“Desde Pedidos”), no el espejo
3. Los pedidos `local_deferred_pickup` no cuentan para el índice “un pedido abierto por cliente” (313): pueden coexistir con un pedido dashboard.
4. Al finalizar el local (`rpc_create_public_sale` + `status=completed`) se llama `rpc_close_mirrored_retiro_from_local_order` para cerrar el espejo.
5. **Cierre desde Retiro** (`/nj/admin/retiro`, Apartados → Cerrar pedido): `finalizeRetiroOrderSale` en `nj/lib/orders/retiro-finalize-sale.ts` — misma finalización contable que public-sales (`rpc_create_public_sale` + ticket + `daily_sales`), con cliente en `public_sales_customers`, créditos del cliente, extras del pedido local en `notes`, y cierre de `local_orders` si el pedido es espejo de caja.
6. **Un pedido por cliente (318):** el índice `orders_one_open_per_customer_idx` incluye `active`, `closing_soon`, `closed` y **`cancelled`**. Cancelar desde dashboard borra el pedido si no hay stock pendiente; si no, bloquea checkout hasta que admin **Desarmar** en Cancelados.
7. Backfill histórico: `rpc_backfill_pending_local_orders_to_retiro(limit)` (admin) para pending sin espejo.
8. **Enviar desde cerrados al local (nuevo):** en `admin/closed-orders.html` el botón **"Enviar al local"** reabre el pedido en el Kanban NJ de Retiro: setea `orders.notes.kanban_scope = local_pickup` + `orders.notes.retiro_origin = moved_from_closed` y luego revierte `orders.status` a `active` con `rpc_revert_order_to_picked`, para que aparezca en `/nj/admin/retiro` columna **Apartados** con tarjeta naranja.

Migraciones: `311_mirror_local_order_to_retiro.sql`, `313_local_orders_retiro_mirror_fix.sql`. Ver también [[18-AUDITORIA-MODULO-PUBLIC-SALES]].

## Estados de `orders.status`

Estados del pedido cabecera. Las transiciones son realizadas por RPCs o por admin según el flujo.

| Estado | Descripción | Quién lo produce |
|--------|-------------|-----------------|
| `active` | Pedido abierto, en preparación | Checkout cliente (`rpc_checkout_cart`) o creación admin |
| `closing_soon` | Pedido próximo a cerrarse (ventana de cierre activa) | Lógica de ventana / `rpc_close_order` con aviso previo |
| `closed` | Pedido cerrado, listo para despacho | `rpc_close_order` |
| `sent` | Pedido enviado al cliente | `rpc_mark_order_as_sent` |
| `devolución` | Pedido devuelto (total o parcial) | `rpc_mark_order_as_devolucion` |
| `stock_pending` | Fallo al descontar stock en pedido admin; requiere intervención manual | `admin/order-creator.js` (fallback si rollback manual falla) |
| `cancelled` | Pedido cancelado | `rpc_cancel_order_full` o proceso de expiración |
| `expired` | Pedido expirado por ventana de tiempo | Lógica de expiración automática (ver `123_order_expiry_and_notifications.sql`) |

Nota: al pasar a **`sent`**, **`expired`** o **`devolución`** desde un estado no final, la migración **188** (`order_reserved_qty_released` + trigger en `orders`) **resta** de `product_variants.reserved_qty` la suma de `order_item_stock_sources` del pedido (sin tocar stock físico ni borrar fuentes). El drift **histórico** previo a 188 y casos límite (p. ej. expiración con fuentes ya en cero) siguen pudiendo alinearse con **`rpc_reconcile_stock(true)`**. Ver [[06-RESERVED-QTY-Y-RECONCILE]].

Los estados `sent`, `expired` y `devolución` están excluidos del cálculo de reservas activas en `vw_stock_audit_reserved_qty_diff` (175).

## Estados de `order_items`

| Estado | Uso |
|---|---|
| `reserved` | Reservado/base de pedido (stock ya descontado en checkout normal) |
| `awaiting_apartado` | Pedido confirmado, stock **sin** descontar — espera apartado admin retiro local (309). Puede pasar a `waiting` con `deferred_stock_pending` (312) |
| `picked` | Apartado |
| `picked` + `admin_confirmed_missing` | Apartado manual |
| `waiting` | Espera (fábrica o depósito). En zona deferred con `deferred_stock_pending`: stock aún no descontado hasta confirmar en Espera |
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
| Finalizar / enviar (cerrados) | `rpc_mark_order_as_sent` — escribe `sent_at` (desde migración **227**, 2026-05-26) |
| Lista de envíos por día | `rpc_get_shipping_orders`, `rpc_get_shipping_orders_range` |
| Reprogramar fecha envío | `rpc_reschedule_sent_order` |

## Pedidos cerrados y lista de envíos

Pantalla: `admin/closed-orders.html`.

1. **Cerrar** (`rpc_close_order`) → `status = closed`, `closed_at = now()`. Aparece en la grilla de cerrados; **no** en «Imprimir Lista de Envíos».
2. Imprimir rótulos → `labels_printed`.
3. **Finalizar (Enviar)** → `rpc_mark_order_as_sent` → `status = sent`, **`sent_at = now()`**.
4. Lista del día: buscar por transporte y fecha; la RPC filtra solo pedidos `sent` cuya fecha **Argentina** de `sent_at` coincide (sin usar `closed_at`).

Detalle del incidente sábado→lunes y deploy: [[39-LISTA-ENVIOS-SENT-AT-2026-05-26]]. Runbook: `doc/shipping-list-sent-at-deploy-2026-05-26.md`.

## Cierre clienta → campana y confirmación de pago (migración 320)

Cuando la clienta cierra desde `/nj/dashboard` con **todos los productos confirmados**, `rpc_close_order` dispara `rpc_enqueue_customer_closed_notifications`.

**Estado:** migración **320 aplicada** en fyl-core (`dtfznewwvsadkorxwzft`) — 2026-09-02. Patch **321** (solo auto-gestión clienta) aplicado 2026-09-02. Migración **322** (campana local_wait + Pagos solo customer-sourced) aplicada 2026-09-03.

**Regla campana de cierre:** solo pedidos que la clienta auto-gestiona desde su dashboard:
- Cierre directo clienta (`auth.uid() = customer_id`) → sí
- Auto-cierre admin tras `customer_requested_close` (clienta lo inició) → sí
- Cierre manual admin (`orders.html` / botón Cerrar Kanban) → **no** campana; queda `ready`

**Panel Pagos:** misma regla de origen — solo `isCustomerSourcedOrder` / `fn_order_is_customer_self_managed`. Pedidos `admin` / PAU (p. ej. BARRERA vía + Pedido) no deben listarse aunque quede fila residual en `admin_order_payment_pending`. Migración **322 aplicada** 2026-09-03.

| Transporte | Campana Kanban (`OrderMessageBell`) | Bloqueo en `closed-orders.html` | Panel Pagos |
|---|---|---|---|
| MyM, SEDE, Expreso Norte | Sí — mensaje contrarrembolso (tarjeta verde «Cerrado») | No | No |
| MyM/SEDE/Expreso Norte → Pagado (solo este envío) | Descarta aviso COD | No (listo al instante) | No |
| MyM/SEDE/Expreso Norte → Pagado (conservar) | Mensaje transferencia con nombre del transporte | Sí hasta Pagos | Sí |
| Via Cargo, Snaider, Credifin | Sí — mensaje transferencia | Sí hasta confirmar pago | Sí |
| Correo Argentino | Tras cargar costo envío (botón **Correo** en cerrados) | Sí (peso + pago) | Sí, tras mensaje |
| Retira local | Fuera de este flujo | — | — |

**Excepción COD en `closed-orders.html`:** botón «Contra Reembolso» en tarjetas MyM/SEDE/Expreso Norte. Al cambiar a Pagado: *solo este envío* confirma pago y libera finalizar; *conservar* guarda `customers.preferred_payment_method = Pagado` y aplica protocolo Via Cargo (mensaje sigue diciendo SEDE/MyM/etc.).

**Estados** (`orders.closed_fulfillment_status`): `ready` | `awaiting_customer_message` | `awaiting_payment` | `awaiting_correo_cost`.

**RPCs nuevas:** `rpc_complete_customer_closed_notification`, `rpc_set_correo_shipping_cost`, `rpc_confirm_closed_order_payment`, `rpc_list_admin_payment_pending`, `rpc_list_correo_pending_shipping_cost`, `rpc_switch_cod_order_to_pagado`.

**Frontend NJ:** `nj/lib/orders/closed-order-messages.ts`, `OrderMessageBell`, `OrderPaymentsPanel` (botón Pagos en header Kanban).

**Checklist manual por transporte:**
1. Cierre con ítem reservado → sin campana; auto-cierre admin → campana según transporte.
2. MyM/SEDE/Expreso Norte → campana verde; cerrados finalizable de inmediato.
3. Via Cargo → campana transfer; cerrados bloqueado → Pagos Aceptar → desbloqueado.
4. Correo → bloqueado sin campana → modal Correo + costo → campana → Pagos → desbloqueado.
5. Enviar y aceptar en Pagos: confirma pago + WhatsApp + sale del panel.
6. MyM con botón Contra Reembolso → Pagado solo este envío → finalizar sin Pagos.
7. MyM con botón → Pagado conservar → campana transfer (texto SEDE/MyM) + Pagos.

## Cruces

- Stock: [[04-FLUJO-STOCK]], [[16-AUDITORIA-MODULO-STOCK]]
- Carrito: [[19-AUDITORIA-MODULO-CLIENTE-CARRITO]]
- Public Sales/local orders: [[18-AUDITORIA-MODULO-PUBLIC-SALES]]
- Observaciones: [[15-OBSERVACIONES-PRODUCTS-A-REVISAR]]
- Lista envíos / `sent_at`: [[39-LISTA-ENVIOS-SENT-AT-2026-05-26]]
