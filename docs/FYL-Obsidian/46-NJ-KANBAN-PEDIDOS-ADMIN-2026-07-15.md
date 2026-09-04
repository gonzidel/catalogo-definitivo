# 46 — Kanban `nj/admin/orders`: cancelados, wizard de reparto, creación manual y mobile — 2026-07-15

## Resumen

Serie de mejoras sobre el tablero Kanban de pedidos en Next.js (`http://localhost:3001/nj/admin/orders`), sobre el modal "Espera" legacy (`admin/public-sales.html`) y sobre el carrito del dashboard cliente (`nj/dashboard?tab=cart`). Objetivo: que el flujo de reservar / apartar / cancelar / crear pedidos manuales sea usable por varios admins en simultáneo, sin perder pedidos "invisibles" en el tablero y sin descuentos/restauraciones de stock inconsistentes.

Complementa: [[41-MIGRACION-NEXTJS-NJ-2026-06-08]] (arquitectura `/nj`), [[43-NJ-DASHBOARD-PRORROGA-CANCELACION-2026-06-09]] (cancelación cliente), [[06-RESERVED-QTY-Y-RECONCILE]] (migraciones 246/249 de `reserved_qty`, mismo trabajo de auditoría de stock que originó esta nota), [[40-PAU-PANEL-ATENCION-UNIFICADO]] (otro front admin de pedidos, no tocado aquí).

**Proyecto Supabase:** `dtfznewwvsadkorxwzft` (fyl-core) — todas las RPCs nuevas están aplicadas en producción (verificado 2026-07-15 vía `information_schema.routines`).

---

## 1. Ítems cancelados por el cliente → columna "Cancelados" en el Kanban

**Problema original:** cuando un cliente quita un producto desde `nj/dashboard?tab=cart`, el `order_item` queda `status = 'cancelled'` (vía `rpc_cancel_order_item`, ver [[06-RESERVED-QTY-Y-RECONCILE]] §246), pero el pedido **desaparecía** del Kanban admin sin aparecer en ninguna columna.

**Causa:** `getOrderKanbanColumn` (`nj/lib/orders/classification.ts`) clasificaba por `hasAllItemsPicked` / `hasItemsNeedingAttention`, que no consideraban ítems `cancelled` como caso aparte.

**Fix:**

- `nj/lib/orders/domain.ts` — nuevos helpers `isCancelledOrderItem`, `getCancelledOrderItems`, `orderHasCancelledItems`.
- `nj/lib/orders/classification.ts` — `matchesCancelledTab()` retorna `true` si `orderHasCancelledItems(order)`; `getOrderKanbanColumn()` tiene un fallback final a `"cancelled"` si el pedido tiene algún ítem cancelado, **incluso si también tiene ítems `picked`** (evita que el pedido desaparezca cuando es mixto).

**UI (`nj/components/orders/OrderCard.tsx` + `OrderCardItems.tsx`):**

- En la columna Cancelados, la tarjeta muestra primero los ítems cancelados (banner + fila con botón **✓** "confirmar/restaurar"), y debajo, en una sección separada (`order-card__cancelled-rest`), el resto de ítems operativos que sigan activos en ese mismo pedido.
- Botón **✓** sobre un ítem cancelado → `confirmCancelledItem` (`nj/hooks/useOrders.ts`) → `rpc_remove_order_item_restore_stock` (140) → restaura stock físico y libera `reserved_qty` (cerrado el gap correspondiente en migración **249**, ver [[06-RESERVED-QTY-Y-RECONCILE]] §249).

---

## 2. Wizard de reparto parcial (picked / espera / falta) para ítems reservados multi-unidad

**Problema:** un ítem de pedido con `quantity > 1` (p. ej. 5 unidades del mismo talle) solo se podía marcar completo como picked/espera/falta. En la práctica el local a veces tiene 2 de 5, o 3 en espera de fábrica y 2 de local.

**Solución:** `nj/components/orders/PartialAcceptModal.tsx` (nuevo) — modal de 1 paso que pregunta cuántas unidades hay disponibles y permite repartir el resto entre **picked / espera (con origen Fábrica o Local) / falta**.

- Se dispara desde `OrderCardItems.tsx` (`isMultiUnitReserved()`) interceptando **✓**, **⏳** y **✕** cuando el ítem reservado tiene `quantity > 1`.
- Aplica el reparto vía `rpc_split_order_item_status` (129) → `splitReservedItem` en `useOrders.ts`. Esta RPC ya era canónica (usada también por `admin/public-sales.js`, ver §5), solo se conectó al Kanban `nj`.
- Columna Activos: si el reparto incluye "falta" → el resto del flujo de §3 aplica automáticamente (pasa a Apartados con el signo `!`).
- **Móvil / draftMode (2026-09-02):** el ✓ en `OrderCardItemActions` ya no stagea directo en borrador; siempre pasa por el padre para abrir este panel en multi-unidad. ✕ usa `onRequestMissing`. Layout móvil: sheet inferior apilado (`globals.css` `@media max-width: 767px`), botones ~40px, CTAs sticky. Compartido Pedidos + Retiro.

---

## 3. Ítem marcado "Falta" ya no bloquea el pedido en Activos

**Problema:** un pedido con un ítem marcado `missing` por el local quedaba visible en Activos, pero ese producto no está disponible — generaba confusión.

**Fix (`nj/lib/orders/classification.ts`):**

- `hasAllItemsPicked` trata los ítems `missing` como "resueltos" (no bloquean el pase a Apartados).
- `hasItemsNeedingAttention` deja de considerar `missing` como "necesita atención" en Activos.

**Resultado:** el pedido pasa a **Apartados** con un indicador `!` clickeable en la tarjeta. Al tocarlo se despliega un panel (`order-card__missing-panel`) que muestra **solo** los ítems `missing`, con botón **✕** para quitarlos del pedido si el admin decide que no se van a esperar.

---

## 4. Orden de prioridad en la columna "Espera"

**Regla de negocio:** los pedidos que tienen ítems genuinamente en espera (van a llegar) deben estar **arriba**; los que además tienen algún ítem `missing` (sin stock, incierto) se empujan al **final**, manteniendo el sub-orden por Local/Fábrica.

- `nj/lib/orders/waiting-source.ts` — `getWaitingColumnSortKey()` penaliza (suma un offset alto) a los pedidos con `missing`, y dentro de cada grupo ordena por origen (local/fábrica) como antes.
- `KanbanColumn.tsx` ordena la lista de la columna `waiting` con esta key antes de renderizar.

### Leyenda de colores en "Espera" (2026-07-12)

Las tarjetas en Espera se pintan según origen (`order-card--waiting-local` = verde `#22c55e`, `order-card--waiting-fabrica` = amarillo `#eab308`, ver `nj/styles/globals.css`). Se agregó una leyenda visual junto al título "Espera" (`WaitingLegend.tsx`, componente compartido) tanto en la columna desktop (`KanbanColumn.tsx`) como en el drawer mobile (`KanbanDrawer.tsx`), con dos chips: 🟩 Local / 🟨 Fábrica. Verificado en desktop y en viewport de 360px sin overflow.

---

## 5. "Cerrados": Reabrir → "Volver a apartado"

**Problema:** el botón "Reabrir" en la columna Cerrados llamaba una RPC pensada para el flujo del cliente, no para reabrir operativamente un pedido cerrado por error.

**Fix:** se usa `rpc_revert_order_to_picked` (ya existía en `supabase/canonical/16_closed_orders_transport.sql`, no se creó una nueva RPC) y se renombró el botón a **"Volver a apartado"** — mueve el pedido de Cerrados a Apartados. Wrapper: `rpcRevertOrderToPicked` en `nj/lib/supabase/order-queries.ts` (reemplaza al `rpcReopenOrder` anterior).

---

## 6. Creación manual de pedidos, portada de `admin/orders.html` a `nj`

El botón **+** en la columna Apartados (y en el header mobile, "+ Pedido") no tenía función asignada. Se portó la pipeline completa de creación manual del admin legacy a TypeScript:

| Archivo nuevo | Rol |
|---|---|
| `nj/lib/data/argentina-cities-data.ts` | Copia de `admin/argentina-cities-data.js` (provincias/ciudades para el form de cliente nuevo) |
| `nj/lib/supabase/customer-directory.ts` | Búsqueda de clientas existentes (ranking por nombre/DNI/teléfono), validación y alta (`rpc_create_admin_customer`, RPC legacy reusada, no nueva) |
| `nj/lib/supabase/order-create.ts` | `findOpenOrderForCustomer` (evita duplicar pedido activo) + `createManualOrder` (inserta `orders` + `order_items`, aplica descuento de stock, rollback si falla algún paso) |
| `nj/components/orders/OrderCreateModal.tsx` | Modal principal: buscar/seleccionar clienta, o crear una nueva en un **modal separado** (`createPortal`, no inline — pedido explícito del usuario), selector de productos (`OrderEditProductPicker`), extras (`OrderEditExtrasPanel`) |

Reuso de lógica ya existente en la edición de pedidos (`nj/lib/supabase/order-edit.ts`): se exportaron `itemQualifiesForStockDeduction`, `applyManualConfirmedItems`, `applyOrderStockDeduction` (ahora acepta un `source` para distinguir en `stock_history` si el descuento vino de edición o de creación) para no duplicar la lógica de descuento entre crear y editar.

**Extras especiales:** admite montos positivos o negativos, igual que el modal de edición existente.

**Selector manual de talles (`OrderEditProductPicker.tsx`):** se agregó un botón de decremento (`-`) para poder deshacer una selección si se tocó de más, sin tener que reiniciar la selección del producto.

**Botón "+" mostrándose "apagado":** el CSS (`.kanban-column__add-btn`) tenía `cursor: not-allowed; opacity: 0.55` de cuando el botón era un placeholder deshabilitado; se quitó y se agregó estado `:hover`.

---

## 7. Aviso "¿llevar a 0 el stock?" al marcar "Sin stock" (✕)

**Contexto de negocio:** cuando un admin (Kanban `nj`) o el local (`admin/public-sales.html`, modal Espera) confirma en el terreno que **no** hay stock real de una variante+talle, pero el sistema todavía muestra existencias > 0 (`variant_sizes.stock_qty`, lo que ve el catálogo público), esas existencias son "fantasma" y conviene llevarlas a 0 para no seguir vendiéndolas.

**RPC nueva:** `rpc_admin_zero_variant_size_stock(p_variant_id, p_size, p_order_item_id)` — `supabase/canonical/250_rpc_admin_zero_variant_size_stock.sql`. Pone en 0 todas las filas de `variant_size_warehouse_stock` de esa variante+talle (todos los depósitos), registra el ajuste en `stock_history` vía `log_stock_change`, y deja que el trigger de sincronización (migración 84) actualice `variant_sizes.stock_qty`. **No** toca `reserved_qty` (ese stock era libre, no reservado — si estuviera reservado ya se habría restado al reservarlo). Solo `admins`. Aplicada en producción.

**Kanban `nj`** (`OrderCardItemActions.tsx`): al presionar ✕ y confirmar "falta", se consulta `variant_sizes.stock_qty` (`getVariantSizeStockQty` en `useOrders.ts` → `fetchVariantSizeStockQty` en `order-queries.ts`); si > 0, se muestra un modal (`createPortal`) con el stock actual y los botones "No, dejar como está" / "Sí, llevar a 0" → `zeroVariantSizeStock` → RPC 250.

**Legacy `admin/public-sales.js`** (modal Espera): mismo patrón con `checkAndOfferZeroStock()` — usa `confirm()` nativo del navegador en vez de un modal propio, integrado en `handleReservaAction()` cuando `nextStatus === 'missing'`.

---

## 8. Modal "Espera" legacy (`admin/public-sales.html`) — compactación y desglose por unidad

**Motivación:** la tarjeta de cada pedido en el modal de reservas era demasiado grande y solo entraba una por pantalla, cuando el caso de uso es revisar varios clientes en la misma sesión.

**Cambios (`admin/public-sales.html` + `.js`):**

- Tarjetas más chicas: header, padding y tipografías reducidas (`.reserva-order`, `.reserva-order__meta`, `.reserva-item-row`).
- **Desglose por unidad:** si un talle se repite (p. ej. 3 unidades del mismo talle/color), en vez de una fila con cantidad "x3" se muestran **3 filas independientes** "x1" cada una, cada una con su propio botón ✓/✕ — permite confirmar 2 y marcar falta en la tercera. Implementado con `expandReservaDisplayUnits()`; para `quantity > 1` la acción usa `rpc_split_order_item_status` (129) en vez de marcar todo el ítem.
- **Lupa 🔍** junto a cada ítem: abre un modal con la imagen del producto (`reservaCloudinaryUrl` + `fetchReservaItemImageUrl`, usa `order_items.variant_id`/`imagen`).
- Nombre, color, talle y cantidad en una sola línea, en negrita y con tipografía más grande.

---

## 9. Dashboard cliente (`nj/dashboard?tab=cart`)

- **Agrupación de ítems idénticos:** mismo producto + talle + color + precio + estado visible se muestran como **una sola fila** con la suma de cantidades, en vez de N filas repetidas (`nj/lib/orders/customer-order-display.ts`, usado desde `ActiveOrderTab.tsx`). **Fix 2026-09-02 (A56427):** la clave no puede ser solo `variant_id` (en FYL la variante es producto+color); hay que incluir el talle, si no Chocolate 36 y 40 se fusionaban en Mi pedido.
- **Cantidad resaltada:** `LineItemRow.tsx` → `QuantityUnitLabel`, chip visual en negrita; precio unitario ("c/u") solo se muestra si `quantity > 1`.
- **Fix mobile 360px:** el chip de cantidad rompía la estética en viewports de 360px de ancho (se veía bien recién desde 390px); se ajustaron paddings/tamaños de fuente específicamente para ese breakpoint, sin afectar 390px+.

---

## 10. Mobile-first para `nj/admin/orders` (draft mode)

Pedido explícito: en mobile, la pantalla principal debe mostrar **solo Activos**; el resto de columnas se acceden por un menú, y las acciones (✓/⏳/✕) no deben aplicarse al toque sino quedar "en borrador" hasta confirmar todos los cambios juntos (evita toques accidentales y permite revisar antes de aplicar).

**Navegación:**

- `nj/hooks/useIsMobile.ts` — hook que refleja el breakpoint `max-width: 767px` de `globals.css`.
- `KanbanBoard.tsx` — en mobile, solo la columna Activos queda visible inline (`kanban-column-slot--mobile-hidden` en las demás); botón hamburguesa (☰, "Ver otras columnas") abre un menú con Espera / Apartados / Cancelados / Cerrados, cada uno abre `KanbanDrawer.tsx` (panel deslizante) con `KanbanColumnSearch` incluido (antes solo estaba en el header desktop) y botón "+" propio en Apartados.
- Botón **"+ Pedido"** en el header mobile → mismo `OrderCreateModal` de §6 (`NewOrderForm` ahora acepta `className`/`label` para reusarse en distintos contextos).
- Link **"🚚 Enviados"** en el header (desktop y mobile), junto a Cerrados → `http://localhost:5500/admin/sent-orders.html` (navegación directa al admin legacy de envíos, no hay página `/nj` equivalente todavía).

**Draft mode (`nj/lib/orders/draft-changes.ts`):**

- Tipos `DraftChangeKind` (`picked` / `waiting-fabrica` / `waiting-local` / `missing` / `split`) y `DraftChangesMap` (por `order_item_id`).
- En `OrderCard.tsx`, si `draftMode = column === "active" && (isMobile || boardScope === "local_pickup")`: tocar ✓/⏳/✕ (`OrderCardItemActions.tsx`) o el wizard de reparto (§2) solo llama `onStage*` (cambia de color: verde/amarillo-con-letra-F-o-L/rojo) en vez del RPC real. Excepción: ítem multi-unidad reservado → primero abre `PartialAcceptModal` y el resultado se stagea como `kind: "split"`.
- Barra `order-draft-bar` al pie de la tarjeta con resumen (`summarizeDraftChanges`) y botones **Confirmar cambios** / descartar — solo al confirmar se ejecutan las RPCs reales (`confirmChanges` en `OrderCard.tsx`), en el mismo orden en que se tocaron los botones.
- Badge (●) en el header de la tarjeta colapsada si tiene cambios pendientes sin confirmar.
- Botón "Apartar todos" (`OrderActions.tsx`) oculto mientras hay `draftMode` activo (no tiene sentido aplicar todo de golpe si se está revisando ítem por ítem).

**Bug de layout encontrado y resuelto durante esta implementación:** al envolver cada `KanbanColumn` en un `div.kanban-column-slot` para poder ocultarlo en mobile, las columnas del **desktop** dejaron de ser parejas (`grid-template-columns: repeat(4, 1fr)` ya no alcanzaba). Causa: `min-width: 0` — necesario para que un hijo de grid no fuerce el ancho de su columna por contenido — estaba en `.kanban-column` (el hijo del slot) pero el hijo directo del grid pasó a ser `.kanban-column-slot`. Fix: mover `min-width: 0` a `.kanban-column-slot`.

---

## 11. Fixes posteriores (2026-07-16/18): ítems `missing`, "Desarmar" y pedidos `closed` atascados

Serie de fixes puntuales encontrados después del cierre inicial de esta nota (§1-10), todos sobre el mismo circuito Kanban `nj` / dashboard cliente.

### 11.1 Ítems `missing` visibles inline en Apartados (antes: panel separado)

**Problema:** en la columna Apartados, un pedido con un ítem `missing` mostraba el signo `!` pero al expandir la tarjeta **no se veía el producto en cuestión** (el `!` solo abría un panel aparte). El admin no podía ver ni quitar el producto sin stock desde la vista expandida normal.

**Fix (`nj/components/orders/OrderCard.tsx`):** `pickedColumnItems` (columna `picked`) ahora incluye tanto `isPickedOrderItem` como `isMissingOrderItem`, así el ítem sin stock aparece **dentro** de la lista normal de la tarjeta expandida. El botón `!` en esa columna expande directamente la tarjeta (ya no abre el panel separado, que queda oculto para `column === "picked"`). Estilo dedicado en `globals.css`: `.order-card__item-row--missing` (fondo rosado, borde rojo) + chip `⚠ Sin stock` (`.order-card__item-missing-tag`).

### 11.2 Alta manual sin stock: ya no queda como `missing` para el cliente

**Problema:** si un admin agregaba/editaba manualmente un producto sin stock disponible desde el Kanban `nj`, el ítem quedaba con `status = 'missing'` → el cliente lo veía como "Sin stock" en el dashboard, cuando el patrón legacy para altas manuales sin stock es `status = 'picked'` + `admin_confirmed_missing = true` (se ve como "Apartado" para el cliente, con trazabilidad interna de que no había stock real).

**Fix (`nj/lib/supabase/order-edit.ts`):** `enrichDraftItemsWithStock` y `resolveSkuOrQrToOrderItem` ahora asignan `status: "picked"` (antes `"missing"`) manteniendo `admin_confirmed_missing: !hasStock`.

**Fix legacy admin:** en `admin/order-creator.js` y `admin/orders-ops.js` se corrige que cuando el admin carga físicamente con `hasConfirmedStock/hasStock=false`, el ítem ya no se persiste como `status: "missing"`, sino como `status: "picked"` con `admin_confirmed_missing=true`, evitando que el cliente vea “Sin stock”.

### 11.3 "Desarmar" en Cancelados: solo si pasaron los 7 días

**Problema:** el botón **Desarmar** (`rpc_cancel_order_full`, borra el pedido completo) aparecía en la columna Cancelados apenas un pedido tenía algún ítem cancelado, incluso si era reciente — un cliente que acababa de quitar un producto podía ver su pedido con la opción de desarmarlo por completo antes de tiempo.

**Fix (`nj/components/orders/OrderActions.tsx`):** el botón **Desarmar** ahora solo se renderiza cuando `isExpiredPendingAdminDisassembly(order)` es `true` (mismo criterio que el botón "+24hs"), es decir, cuando el pedido efectivamente superó la ventana de 7 días.

### 11.4 Pedido `closed` con ítem `missing` sin resolver quedaba "atascado" para el cliente (2026-07-18)

**Síntoma reportado:** un pedido ya **cerrado por el admin** (`orders.status = 'closed'`, ya no aparece en Activos/Apartados/Cancelados/Espera — vive en la columna **Cerrados**) seguía mostrando en `nj/dashboard?tab=cart` el aviso "Tu pedido alcanzó el plazo de 7 días... pero todavía no fue desarmado" + el ítem sin stock, **sin ningún botón funcional** para resolverlo (ni "Quitar del pedido", ni "Confirmar pedido"). El admin no encontraba el pedido porque no había mirado la columna Cerrados (en mobile queda detrás del menú ☰).

**Investigación:** el pedido **no fue borrado** — se verificó en Supabase (`dtfznewwvsadkorxwzft`) que sigue existiendo con `status = 'closed'`, 1 ítem `missing` y 4 `cancelled`. `matchesClosedTab` lo clasifica correctamente en Cerrados; el "Desarmar" de §11.3 ni siquiera es aplicable acá (solo existe en la columna Cancelados, y este pedido nunca estuvo ahí con ese botón visible).

**Causa real (`nj/components/cart/ActiveOrderTab.tsx`):** `isExpired` (`isOrderExpired(order)`) se calculaba solo a partir de `dismantle_at`/`created_at`, **sin considerar `order.status`**. Para un pedido ya `closed` cuyo `dismantle_at` original había quedado en el pasado, `isExpired` daba `true`, lo que producía dos efectos simultáneos e incorrectos:
1. Se mostraba el aviso de "plazo vencido / no desarmado / Cancelar pedido / Dame 24hs", pensado para pedidos `active`/`closing_soon` — mensaje contradictorio para un pedido que el admin ya cerró.
2. `isReadOnly = isExpired` pasaba a `true`, lo que **ocultaba los controles** para resolver el ítem `missing` (botón "Alternativas" y menú "⋯ → Quitar del pedido") y además caía en la rama `isExpired ? (canSend ? boton : null) : (...)` del CTA final, que al no cumplir `canSend` (por el ítem sin stock) **no renderizaba ningún botón** — pedido sin salida posible para el cliente.

**Fix:** `isExpired` ahora excluye pedidos `closed`:
```ts
const isExpired = isOrderExpired(order) && !isClosed;
const warnSoon  = !isExpired && !isClosed && (daysLeft === 1 || daysLeft === 2);
```
Con esto, para un pedido `closed`: no se muestra el aviso de plazo vencido, `isReadOnly` vuelve a `false` (se recuperan "Alternativas" y "Quitar del pedido" sobre el ítem `missing`), y el CTA final cae en la rama normal que ya tenía el aviso correcto para este caso (`isClosed && missingItems.length > 0` → "⚠️ Tu pedido está siendo preparado, pero hay un producto sin stock") y el botón "⛔ Resolvé los productos sin stock" / "✓ Confirmar pedido" en vez de nada.

**Deuda relacionada (no corregida, mismo bug potencial):** `client/dashboard-instant.js` (`isOrderExpiredPendingAdminDisassembly`, línea ~553) tiene el mismo patrón — `isOrderStillVisibleInMyOrder` incluye `"closed"` como estado visible y la función no excluye `closed` al chequear `hasOrderPassedCustomerEditWindow`. No se tocó porque el dashboard legacy (`client/dashboard.html`) no fue parte de esta sesión, pero si algún flujo sigue usándolo, tiene el mismo riesgo.

## 12. "Un pedido a la vez" ampliado para incluir `closed` (2026-07-18)

**Disparador:** a raíz de §11.4, el usuario planteó la hipótesis de que el pedido atascado se debía a que un cliente había tenido 2 pedidos simultáneos ("un cliente no puede tener 2 pedidos a la vez, solo uno a la vez").

**Investigación (con subagente `explore` + lectura directa de Supabase):** la regla "un pedido abierto por cliente" **sí estaba garantizada en DB**, pero solo para `active`/`closing_soon` — vía el índice único parcial `orders_one_open_per_customer_idx` (creado en migración **119**), reforzado de forma consistente en **los 5 lugares** donde se crea un pedido: `rpc_checkout_cart` (cliente), `admin/order-creator.js` (legacy), `admin/orders-ops.js` (PAU), `nj/lib/supabase/order-create.ts` (Kanban `nj`) y `rpc_create_admin_order_atomic` (canónica sin uso en frontend). Ninguno de esos 5 chequeos incluía `closed` ni `stock_pending` — un cliente **podía en teoría** terminar con `closed` + `active` simultáneos (el checkout no encuentra pedido abierto porque solo busca active/closing_soon, y crea uno nuevo).

**Confirmado con evidencia:** el pedido puntual de §11.4 (`A54834`) **no** tenía ningún otro pedido activo simultáneo — el síntoma ahí fue enteramente el bug de `isExpired`/`isReadOnly`, no un caso real de 2 pedidos. Pero el agujero de diseño (ausencia de bloqueo para `closed`) era real y confirmado en 5 archivos independientes, así que se decidió corregirlo de forma preventiva.

**Decisión del usuario:** ampliar la regla para incluir `closed` (pedido cerrado, pendiente de envío) — **no** `stock_pending` (queda como estaba).

**Cambios aplicados (producción, `dtfznewwvsadkorxwzft`):**

- **Migración `supabase/canonical/251_orders_one_open_per_customer_include_closed.sql`** (aplicada):
  - Índice único `orders_one_open_per_customer_idx` ahora cubre `status IN ('active','closing_soon','closed')` (antes solo los primeros dos). Incluye verificación previa que aborta la migración si hubiera clientes con 2+ pedidos no-terminales (no había ninguno).
  - `rpc_checkout_cart()`: si el cliente solo tiene un pedido `closed` sin resolver, **bloquea el checkout** con mensaje claro ("Ya tenés un pedido cerrado en preparación para el envío...") en vez de crear un `active` nuevo en silencio. Mismo mensaje si la carrera contra el índice ampliado ocurre justo contra un pedido `closed`.
  - `rpc_create_admin_order_atomic()`: mismo chequeo `OPEN_ORDER_EXISTS` ampliado a `closed` (RPC sin caller en frontend hoy, actualizada solo por consistencia).
- **`nj/lib/supabase/order-create.ts`** (`findOpenOrderForCustomer`): incluye `closed` en el `.in("status", ...)`. Devuelve también `status` para que `OrderCreateModal.tsx` distinga el mensaje ("pedido activo" vs "pedido cerrado").
- **`admin/order-creator.js`** (`createNewOrder`): mismo `.in(...)` ampliado; el `confirm()` ahora dice "cerrado (pendiente de envío)" cuando corresponde.
- **`admin/orders-ops.js`** (PAU): `OPEN_ORDER_STATUSES` (usado por `findActiveOrderForCustomer`/`createApartadoOrder`, evita duplicar pedido) ahora incluye `closed`. Se separó un `ACTIVE_STYLE_CHIP_STATUSES` (sin `closed`) para que el chip de la lista de clientas siga mostrando "Cerrado" en vez de agruparlo con Pedido/Apartado/Espera — evita una regresión visual en PAU.

**Alcance deliberadamente no tocado:** `stock_pending` no se agregó a ninguno de los chequeos ampliados (decisión explícita del usuario). `addItemsToExistingOrder` (merge de ítems en pedido existente) no se modificó — ya soporta cualquier status porque es la misma función usada para editar pedidos en cualquier etapa.

## 13. Fix: pedido con ítem cancelado se iba entero a Cancelados (2026-07-18)

**Disparador:** "cuando en orders se marca sin stock y el cliente en el dashboard quita el producto, ese pedido pasa entero a Cancelados. Esto no es necesario ya que si el admin ya dijo que no hay stock, solo se necesita que el cliente lo quite del pedido, no es necesario mandarlo a la lista de cancelados."

**Causa real:** el sistema **ya tenía** el mecanismo correcto para este caso — `OrderCard.tsx` calcula `showCancelledBanner` (`cancelledItems.length > 0 && column !== "cancelled" && column !== "waiting"`) para mostrar un panel de "cancelado por la clienta — confirmá para devolver stock" **dentro** de la card, sin mover el pedido entero, cuando quedan otros ítems operativos. Pero un bug en `hasAllItemsPicked()` (`nj/lib/orders/classification.ts` y su equivalente en `admin/orders.js`) contaba los ítems `cancelled` en el **denominador** total al comparar "¿todos los ítems están apartados?". Ejemplo: pedido con 3 ítems `picked` + 1 `cancelled` (antes `missing`) → `pickedItems=3`, `totalItems=4` → `3 !== 4` → `hasAllItemsPicked=false` → el pedido no calificaba para la columna Apartados → caía por descarte en `matchesCancelledTab` (que solo chequea "¿tiene algún ítem cancelado?") → el pedido entero terminaba en Cancelados en vez de quedarse en Apartados con el panel inline.

Se confirmó además que `rpc_cancel_order_item` (la RPC que corre cuando la clienta quita un producto desde el dashboard) ya maneja correctamente el caso `missing → cancelled`: no devuelve stock (no había nada reservado) y no genera notificación al admin (`v_was_picked` es `false` para ítems que estaban en `missing`). El bug era puramente de clasificación de columna en el frontend, no de stock.

**Fix aplicado:**
- `nj/lib/orders/classification.ts` (`hasAllItemsPicked`): excluye los ítems `cancelled` del cálculo antes de comparar `pickedItems === totalItems` (con guarda para no filtrar hacia iman "todos apartados" vacío).
- `admin/orders.js` (`hasAllItemsPicked`, misma función usada por `admin/orders.html` y `admin/orders2.html`): mismo fix, aplicado después del filtro existente de `missing` para `orders2`.

**Resultado:** un pedido con ítems apartados/en espera/activos + un ítem cancelado (venga de `missing` o de cualquier otro estado) ahora se queda en su columna natural (Activos/Espera/Apartados), mostrando el ítem cancelado en el panel inline existente con el botón de confirmar/devolver stock. Solo un pedido donde **todos** los ítems están cancelados cae en la columna Cancelados.

**Verificación:** `npx tsc --noEmit` en `nj/` y `node --check` en `admin/orders.js` sin errores. No se probó con datos reales en producción (no había un pedido con esta combinación exacta al momento del fix) — verificación por trazado manual de la lógica con casos de ejemplo.

---

## 14. Mobile: Espera y Cancelados como botones fijos (2026-08-06)

**Pedido:** en `nj/admin/orders` (solo mobile), sacar **Espera** y **Cancelados** del menú ☰ y dejarlos como dos botones siempre visibles encima del listado, con el contador de pedidos en ese estado. Al entrar a Espera/Cancelados **no** se abre drawer: se mantiene el mismo header (☰, + Pedido, Pedidos, Enviados, botones). El botón tocado se reemplaza por **Activos** para volver.

**Cambios:**
- `nj/components/orders/KanbanBoard.tsx` — `MOBILE_MENU_COLUMNS` queda en Apartados + Cerrados; franja `kanban-mobile-quick` con estado `mobileView` (`active` | `waiting` | `cancelled`). Tocar Espera/Cancelados cambia la columna visible inline; ese slot pasa a "Activos" (con count) para volver. El otro botón sigue disponible.
- `nj/styles/globals.css` — estilos de la franja + variante `--activos`; `display: flex` solo en `@media (max-width: 767px)` (desktop sin cambio).

**Resultado:** en mobile se ve siempre cuántos hay en Espera y Cancelados; se navega entre Activos/Espera/Cancelados sin perder el header; el ☰ solo navega Apartados y Cerrados (drawer).

---

## Verificación realizada

- `npx tsc --noEmit` en `nj/` sin errores tras cada cambio relevante (clasificación, wizard, mobile, leyenda de colores).
- Revisión visual con el navegador embebido (desktop 1024px+ y mobile emulado 360px) para: columnas del Kanban, drawer mobile, leyenda Espera, botón "+" (desktop y mobile), modal de creación manual (incl. modal de clienta nueva como ventana separada).
- No se encontraron pedidos con ítems `reserved` multi-unidad en los proyectos Supabase disponibles al momento de probar el wizard de reparto (§2) ni el draft mode (§10) con datos reales — verificación hecha por revisión de código + tipos, **pendiente probar con datos reales** cuando exista un pedido reservado con `quantity > 1` en producción o staging.
- Migraciones 248, 249, 250 y las RPCs reusadas (`rpc_split_order_item_status`, `rpc_revert_order_to_picked`, `rpc_create_admin_customer`) confirmadas presentes en `dtfznewwvsadkorxwzft` (fyl-core) vía `information_schema.routines` (2026-07-15).
- §11.4: confirmado con lectura directa del pedido real (`orders`/`order_items` en `dtfznewwvsadkorxwzft`) antes de tocar código — el pedido reportado como "desarmado" seguía existiendo con `status = 'closed'`, descartando esa hipótesis y confirmando la causa real en `isExpired`/`isReadOnly`. `npx tsc --noEmit` sin errores tras el fix.
- §12: mapeo exhaustivo con subagente `explore` de los 5 flujos de creación de pedido + CHECK constraint de `orders.status` + distribución real de statuses en prod, antes de escribir la migración. Verificado con `SELECT` que no había clientes con 2+ pedidos no-terminales antes de ampliar el índice (la migración también lo verifica sola y aborta si hubiera). Tras aplicar: confirmado con `pg_indexes`/`pg_proc` que el índice y ambas funciones quedaron con la definición nueva. `npx tsc --noEmit` en `nj/` y `node --check` en `admin/order-creator.js` + `admin/orders-ops.js` sin errores.

## Riesgos / deuda pendiente

| Riesgo / deuda | Nivel | Nota |
|---|---|---|
| Wizard de reparto (§2) y draft mode (§10) sin verificación end-to-end con datos reales | Medio | Falta caso real de ítem reservado multi-unidad en prod/staging para probar el flujo completo |
| `rpc_admin_zero_variant_size_stock` no distingue depósito, pone en 0 **todos** los depósitos de esa variante+talle | Bajo | Es el comportamiento buscado (el admin confirmó "no hay stock real"), pero documentar si en el futuro se necesita granularidad por depósito |
| Legacy `admin/public-sales.js` usa `confirm()` nativo para el aviso de §7, Kanban `nj` usa modal propio | Bajo | Inconsistencia de UX entre legacy y nj, aceptado por ahora (paridad funcional, no visual) |
| Link "🚚 Enviados" apunta a `localhost:5500` hardcodeado | Bajo | Depende de que el admin legacy siga corriendo en ese puerto; revisar si se despliega a otro dominio |
| §12: `stock_pending` sigue sin bloquear pedido nuevo (decisión explícita, no un olvido) | Bajo | Si en el futuro se decide incluirlo, tocar el mismo índice + los mismos 5 archivos listados en §12 |
| §12: no se probó en runtime real el bloqueo de `rpc_checkout_cart` contra un pedido `closed` (no había ningún pedido `closed` en prod al momento del cambio) | Medio | Verificado por lectura de código + `tsc`/`node --check`; falta probar con un cliente real que llegue a tener un pedido `closed` y trate de hacer checkout de un carrito nuevo |
| Vista mobile de `nj/admin/orders`: falta la sub-feature "al seleccionar nombre de clienta, ver sus pedidos activos/reservados" mencionada en el pedido original | Pendiente | La tarjeta ya se expande al tocarla (comportamiento previo reusado), no se construyó una vista dedicada por clienta |
| `client/dashboard-instant.js` (`isOrderExpiredPendingAdminDisassembly`) tiene el mismo bug que §11.4 (no excluye `status = 'closed'`) | Medio | No corregido — dashboard legacy fuera de alcance de esta sesión, pero mismo riesgo si sigue en uso |

---

## Referencias

- Clasificación de columnas: `nj/lib/orders/classification.ts`, `nj/lib/orders/domain.ts`, `nj/lib/orders/waiting-source.ts`
- Draft mode: `nj/lib/orders/draft-changes.ts`, `nj/hooks/useIsMobile.ts`
- Creación manual: `nj/lib/supabase/order-create.ts`, `nj/lib/supabase/customer-directory.ts`, `nj/components/orders/OrderCreateModal.tsx`
- Zero-stock: `supabase/canonical/250_rpc_admin_zero_variant_size_stock.sql`, `nj/components/orders/OrderCardItemActions.tsx`, `admin/public-sales.js` (`checkAndOfferZeroStock`)
- Stock/`reserved_qty` (mismo trabajo de auditoría): [[06-RESERVED-QTY-Y-RECONCILE]] §246, §249
- Migración Next.js: [[41-MIGRACION-NEXTJS-NJ-2026-06-08]]
- Cancelación cliente: [[43-NJ-DASHBOARD-PRORROGA-CANCELACION-2026-06-09]]

---

*Creado: 2026-07-15. Cubre el trabajo de sesión sobre Kanban `nj`, modal Espera legacy y dashboard cliente descrito arriba; no incluye trabajo de otras notas (40, 41, 43) salvo lo referenciado.*
