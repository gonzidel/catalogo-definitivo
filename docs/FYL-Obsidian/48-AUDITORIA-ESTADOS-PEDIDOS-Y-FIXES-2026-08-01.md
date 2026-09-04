# 48 — Auditoría estados de pedidos/ítems (cliente + admin) y fixes aplicados (2026-08-01)

Ver también: [[46-NJ-KANBAN-PEDIDOS-ADMIN-2026-07-15]], [[47-VENCIMIENTO-PEDIDOS-DIA-HABIL-2026-08-01]], [[06-RESERVED-QTY-Y-RECONCILE]], [[03-FLUJO-PEDIDOS-Y-STOCK]].

## Alcance

Auditoría solicitada sobre cómo se manejan los estados de pedidos/ítems (activo, cerrado, cancelado, reservado, apartado, en espera, sin stock) en tres capas:

- Kanban nuevo (`nj/dashboard?tab=cart` cliente + `nj/admin/orders` admin).
- Admin legacy (`admin/orders.js`, `admin/order-creator.js`, `admin/orders-ops.js`, `admin/pau.js`).
- SQL canónico (`orders_status_check`, trigger 188, `rpc_orders_daily_maintenance`).

Se verificó en vivo (solo lectura) contra producción (`fyl-core` / `dtfznewwvsadkorxwzft`) antes de tocar nada.

## Hallazgo crítico 1 — `stock_pending` fuera del `CHECK` de `orders.status`

La migración `235_fix_rpc_customer_cancel_order.sql` reescribió `orders_status_check` sin incluir `'stock_pending'`, aunque tanto `admin/order-creator.js` (`createNewOrder`/`addItemsToExistingOrder`) como `nj/lib/supabase/order-create.ts`/`order-edit.ts` siguen escribiendo ese status cuando falla el descuento de stock al crear/editar un pedido. Cualquier caso real de falla de stock explotaba con violación de constraint en vez de dejar el pedido visible en "Stock Pendiente".

**Fix aplicado (producción, aprobado explícitamente):** `supabase/canonical/259_orders_status_check_readd_stock_pending.sql` — recrea el constraint incluyendo `stock_pending`. Verificado post-deploy:

```sql
CHECK ((status = ANY (ARRAY['active','closing_soon','closed','sent','expired','devolución','cancelled','stock_pending'])))
```

## Hallazgo crítico 2 — choque de `reserved_qty` en el vencimiento automático

`rpc_orders_daily_maintenance()` (migración `257`) vaciaba `order_item_stock_sources` **antes** de marcar `orders.status = 'expired'`, y encima sumaba mal `reserved_qty` a mano. El trigger `trg_orders_release_reserved_qty_on_final_status` (migración 188), que debería liberar `reserved_qty` al llegar a un status final, se disparaba con las fuentes ya en 0 — no encontraba nada que liberar. Esto pasó de ser casi latente a activo el mismo día, porque el cron de mantenimiento (`255_pg_cron_orders_maintenance.sql`, ver [[47-VENCIMIENTO-PEDIDOS-DIA-HABIL-2026-08-01]]) recién se reactivó y ahora corre cada 15 minutos.

**Fix aplicado (producción, aprobado explícitamente):** `supabase/canonical/260_fix_orders_daily_maintenance_reserved_qty_release_order.sql`:

1. Elimina el `UPDATE product_variants SET reserved_qty = reserved_qty + sum_qty` erróneo (duplicaba la liberación / la hacía en la dirección equivocada).
2. Captura una vez el array de pedidos elegibles a vencer (`v_expiring_order_ids`) antes de mutar nada, en vez de re-derivar elegibilidad a mitad de bloque.
3. Reordena: primero marca `order_items`/`orders` como `expired` (esto dispara el trigger 188 con `order_item_stock_sources` todavía con `qty > 0`, permitiéndole liberar `reserved_qty` correctamente), **recién después** pone `qty = 0` y borra esas filas de `order_item_stock_sources`.

**Estado del drift tras el fix:** el fix solo evita que se siga generando drift nuevo en cada corrida del cron. `SELECT count(*) FROM vw_stock_audit_reserved_qty_diff` post-deploy (antes de reconciliar) dio **945** filas — significativamente más alto que el baseline de 246/249 (555, ver [[06-RESERVED-QTY-Y-RECONCILE]] §246). El drift histórico acumulado **ya se reconcilió el mismo día** con aprobación explícita del usuario: `SELECT public.rpc_reconcile_stock(true)` corrigió las 945 filas (944 eran `reserved_qty_inflated` = stock bloqueado sin motivo, 1 sola `deflated`), dejando `remaining_diffs = 0`. Detalle completo en [[06-RESERVED-QTY-Y-RECONCILE]] §260.

## Hallazgo alto — estados fantasma en el Kanban nuevo (`nj`)

`nj/types/orders.ts` no tipaba `closing_soon` ni `expired`, pero en producción hay pedidos reales en esos estados (1 `closing_soon`, 3 `expired` al momento de la auditoría). `getOrderKanbanColumn()` no tenía guard explícito para estados terminales: un pedido que llegara a `expired`/`sent`/`devolución` vía realtime (`patchOrder`) mientras ya estaba en memoria en el store del admin podía no matchear ninguna columna (`null`) o, peor, clasificar mal si conservaba algún ítem con status residual.

**Fix aplicado (código, `nj/`):**

- `nj/types/orders.ts` — se agregó `closing_soon` a `OrderStatus`, `expired` a `OrderStatus` y a `OrderItemStatus`.
- `nj/lib/orders/classification.ts` — nueva función exportada `isFinalOrderStatus(order)` (normaliza `sent`/`devolución`/`devolucion`/`expired`), usada como guard al inicio de `getOrderKanbanColumn()` (retorna `null` de una sola vez para estados terminales) y en `matchesActiveTab`/`matchesWaitingTab`/`matchesPickedTab`/`isExpiredPendingAdminDisassembly` (antes comparaban `order.status` sin normalizar y sin cubrir `devolucion` sin tilde ni `expired` de forma consistente entre las cuatro funciones). También se corrigió `hasItemsNeedingAttention` para usar `norm(item.status)` en vez de comparación directa.
- `nj/lib/supabase/order-queries.ts` (`fetchOrdersInitial`) — el filtro `.not("status", "in", ...)` no excluía `devolucion` (sin tilde) ni `expired`; ahora excluye los cuatro estados terminales del fetch inicial del Kanban.
- `nj/hooks/useOrders.ts` (`patchOrder`) — el listener realtime de `orders-kanban` no tiene filtro por pedido: cualquier `UPDATE` en la tabla `orders` (de cualquier cliente) dispara `fetchOrderById` + `patchOrder`, que antes simplemente insertaba/actualizaba el pedido en el store sin chequear su status. Un pedido ajeno que pasara a `sent`/`expired`/`devolución` quedaba colgado en memoria indefinidamente (bloat + podía filtrar mal en columnas). Ahora `patchOrder` remueve del store cualquier pedido que llegue en estado terminal.

## Hallazgo alto — definición de "pedido abierto" divergente en admin legacy

- `admin/orders-ops.js` (`OPEN_ORDER_STATUSES`) ya incluía `stock_pending` como "abierto" para el chip visual del PAU.
- `admin/order-creator.js` (`createNewOrder`), en cambio, solo chequeaba `["active","closing_soon","closed"]` antes de crear un pedido nuevo para un cliente — un cliente con un pedido roto en `stock_pending` (sin resolver) podía terminar con un segundo pedido activo sin ningún aviso.

Se verificó que **a nivel de base de datos esto es intencional**: el índice único `orders_one_open_per_customer_idx` (migración `251`) excluye `stock_pending` a propósito, porque representa un pedido roto pendiente de intervención manual, no una reserva vigente — no se puede simplemente "unificar" agregando `stock_pending` al índice sin cambiar la regla de negocio de 251.

**Fix aplicado (código, `admin/order-creator.js`):** se amplió el pre-chequeo de `createNewOrder` a `["active","closing_soon","closed","stock_pending"]`. Si el pedido existente está en `stock_pending`, no se ofrece "agregar al pedido existente" (`addItemsToExistingOrder` ya rechaza pedidos `stock_pending` explícitamente), sino un aviso distinto: "el cliente tiene un pedido en Stock pendiente sin resolver, ¿crear uno nuevo igual?" con opción de cancelar para ir a resolver el original primero.

## Hallazgo medio — filtros de estados finales sin `expired` en admin legacy

`admin/orders.js` tenía tres queries (`loadOrders` sql/client + conteo de badges) que excluían `sent`/`devolución`/`devolucion` pero no `expired`, más una función `FINAL_STATUSES`/varios `if` sueltos con la misma omisión (algunos ni siquiera cubrían `devolucion` sin tilde). `admin/public-sales.js` tenía el mismo patrón en el filtro de ítems `waiting`/`reserved` por pedido (con un valor inexistente `"devolucion_alt"` en vez de la comparación correcta).

**Fix aplicado:**

- `admin/orders.js` — `FINAL_STATUSES` ahora incluye `expired`; se agregó `expired` a las tres queries `.not("status","in",...)`; nueva función `isFinalOrderStatus(order)` centraliza el chequeo y se usa en `isExpiredPendingAdminDisassembly` y en los filtros de las pestañas Espera/Apartados/Activos (antes usaban comparaciones sueltas `order.status === STATUS.SENT` sin normalizar y sin cubrir `devolucion`/`expired` de forma pareja). Se eliminó `WORKFLOW_STATUSES` (constante muerta, sin ningún uso en el archivo).
- `admin/public-sales.js` — el `Set` de estados finales para filtrar ítems `waiting`/`reserved` de pedidos ya cerrados ahora incluye `expired` y se sacó el valor inexistente `devolucion_alt`.

## Verificación

- `npx tsc --noEmit` en `nj/`: sin errores nuevos en los archivos tocados (el único error preexistente, no relacionado, es `DashboardClient.tsx:416` por inferencia de tipos de `auth.getSession()`, fuera de alcance de esta auditoría).
- `node --check` en `admin/orders.js`, `admin/order-creator.js`, `admin/public-sales.js`: sintaxis válida.
- `orders_status_check` en producción confirmado con `stock_pending` incluido (ver arriba).

## Pendiente / no incluido en este cambio

- No se tocó `nj/components/orders/ItemStatusBadge.tsx` ni `OrderCard.tsx`: con el fetch inicial y `patchOrder` ahora excluyendo/expulsando pedidos terminales, un `order_item.status = 'expired'` no debería llegar a renderizarse en el Kanban operativo; si en el futuro se decide mostrar pedidos `expired` en alguna vista de solo lectura (ej. historial), va a hacer falta un label/estilo dedicado ahí.
- No se corrigió la reutilización de `getOrderKanbanColumn` dentro de `matchesActiveTab`/`matchesWaitingTab`/`matchesPickedTab` para quitar los guards de `isFinalOrderStatus` ahora redundantes con el guard global en `getOrderKanbanColumn` — se dejaron a propósito porque esas funciones también podrían llamarse de forma independiente en el futuro.

## Hallazgo crítico 3 — cierre automático post "Enviar pedido" (Caso 9) inconsistente/inseguro

Validación de 9 escenarios hipotéticos de estado de pedido/ítems provistos por el usuario. Casos 1-8 y la devolución de stock por cancelación (reservado/espera → automática, apartado → requiere confirmación admin uno-a-uno o "Desarmar pedido" en bloque vía `rpc_cancel_order_full`) ya se comportaban como se esperaba. El Caso 9 (clienta con ítems mixtos apartados + reservados que presiona "Enviar pedido") expuso tres bugs relacionados:

1. **Flag de cierre no se consumía fuera de "Apartar todos".** Cuando la clienta presiona "Enviar pedido" con ítems `reserved`/`waiting` pendientes, el flujo graba `customer_requested_close: true` en `notes` y dispara la pantalla "En preparación" (`nj/components/cart/ActiveOrderTab.tsx`). Solo la acción admin `pickAllReserved` ("Apartar todos") leía ese flag para cerrar el pedido al terminar. Las acciones individuales (`markItemPicked`, `splitReservedItem`, `splitReservedItemMixed`, `confirmCancelledItem`) lo ignoraban por completo — si el admin resolvía los ítems uno por uno (o vía split) en vez de "Apartar todos", el pedido quedaba parado en Apartados esperando un cierre manual que nunca llegaba solo, contradiciendo lo que la clienta ya había pedido.
2. **Ningún gate a nivel servidor.** `rpc_close_order` (verificado en vivo en `fyl-core`) no valida el estado de los ítems: cierra el pedido aunque tenga `reserved`/`waiting` pendientes. Toda la seguridad de "no cerrar incompleto" dependía 100% del código cliente.
3. **Bug más severo y ya explotable en el propio dashboard del cliente:** `allItemsPicked` en `ActiveOrderTab.tsx` contaba `waiting` como "listo" (`status === "picked" || status === "waiting"`). Si el admin ya había resuelto todos los ítems `reserved` pero dejó alguno en `waiting` (espera local/fábrica, Caso 3), al presionar "Enviar pedido" la clienta cerraba el pedido **directo, sin pasar por el admin**, con un `UPDATE` crudo a la tabla `orders` (bypaseando `rpc_close_order` y sin setear `closed_at`, que `admin/closed-orders.js` usa para reportes) — un pedido con stock todavía no disponible físicamente podía quedar "cerrado" (listo para envío).

**Fix aplicado (código, `nj/`):**

- `nj/lib/orders/domain.ts` — nuevo helper `wantsCustomerClose(order)` (parsea `customer_requested_close` de `notes`).
- `nj/lib/orders/classification.ts` — nuevo helper exportado `shouldAutoCloseAfterCustomerRequest(order)`, que combina `wantsCustomerClose` con un predicado estricto nuevo (`isOrderStrictlyFullyPicked`, privado): todos los ítems no cancelados deben estar literalmente en `picked` — a propósito **no** cuenta `waiting` ni `missing` como "listo" (a diferencia de `hasAllItemsPicked`, que sí los cuenta para decidir en qué columna se ve el pedido). Si queda algo `missing`, el pedido no se cierra solo: el admin tiene que decidir a mano vía el botón "Cerrar pedido" (esto reproduce el comportamiento que el usuario pidió explícitamente para ese sub-caso).
- **Fix 2026-09-02 (A56425):** `isOrderStrictlyFullyPicked` ya no usa `orderHasCancelledItems` (cualquier cancelado bloqueaba el auto-cierre). Solo bloquea `orderHasCancelledItemsPendingStockReturn`. Caso: clienta con `customer_requested_close`, sumó productos, admin apartó todo vía draft/Confirmar → pedía quedar en Cerrados pero quedaba en Apartados por líneas `cancelled` viejas.
- `nj/hooks/useOrders.ts` — nuevo helper interno `refreshAndMaybeAutoClose(supabase, orderId)`: refresca el pedido y, si `shouldAutoCloseAfterCustomerRequest` da `true`, llama a `rpcCloseOrder` antes de devolver el pedido actualizado. Se conectó en `pickAllReserved` (reemplazando la lógica ad-hoc que tenía antes), `markItemPicked`, `splitReservedItem`, `splitReservedItemMixed` y `confirmCancelledItem` (este último importa: si lo único que faltaba era confirmar la devolución de stock de un ítem cancelado, el pedido puede terminar de cerrarse ahí). `markItemMissing`/`markItemWaiting` se dejaron sin cambios a propósito: por diseño nunca van a cumplir el predicado estricto, así que no hace falta ni tiene sentido conectarlos.
- `nj/components/cart/ActiveOrderTab.tsx` — `allItemsPicked` ahora exige `status === "picked"` estrictamente (ya no cuenta `waiting`). El branch de cierre directo de `handleSend()` pasó de un `UPDATE` crudo a `rpcCloseOrder(supabase, order.id, "Pendiente")`, para que quede validado server-side y con `closed_at` seteado igual que cualquier otro cierre.

**Pendiente (requiere aprobación de migración, no aplicado):** blindar `rpc_close_order` a nivel servidor para que rechace cerrar un pedido con ítems `reserved`/`waiting` pendientes (defensa en profundidad — hoy la única barrera es el código cliente recién corregido). No se aplicó porque toca una RPC de checkout/pedidos en producción y requiere el SQL exacto + aprobación explícita antes de correr.

**Verificación:** `npx tsc --noEmit` en `nj/` sin errores nuevos en los archivos tocados (mismo error preexistente y no relacionado de `DashboardClient.tsx:416`).

## Segunda pasada — chequeos adicionales post-fix Caso 9

- **Fix adicional:** `refreshAndMaybeAutoClose` (`nj/hooks/useOrders.ts`) aislaba el intento de `rpcCloseOrder` en el mismo `try` que la acción de apartar/dividir/confirmar — si el cierre fallaba (ej. `rpc_close_order` rechaza por `dismantle_at` ya vencido, ventana chica antes de que corra el cron de mantenimiento cada 15 min), el `catch` externo revertía **también** la acción que sí había tenido éxito en la base. Ahora el intento de cierre tiene su propio `try/catch`: si falla, la acción exitosa se conserva y el pedido simplemente no se auto-cierra.
- **Verificado, sin bug:** `orders.status = 'cancelled'` (cancelación total por la clienta, `rpc_customer_cancel_order`) siempre cancela **todos** los ítems en la misma transacción — nunca puede coincidir con "todo apartado + flag de cierre".
- **Verificado, sin bug:** pedidos en `stock_pending` quedan excluidos de `MY_ORDER_STATUSES` en `DashboardClient.tsx`, así que nunca llegan a `ActiveOrderTab`/`handleSend` ni pueden tener `customer_requested_close` seteado.
- **Verificado, sin bug:** ningún componente de `nj` llama a `rpc_mark_order_items_picked` / `rpc_close_order` / `rpc_split_order_item_status` fuera de `useOrders.ts` y `ActiveOrderTab.tsx` (ambos ya cubiertos por el fix) — no hay otro camino que bypasee el auto-cierre centralizado.
- **Investigado y descartado (confirmado por el usuario):** `admin/orders.js` (panel legacy) tiene su propia implementación de apartar/cerrar pedidos, totalmente ajena al flag `customer_requested_close`. El usuario confirmó que ese panel está deprecado para ese flujo — no hace falta portar el fix ahí.

### Fix 2026-09-03 (A56434) — RLS bloqueaba el flag de cierre

- **Síntoma:** clienta con ítems `reserved` (admin aún no confirmó) tocaba "Cerrar pedido" → salía el modal → al confirmar no pasaba a "En preparación".
- **Causa:** `ActiveOrderTab.handleSend` hacía `.from("orders").update({ notes })`. Customers solo tienen RLS **SELECT** sobre `orders` (no UPDATE). El update fallaba; el flag nunca se grababa.
- **Fix frontend:** llamar `rpc_customer_request_close` (`rpcCustomerRequestClose` en `order-queries.ts`) — SECURITY DEFINER ya presente en fyl-core. Repo: `supabase/canonical/324_rpc_customer_request_close.sql` (documenta la RPC existente).
- **Flujo esperado:** clienta cierra → `customer_requested_close: true` + UI "En preparación" → admin aparta → `refreshAndMaybeAutoClose` → `closed`.

### Nota — label visible vs. status real de un ítem "waiting"

Detalle de negocio confirmado post-fix: la clienta **ve** un ítem interno en `waiting` con el label "Apartado" (espera de fábrica) o "Reservado" (espera de stock local) vía `getCustomerFacingItemStatus` (`nj/lib/orders/waiting-source.ts`) — esto es puramente cosmético (`itemStatusInfo` en `ActiveOrderTab.tsx`), nunca toca `item.status` real. Es clave que `allItemsPicked` compare contra el `status` real y no contra este label remapeado: si comparara contra el label, un ítem en espera de fábrica (mostrado como "Apartado" a la clienta) se contaría como listo para cerrar, reproduciendo el mismo bug que se acaba de corregir. Cuando el admin marca ese ítem `waiting` como `picked` de verdad (mismo botón/acción `markItemPicked` que ya dispara `refreshAndMaybeAutoClose`), el pedido se cierra solo en esa misma llamada si no queda nada más pendiente.

## Incidente 2026-08-03 — `rpc_orders_daily_maintenance()` rota en producción desde el fix de 260

**Detectado** revisando por qué el pedido `A55245` (mostrado por el usuario como "vencido" en el Kanban) seguía con `status='closing_soon'` y sus ítems en `picked`/`reserved`/`cancelled` reales, en vez de `expired`, más de un día después de que venciera su `dismantle_at`.

**Causa raíz:** la migración `260` reescribió el bloque D.3 de `rpc_orders_daily_maintenance()` agregando:

```sql
UPDATE public.order_item_stock_sources s
SET qty = 0
...
```

pero `order_item_stock_sources_qty_check` es `CHECK (qty > 0)` — nunca permite `qty = 0`. En cuanto un pedido real cruzaba su `dismantle_at` con fuentes de stock todavía pobladas (caso normal), ese `UPDATE` violaba el constraint y abortaba la función completa.

**Impacto verificado (solo lectura, `cron.job_run_details`, `jobid=1` = `orders-daily-maintenance`, `*/15 * * * *`):**

- Primer fallo: `2026-08-01 22:15:00 UTC` (mismo ciclo en que `A55245` cruzó su `dismantle_at`, `22:06:13 UTC`).
- Fallando sin parar cada 15 minutos hasta el momento de la corrección (`2026-08-03 ~14:50 UTC`, ~40.5 horas, 163 de 193 corridas fallidas).
- Como toda la función corre en una sola transacción implícita, la excepción hacía rollback de **todo** el intento en cada corrida: no solo D.3 (expirar), sino también D.1 (backfill de fechas), D.2 (`active → closing_soon`) y D.4 (notificaciones outbox) — para **todos** los pedidos, mientras existiera al menos un pedido que disparara el error.
- Blast radius real (verificado): solo `A55245` estaba en la condición de disparo al momento de la corrección (`status IN ('active','closing_soon') AND now() >= dismantle_at`) — ningún otro pedido quedó atascado por esta causa específica. El resto de la lógica de negocio (checkout, cancelación, picking, cierre manual) usa RPCs separadas y no se vio afectado.

**Fix aplicado** (`supabase/canonical/265_fix_orders_daily_maintenance_qty_zero_check_violation.sql`, aprobado y aplicado en producción): se reemplaza el `UPDATE ... SET qty = 0` (inválido contra el constraint) por un `DELETE` directo de esas filas, en el mismo punto del flujo (después de marcar `order_items`/`orders` como `expired`, momento en el que el trigger 188 ya liberó `reserved_qty` correctamente con las fuentes todavía en `qty > 0`). Ningún otro bloque de la función se modificó.

**Verificación post-fix:**

- Se invocó manualmente `SELECT public.rpc_orders_daily_maintenance();` — corrió sin error.
- `A55245` pasó a `status='expired'`, `expired_at` seteado.
- `order_item_stock_sources` para ese pedido quedó en 0 filas (limpieza correcta).
- `SELECT ... WHERE status IN ('active','closing_soon') AND now() >= dismantle_at` da 0 filas — no queda ningún pedido atascado por esta causa.
- Nota aparte (no relacionada a este incidente): `vw_stock_audit_reserved_qty_diff` mostró 125 filas `reserved_qty_inflated` al momento de la verificación — es drift ambiental normal (altas/bajas de carritos desde la última reconciliación con `rpc_reconcile_stock(true)`, documentada en `06-RESERVED-QTY-Y-RECONCILE.md`), no un efecto de este bug puntual (el bug solo bloqueaba la función completa, no generaba drift adicional por sí mismo). Reconciliar de nuevo si se decide, pero no es parte de este fix.

**Rollback:** reaplicar el `CREATE OR REPLACE` de `260` (deja la función en el estado roto anterior; no recomendado).

## Incidente 2026-08-03 (continuación) — stock perdido para ítems cancelados-pendientes al vencer/desarmar

Verificando el fix de 265 se detectó un segundo bug, más profundo, sobre los mismos 3 productos de `A55245` ("GUI Beige 38", "GUI Beige 40", "85 Chocolate 38") que aparecían en la tarjeta con el ✓ pendiente.

**Causa raíz (dos funciones, dos huecos independientes que se combinan):**

1. Cuando un ítem `picked` se cancela individualmente (`rpc_cancel_order_item`), el stock **no** se devuelve automáticamente — queda pendiente de que el admin lo confirme con el botón ✓ (`rpc_remove_order_item_restore_stock`). Mientras tanto, `order_item_stock_sources` conserva la traza de dónde devolver ese stock. Esto es diseño intencional, no un bug.
2. El DELETE final de limpieza en `rpc_orders_daily_maintenance` (bloque D.3, desde 260) borraba las fuentes de **todos** los ítems del pedido que vence, sin filtrar por status — incluyendo los que ya estaban `cancelled` con stock pendiente de (1). Al perder la traza, ni el botón ✓ ni "Desarmar" pueden devolver ese stock nunca más.
3. Separadamente, `rpc_cancel_order_full` ("Desarmar") tampoco procesaba ítems ya `cancelled`, así que aunque las fuentes hubiesen sobrevivido, apretar "Desarmar" sin tocar el ✓ antes también se llevaba el pedido por CASCADE sin devolver ese stock.

**Impacto verificado en `A55245`:** 3 unidades con stock físico nunca devuelto y `reserved_qty` inflado (confirmado con `vw_stock_audit_reserved_qty_diff`: `stored_reserved_qty=2 / real=0` para GUI Beige, `stored_reserved_qty=1 / real=0` para 85 Chocolate).

**Fixes aplicados (producción, aprobados y ejecutados):**

- `supabase/canonical/266_fix_orders_daily_maintenance_preserve_pending_cancelled_sources.sql` — el DELETE de limpieza en D.3 ahora exige `oi.status = 'expired'` (solo limpia fuentes de los ítems que la propia corrida acaba de expirar, nunca las de ítems que ya eran `cancelled` de antes).
- `supabase/canonical/267_rpc_cancel_order_full_resolve_pending_cancelled_items.sql` — nuevo "Pase 0" en `rpc_cancel_order_full`, antes de los pases existentes: resuelve cualquier ítem `cancelled` que todavía tenga `order_item_stock_sources` con `qty > 0`, reusando `rpc_remove_order_item_restore_stock` (la misma función del botón ✓, que no filtra por status cuando hay fuentes). Así "Desarmar" queda seguro aunque el admin no haya confirmado el ✓ de cada ítem antes.
- **Reparación de datos manual para `A55245`** (las fuentes de esos 3 ítems ya se habían borrado antes del fix de 266, así que no había forma de que el sistema las recuperara solo): `+1` a `variant_size_warehouse_stock` de GUI Beige talle 38 (1→2) y talle 40 (15→16), `+1` a 85 Chocolate talle 38 (0→1); `reserved_qty` de ambas variantes bajado a 0; movimiento registrado en `stock_history` (`source='manual_repair_A55245'`) para trazabilidad; los 3 `order_items` ya resueltos se borraron (equivalente a lo que hubiera hecho el botón ✓). Al quedar sin ítems, un trigger existente (`trigger_order_items_after_delete`) borró el pedido completo automáticamente y lo registró en `order_empty_deletion_audit` — comportamiento normal del sistema para pedidos sin ítems operacionales, no algo introducido por esta reparación.

**Verificación post-fix:** `vw_stock_audit_reserved_qty_diff` para ambas variantes: 0 filas (antes: 2 filas `reserved_qty_inflated`).

**Alcance del bug:** acotado a pedidos que combinaban (a) al menos un ítem `picked` cancelado individualmente antes de vencer/desarmarse, con (b) el pedido luego venciendo (D.3) o siendo desarmado sin pasar antes por el ✓. No afecta pedidos sin ítems cancelados-pendientes en ese estado.

**Rollback:** reaplicar 260 (para 266) y 163 (para 267); no recomendado, reabre ambos huecos.

## UI: resumen único para pedidos vencidos pendientes de desarmar (2026-08-03)

Con 266/267 aplicados, "Desarmar" ya resuelve de forma segura tanto los ítems todavía activos como los que ya estaban `cancelled` con stock pendiente. Esto permitió simplificar la tarjeta (`OrderCard.tsx`) para el caso `isExpiredPendingAdminDisassembly`:

- Se eliminó la lista individual con botón ✓ para este caso específico (antes confundía: mostraba "3 productos confirmados a devolver" con un check que no tenía sentido tocar uno por uno cuando "Desarmar" ya lo hace todo junto).
- Se fusionó en **una sola lista de resumen** ("Se devuelve todo el stock al desarmar") los ítems ya cancelados-pendientes + los que seguían reservados/apartados/en espera/sin stock.
- Dentro de ese resumen, `ItemStatusBadge` (prop `muted`) ahora distingue color: **reservado/espera en amarillo** ("nunca se separó físicamente del depósito, es un ajuste de sistema"), el resto (apartado, cancelado, falta) en gris neutro.
- El caso **distinto** (pedido no vencido, con ítems activos + algún ítem cancelado suelto, sin botón "Desarmar" disponible — ver `OrderActions.tsx`) **no se tocó**: ahí el ✓ individual sigue siendo la única forma de resolver esos ítems, y el título "Otros productos del pedido (siguen activos)" sigue aplicando sin mutar a amarillo (son ítems que van a seguir en el pedido, no a devolverse).

Archivos: `nj/components/orders/OrderCard.tsx`, `nj/components/orders/ItemStatusBadge.tsx`, `nj/styles/globals.css` (`.order-item-badge--pending-return`, `.order-card__cancelled-rest-hint`).

## Regla de negocio revisada: "espera" siempre se ve como "Confirmado" al cliente (2026-08-03)

Reportado sobre el pedido A55552 (Gonzalo de la fuente, 2 unidades de GUI Beige en espera, una de depósito y otra de fábrica): la regla anterior (`getCustomerFacingItemStatus`) mostraba "espera local" como **Reservado** y "espera fábrica" como **Confirmado** — el cliente veía dos certezas distintas para dos productos que, desde el admin, ya estaban igual de gestionados (ambos con un `checked_by`/depósito asignado).

Decisión explícita del usuario: **"espera" siempre se ve como Confirmado para el cliente, sin importar el origen** (local o fábrica). El origen (local/fábrica) pasa a ser información 100% interna del admin.

- `nj/lib/orders/waiting-source.ts` — `getCustomerFacingItemStatus(item)` simplificado: `waiting` → siempre `"picked"` (ya no depende de `getWaitingSourceKind`/`warehouseIds`). Se actualizaron los 3 call sites (`DashboardClient.tsx`, `ActiveOrderTab.tsx`, `customer-order-display.ts`) para no pasar `warehouseIds`.
- Efecto: en el dashboard del cliente, dos unidades del mismo producto/talle/precio, una en espera local y otra en espera fábrica, ahora se agrupan en una sola fila "Confirmado" (antes se mostraban separadas, una "Reservado" y otra "Confirmado").

## Admin: columna Espera muestra todos los ítems juntos, diferenciados por etiqueta (2026-08-03)

Antes, cada tarjeta en la columna Espera arrancaba mostrando solo la vista "Local" (`waitingView` hardcodeado a `"local"`) y un botón "Ver fábrica" para cambiar de vista — pero ese botón solo aparecía si el pedido tenía **ambos** orígenes mezclados. Esto causaba dos problemas reales, encontrados sobre A55552:

1. Un pedido con ítems en espera **solo** de fábrica (sin ningún ítem local) se quedaba mostrando "Sin productos en espera (local)" para siempre, sin ninguna forma de ver sus ítems reales (el botón para cambiar de vista nunca aparecía).
2. Aun con el botón disponible, ver solo un origen a la vez escondía productos reales del pedido (el admin reportó "el producto de fábrica desapareció" al cambiar el origen del otro ítem a local).

Fix: se eliminó por completo el concepto de "vista" (`waitingView`, `hasMixedWaiting`, botón "Ver fábrica/local", `filterWaitingItemsByView`). Ahora la columna Espera muestra **todos** los ítems en espera del pedido juntos, cada uno con su propia etiqueta de origen (🟢 Local / 🟡 Fábrica, ver `.order-card__item-origin` en `globals.css`, mismos colores que la leyenda de la columna). El fondo teñido de la tarjeta completa (verde/amarillo) se conserva solo para pedidos con un único origen; si están mezclados, la tarjeta queda neutra y cada ítem se distingue por su propia etiqueta.

Archivos: `nj/components/orders/OrderCard.tsx`, `nj/components/orders/OrderCardItems.tsx` (prop `waitingPickView` → `enableWaitingPick: boolean`), `nj/lib/orders/waiting-source.ts` (`filterWaitingItemsByView` eliminada, sin más usos), `nj/lib/orders/domain.ts` (nuevo helper `isWaitingOrderItem`), `nj/styles/globals.css`.

## Datos: corrección de depósito para A55552 (2026-08-03)

Se corrigió manualmente `order_item_stock_sources` de los 2 ítems en espera de A55552 tras confirmar con el usuario cuál era el origen real de cada uno: GUI Beige T.38 → Almacén General (Fábrica), GUI Beige T.39 → Venta al Público (Local). Cambio de datos puntual, sin impacto en stock (`order_item_stock_sources.qty` no se tocó, solo `warehouse_id`).
