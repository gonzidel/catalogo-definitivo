# 17 - Auditoria modulo Orders

Estado: auditoria de codigo y SQL del repo, sin cambios aplicados.
Fecha: 2026-04-24.
Modulo: Orders / Pedidos.

## 1. Alcance

Archivos revisados:

| Archivo | Rol actual |
|---|---|
| `admin/orders.js` | Panel principal de pedidos activos/apartados/cerrados, cambios de estado, cancelaciones y envio a local. |
| `admin/pau.html` + `admin/pau.js` + `admin/orders-ops.js` | **PAU** — flujo movil rapido (ver [[40-PAU-PANEL-ATENCION-UNIFICADO]]); reutiliza `order-creator` sin cargar `orders.js`. |
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

---

## 10. Post-auditoría: lista de envíos y `sent_at` (2026-05-26)

**Deploy:** `227_shipping_list_sent_at_only` en prod.

| Antes | Después |
|-------|---------|
| `rpc_mark_order_as_sent` sin `sent_at` | `sent_at = now()` al finalizar |
| Lista usaba `closed_at` si `sent_at` null | Lista solo por `sent_at` (Argentina) |
| Pedidos cerrados sáb / finalizados lun → lista sáb | Desde deploy: lista = día de finalización |

Sin backfill histórico (~1.409 `sent` sin `sent_at` no entran en listas por fecha).

Nota canónica: [[39-LISTA-ENVIOS-SENT-AT-2026-05-26]] · `doc/shipping-list-sent-at-deploy-2026-05-26.md` · `TROUBLESHOOTING_LISTA_ENVIOS.md`.

---

## 11. Bug fix crítico (2026-07-23): `order-creator.js` no aplicaba descuento de promos 2x1/2xMonto al total guardado, y closed-orders.js confiaba en `total_amount` sin corregirlo

**Contexto:** en la misma sesión se había corregido el cálculo de promos 2x1/2xMonto (remainder impar) en `orders.js`, `closed-orders.js`, `orders-ops.js` (PAU) y `public-sales.js`, y se había corregido que `public-sales.js` guardara el total con el descuento aplicado. El usuario pidió extender la revisión a rótulos/tickets/montos de listas de `admin/closed-orders.html`.

**Hallazgos:**

1. **`admin/order-creator.js` (`saveOrder()`, usado por el modal "Nuevo pedido"/"Editar pedido" de `admin/orders.html`, `orders2.html`, `sent-orders.html` — el flujo de creación manual de pedidos por admin, separado de PAU):** el `total` que se guardaba en `orders.total_amount` (tanto al crear como al editar un pedido) se calculaba sumando `price_snapshot * quantity` de cada item **sin restar nunca el descuento de promociones 2x1/2xMonto**. La vista previa en pantalla (`updateOrderTotal()`) tenía el mismo problema. Es decir: el descuento de "2x" por cantidad nunca se aplicaba ni se mostraba, ni en pantalla ni en lo que se guardaba en base.

   **Nota 2026-08-04:** el modal de pedidos también tenía un gap en oferta por color: QR (`processQrCodeForOrder`) y búsqueda manual usaban `product_variants.price` de lista al armar `price_snapshot`. PAU y public-sales ya usaban `get_effective_price`. Corregido en `order-creator.js` (`resolveEffectiveUnitPrice` + `applyEffectivePricesToSearchRows`) para que el snapshot/historial/daily-sales queden con el precio de oferta.
2. **`rpc_close_order` no recalcula `total_amount`:** solo cambia `status`/`payment_method`/`closed_at`. Esto confirma que lo que se persiste al crear/editar el pedido (paso 1) viaja intacto hasta pedido cerrado — no hay ningún punto posterior que lo corrija.
3. **`admin/closed-orders.js` confiaba en `order.total_amount` en 4 lugares** (tarjeta de la lista, modal de detalle, ticket impreso, monto a cobrar del rótulo TSC) con el patrón `hasStoredTotal ? order.total_amount : calculo-en-vivo-con-descuento`. Como `total_amount` casi siempre está seteado, en la práctica **siempre se mostraba el total crudo de la base**, ignorando el descuento de ofertas/promos — aunque la línea "Descuentos (ofertas/promos)" sí se mostraba por separado con el monto correcto (inconsistencia visible: se ve el descuento pero el total no lo refleja).
4. **Lista de envíos ("Imprimir Listas"):** la tabla del modal, el PDF y la lista guardada (`rpc_save_shipping_list`) usan `order.total_amount` tal cual devuelve `rpc_get_shipping_orders` (SQL), que tampoco resta el descuento de promos.
5. **`rpc_checkout_cart` (checkout del cliente en el catálogo público)** tenía el mismo problema de fondo: sumaba `item_price * qty` sin restar descuento de promos 2x. **Corregido** con migración SQL en producción — ver sección 12.

**Fix aplicado (todo client-side, sin migraciones SQL):**

- Nueva función pura `computeOrderItemsPromoDiscount(items, promotions, getUnitPrice)` en `admin/orders-domain.js` (mismo fix de remainder impar ya validado en los otros módulos), para no duplicar la fórmula una vez más.
- `admin/order-creator.js`:
  - `updateOrderTotal()` (vista previa) ahora es async, calcula el descuento de promos sobre los items del modal y lo resta antes de mostrar el total; muestra una línea "Descuento (promoción)" en el desglose.
  - `saveOrder()`: al crear o editar, calcula el descuento de promos sobre el conjunto combinado (items existentes del pedido, si se edita, + items nuevos) y lo resta del `total` que se guarda en `orders.total_amount`. Se eliminó la reconstrucción de "subtotal existente" a partir de `total_amount - extras` (heurística previa a los fixes de promos, ambigua/riesgo de doble descuento); ahora el subtotal de items existentes siempre se recalcula desde `order_items` en vivo.
- `admin/closed-orders.js`: en `renderOrderCard`, `showOrderDetail`, `buildEscposTicketOrder` y `prepareShippingLabelFromOrder` (monto a cobrar del rótulo TSC), el total mostrado/impreso **ya no confía en `order.total_amount`**: siempre se recalcula en vivo como `subtotal bruto (items no cancelados) + envío - descuento - extras + extras% - descuento de ofertas/promos`, usando la misma `getOffersAndPromotionsForOrder()` que ya calculaba (y mostraba) el descuento por separado. Esto hace que el total impreso siempre coincida con la línea de descuento que se muestra arriba.
- Lista de envíos: nueva función `enrichShippingListOrdersWithCorrectedTotal()` en `admin/closed-orders.js`, llamada desde `loadOrdersForList()`. Trae `order_items` + `notes` en batch para los pedidos devueltos por `rpc_get_shipping_orders` y sobreescribe `total_amount` en memoria con el valor recalculado, antes de renderizar la tabla del modal, generar el PDF y guardar el snapshot (`rpc_save_shipping_list`) — sin tocar la tabla `orders` real.
- Cache-busting: `orders-domain.js` y `order-creator.js` subidos a `?v=m260723` en los imports de `order-creator.js`, `orders-ops.js`, `orders.js`, `pau.js`.

**Riesgo/deuda pendiente:**

- **`rpc_checkout_cart` corregido** — ver sección 12 (migración 253, aplicada en producción el 2026-07-23).
- **No se corrigió la extracción a Excel** (`rpc_get_shipping_orders_range` / pestaña "Extraer" del modal de listas): esa RPC no devuelve `id` de pedido, por lo que no se puede recalcular en el cliente sin antes ampliar el `RETURNS TABLE` de la RPC (migración SQL, misma limitación que antes).
- **Sin backfill histórico**: pedidos ya cerrados/enviados con promos activas que se crearon vía `order-creator.js` o `rpc_checkout_cart` antes de estos fixes tienen `orders.total_amount` sin el descuento aplicado. El fix en `closed-orders.js` corrige la *visualización/impresión* en vivo (ticket, rótulo, tarjeta, detalle, lista de envíos) independientemente de lo persistido, pero **no corrige el valor guardado en `orders.total_amount`** para esos pedidos históricos — evaluar si conviene un backfill puntual una vez identificados los pedidos afectados (join `orders` + `order_items` + promos activas en el momento del pedido, que no se puede reconstruir con certeza si la promo ya no existe).

## 12. Fix SQL en producción (2026-07-23): `rpc_checkout_cart` no restaba el descuento de promos 2x1/2xMonto del `total_amount`

**Contexto:** continuación del punto 5 de la sección 11. El checkout del cliente en el catálogo público (`rpc_checkout_cart`, llamado desde `client/dashboard-instant.js` y, vía delegación, desde el wrapper de idempotencia fuerte `rpc_checkout_cart(p_operation_id uuid, p_request jsonb)` de `174_rpc_checkout_cart_strong_idempotency.sql`) es la única pieza del flujo de promos que requería una migración SQL en producción, porque corre 100% server-side.

**Bug:** el bloque final de `rpc_checkout_cart()` hacía `total_amount = coalesce(total_amount,0) + coalesce(v_total,0)`, donde `v_total` es la suma cruda de `price_snapshot * qty` de los items del carrito (ya con oferta por color aplicada vía `get_effective_price`, pero **sin** descuento de promos 2x1/2xMonto).

**Fix (migración `supabase/canonical/253_rpc_checkout_cart_apply_promo_discount.sql`, aplicada en producción — proyecto `fyl-core` / `dtfznewwvsadkorxwzft`):**

- Se reemplazó el bloque final de cálculo de `total_amount` por un recálculo desde cero, después de insertar los `order_items` del checkout:
  1. Suma **todos** los `order_items` no cancelados del pedido (no solo los del checkout actual — un pedido puede armarse en varias vueltas de carrito/checkout, ya que la función reutiliza el pedido `active`/`closing_soon` existente del cliente).
  2. Busca promociones activas para esas variantes con `public.get_active_promotions_for_variants()` (misma función que usa el resto del sistema).
  3. Aplica la misma fórmula ya validada en JS (`admin/orders-domain.js: computeOrderItemsPromoDiscount`): unidades que no completan un par de 2 pagan precio normal; si una promo mal configurada diera un "descuento" negativo (ej. `fixed_amount` > 2 × precio normal), se ignora esa promo puntual.
  4. `total_amount = greatest(0, subtotal_bruto - descuento_promos)`.
- No cambia: validación de stock, descuento de stock por depósito/talle, inserción de `order_items`, reglas de "un pedido a la vez" (migración 251). El resto del cuerpo de la función es idéntico a `251_orders_one_open_per_customer_include_closed.sql`.
- El wrapper de idempotencia fuerte (`rpc_checkout_cart(uuid, jsonb)`, canonical 174) delega en `public.rpc_checkout_cart()` (la firma sin argumentos que se corrigió), así que el fix aplica sin cambios adicionales sin importar qué firma invoque el cliente.

**Verificación pendiente (funcional, no ejecutada en esta sesión):** crear/usar una promo 2x1 o 2xMonto activa, agregar 2 unidades al carrito desde el catálogo público, finalizar compra, y confirmar que `orders.total_amount` queda con el descuento aplicado.

**Rollback:** re-aplicar el `CREATE OR REPLACE FUNCTION public.rpc_checkout_cart()` de `251_orders_one_open_per_customer_include_closed.sql` (mismo cuerpo, sin el bloque de descuento de promos).

## 13. Bug fix (2026-07-23): recálculo de la lista de envíos ("Imprimir Listas") usaba promociones de HOY en vez de las vigentes el día del pedido

**Contexto:** el usuario pidió verificar que el PDF descargado por "Imprimir y Guardar PDF" (modal de listas de envío en `closed-orders.html`) muestre el total correcto cuando un pedido tiene una oferta/promo. Se auditó `enrichShippingListOrdersWithCorrectedTotal()` (sección 11) contra datos reales de producción.

**Verificación positiva:** con 3 pedidos reales enviados durante la ventana de la promo activa (2x$34000, vigente 2026-07-21 a 2026-07-29), el total recalculado por `enrichShippingListOrdersWithCorrectedTotal()` coincidió exactamente con `orders.total_amount` ya guardado (ej. pedido con 4 unidades en la promo: subtotal bruto $94.700 − descuento $12.000 = $82.700, igual al valor guardado). Esto confirma que la fórmula y el flujo `loadOrdersForList → enrichShippingListOrdersWithCorrectedTotal → currentOrdersList → generateShippingListPDF`/`renderOrdersList` funcionan correctamente para el caso normal (lista de un día dentro de una promo vigente).

**Bug encontrado:** `getOffersAndPromotionsForOrder()` resuelve las promociones activas vía el RPC `get_active_promotions_for_variants`, que fija internamente `current_date` (HOY), sin importar qué pedido se esté evaluando. Un query de auditoría contra producción (comparando `total_amount` guardado vs. el que resultaría de aplicar la promo activa de HOY a pedidos con ≥2 unidades de esos mismos productos) encontró pedidos enviados el **2026-07-17** (4 días antes de que la promo existiera, `sent_date: 2026-07-17`, `total_amount: 290500`) que quedarían con un descuento incorrecto de $12.000 si un admin reimprime/recalcula esa lista de envíos **hoy** — porque el código evaluaría "¿hay una promo activa?" contra la fecha actual en lugar de contra la fecha real del pedido. El caso inverso también aplica: un pedido enviado DURANTE la ventana de una promo que ya venció mostraría el descuento removido si se reimprime después de que la promo expiró.

**Fix (client-side, sin migración SQL):**

- Nueva función `getActivePromotionsForVariantsAtDate(variantIds, referenceDateStr)` en `admin/closed-orders.js`: si `referenceDateStr` es "hoy", usa el RPC existente (rápido, ya optimizado). Si es una fecha distinta, resuelve manualmente consultando `promotion_items` + `promotions` (tablas legibles por `authenticated` sin restricción de fecha/estado vía RLS) y filtra por `status = 'active' AND start_date <= referenceDateStr AND end_date >= referenceDateStr`, replicando la forma de salida del RPC (`promotion_id, promo_type, fixed_amount, variant_ids`).
- `getOffersAndPromotionsForOrder(order, referenceDate)` ahora acepta un segundo parámetro opcional `referenceDate`. Sin ese parámetro (los 4 call sites de tarjeta/detalle/ticket/rótulo, que representan una acción en vivo "ahora") sigue comportándose igual que antes (promos de hoy).
- `enrichShippingListOrdersWithCorrectedTotal(list, referenceDate)` ahora recibe la fecha filtrada de la lista de envíos (todos los pedidos del batch vienen de `rpc_get_shipping_orders` filtrados por esa misma fecha) y la propaga a `getOffersAndPromotionsForOrder`. `loadOrdersForList()` pasa el parámetro `date` recibido del filtro del modal.

**Verificado con datos reales:** para el pedido `019c3127-...` (enviado 2026-07-17, `total_amount: 290500`, 4 unidades de productos que hoy están en la promo 2x$34000 activa), con el fix la fecha de referencia usada al recalcular sería `'2026-07-17'` (no "hoy"), y como la promo empieza el `'2026-07-21'`, la condición `start_date <= '2026-07-17'` es falsa → no se encuentra ninguna promo → no se aplica descuento → total recalculado = subtotal bruto = `290500`, igual al guardado. Antes del fix, recalcular esa misma lista hoy hubiera dado `278500` (con un descuento de $12.000 que el cliente nunca tuvo).

**Riesgo/alcance:** este bug solo se manifiesta al reimprimir/recalcular una lista de envíos de una fecha **distinta a la de hoy** que además contenga pedidos con ≥2 unidades de productos que coincidan con una promoción activa en el momento de la reimpresión (coincidencia relativamente rara, pero posible si se reutilizan los mismos productos en promos recurrentes). No afecta la tarjeta/detalle/ticket/rótulo de `closed-orders.html` (siguen usando "hoy" a propósito, porque representan una acción en vivo, no una reimpresión histórica).

## 14. Fix SQL en producción (2026-08-03): un ítem "sin stock" (`missing`) cancelado por la clienta mandaba todo el pedido a Cancelados por una traza de stock obsoleta

**Contexto:** reportado con el pedido real `A55552`, ítem "135 · Marrón · T.38". El local marcó ese ítem como `missing` (sin stock real) y le pidió a la clienta que lo quite; al cancelarlo, todo el pedido (con el resto de los ítems ya apartados) se movió a la columna **Cancelados** del Kanban admin, mostrando un aviso confuso ("productos confirmados a devolver").

**Primer intento (insuficiente):** se agregó `orderHasCancelledItemsPendingStockReturn` / `cancelledItemNeedsStockConfirmation` en `nj/lib/orders/domain.ts`, usando la presencia de `order_item_stock_sources` con `qty > 0` como señal de "hace falta que el admin confirme una devolución física". No alcanzó porque **un ítem `missing` puede tener trazas reales heredadas**: si antes de terminar `missing` pasó por `waiting` con un depósito asignado (`rpc_mark_order_item_waiting_source`, 248) y luego se usó "reparto por unidad" (`rpc_split_order_item_status`, 129) para reclasificarlo, ese split redistribuye las trazas existentes **proporcionalmente a todas las líneas resultantes, sin importar el status final** (comentario propio del código: "Nunca inferir depósito por status dentro del split"). Es decir: la sola presencia de una traza NO distingue "hay stock físico pendiente" de "esto se marcó sin stock pero arrastra una traza vieja".

**Evidencia del riesgo real:** para el ítem `6580ec23-19e8-45fc-be51-fc016ef75f1c` la traza decía `qty:1` en depósito `general`, pero `product_variants.reserved_qty` de esa variante ya estaba en `0` (reconciliado en una corrida previa de `rpc_reconcile_stock(true)`, ver sección de stock). Si el admin hubiera tocado el ✓ "confirmar y devolver stock" sobre ese ítem, `rpc_remove_order_item_restore_stock` (249) habría acreditado **+1 unidad fantasma** a `variant_size_warehouse_stock`, sin que exista ningún producto físico real.

**Fix (migración `supabase/canonical/269_rpc_cancel_order_item_flag_missing_origin.sql`, aplicada en producción):**

- `rpc_cancel_order_item` (126) y `rpc_cancel_order_item_units` (137) ahora dejan constancia **explícita** en el momento de cancelar: si el ítem estaba en `missing`, se marca `admin_confirmed_missing = true` en la fila ya cancelada. Reutiliza la columna existente `order_items.admin_confirmed_missing` (178) — no colisiona con su otro uso porque `isPickedManualConfirmed`/`isManualMissingOrderItem` solo la leen para status `picked`/`missing`, nunca para `cancelled`. Ningún cambio de comportamiento de stock/`reserved_qty`: solo se agrega el flag informativo.
- `nj/lib/orders/domain.ts`: `cancelledItemNeedsStockConfirmation` dejó de mirar `order_item_stock_sources` y ahora usa directamente `!item.admin_confirmed_missing`.
- `nj/components/orders/OrderCard.tsx`: el banner "N producto(s) cancelado(s) — confirmá para devolver stock" (y la lista de la columna Cancelados cuando el pedido no está globalmente `cancelled`) ahora usan `getCancelledItemsPendingStockReturn(order)` en vez de todos los `cancelledItems`, así un ítem cancelado-desde-`missing` no aparece pidiendo una confirmación que no corresponde.

**Reparación puntual aplicada:** para el ítem `6580ec23-19e8-45fc-be51-fc016ef75f1c` (pedido `A55552`) se borró la traza obsoleta en `order_item_stock_sources` (ya no representaba ninguna reserva real, `reserved_qty` en 0) y se marcó `admin_confirmed_missing = true` directamente.

**Verificación:** el pedido `A55552` vuelve a clasificar en Apartados; `sources_left = 0` y `admin_confirmed_missing = true` confirmados por query directa post-fix.

**Rollback:** re-aplicar `CREATE OR REPLACE FUNCTION` de `126_rpc_cancel_order_item_return_stock.sql` / `137_rpc_cancel_order_item_units.sql` (sin el campo `admin_confirmed_missing` en el `UPDATE` final) revierte la migración sin pérdida de datos. La reparación puntual se revierte con `admin_confirmed_missing = false` (la traza borrada era fantasma, no corresponde recrearla).

**Deuda pendiente (no resuelta en este fix, señalada para una revisión aparte):** la causa raíz de que un ítem `missing` termine con trazas reales/obsoletas sigue en `rpc_split_order_item_status` (129), que redistribuye `order_item_stock_sources` a la línea `missing` resultante de un split sin devolver ese stock al depósito en el momento del split. Sería más prolijo que, al crear la línea `missing`, esa porción de stock se libere ahí mismo (`variant_size_warehouse_stock` + `reserved_qty`) en vez de arrastrar una traza que puede volverse fantasma más adelante.

## 15. Fix UI (2026-08-04): cancelar un producto solo Reservado (nunca Apartado) no debe pedir "devolver stock"

**Contexto:** en pruebas del dashboard cliente sobre el pedido `A55614`, se agregaron y quitaron productos (varios en oferta) que estaban en `reserved`. En el Kanban admin (`Activos`) aparecía el banner amarillo "2 producto(s) cancelado(s) por la clienta — confirmá para devolver stock" con ✓, aunque esos ítems **nunca estuvieron apartados**.

**Causa:** tras el fix 269, `cancelledItemNeedsStockConfirmation` quedó solo como `!admin_confirmed_missing`. Eso oculta bien los cancelados-desde-`missing`, pero **todos** los demás cancelados (incluye `reserved`/`waiting`, donde `rpc_cancel_order_item` ya devolvió stock y borró `order_item_stock_sources`) seguían pidiendo confirmación.

**Evidencia (`A55614`):** los 2 ítems cancelados (`FYL-740-CH` T.39, `FYL-770-CH` T.38) tenían `admin_confirmed_missing=false` y `order_item_stock_sources = []` (stock ya restaurado). Los 4 ítems `reserved` activos sí tenían fuentes.

**Fix frontend (`nj/lib/orders/domain.ts`):** `cancelledItemNeedsStockConfirmation` exige **ambas** condiciones:
1. `admin_confirmed_missing` no es true (sigue protegiendo el caso missing con trazas fantasma).
2. Hay al menos una fila en `order_item_stock_sources` con `qty > 0` (solo queda así cuando se canceló un Apartado/`picked`).

Así el banner amarillo y el ruteo a columna Cancelados solo aparecen cuando hay stock físico pendiente de confirmar. Un quitado desde Reservado deja de ensuciar la tarjeta de Activos.

**Deuda:** las filas `cancelled` huérfanas (sin fuentes) siguen en la base hasta que se limpien o hasta que la RPC, en un cambio futuro, borre el ítem en vez de marcarlo `cancelled` cuando el origen era `reserved`/`waiting`. No afectan stock.
