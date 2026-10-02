# Pedidos

Última revisión: 2026-09-23

## VERIFICADO EN CÓDIGO

### Flujo cliente principal

Estado: Vigente en código  
Fuente: Frontend y SQL  
Última revisión: 2026-09-23

1. El cliente agrega variante + talle + cantidad al store local.
2. La UI consulta `fn_sellable_stock_batch`; dato ausente significa desconocido y bloquea la suposición de disponibilidad.
3. `useCartSync` crea/reutiliza un `carts.status='open'` y upserta `cart_items`.
4. `runCustomerCheckout` obtiene lock por cliente, persiste/reusa `operation_id`, sincroniza y llama `rpc_checkout_cart(uuid,jsonb)`.
5. El wrapper idempotente registra en `rpc_operations`, bloquea el carrito y delega a `rpc_checkout_cart()`.
6. La RPC interna bloquea variante y filas de stock, valida disponibilidad por talle, descuenta stock y crea `order_items` + `order_item_stock_sources`.
7. El carrito servidor se vacía y el pedido queda abierto/acumulable.
8. El cliente pide cierre con `rpc_customer_request_close`; si todo está resuelto y no es retiro local, puede cerrar automáticamente.

### Pedido vacío

- `order_eligible_for_empty_deletion` considera eliminable un pedido sin ítems operacionales.
- El trigger `order_items_after_delete_empty_order` intenta borrarlo al eliminar una línea.
- `rpc_delete_empty_order` permite que dueño o admin soliciten el mismo mantenimiento.
- El borrado queda registrado en `order_empty_deletion_audit`.

Esto coincide con la regla empresarial confirmada: un pedido que queda vacío debe eliminarse.

### Creación o ampliación del pedido

- Reutiliza pedidos `active` o `closing_soon`.
- Un `closed` pendiente de preparación bloquea un pedido nuevo, salvo cierre de retiro ya cumplido.
- `cancelled` no bloquea un pedido nuevo.
- El índice `orders_one_open_per_customer_idx` aplica esa exclusión para pedidos no diferidos.
- Pedidos de retiro diferido usan `awaiting_apartado` y una rama de stock específica.

### Distribución de stock en checkout normal

- Primero consume `general`.
- El remanente consume `venta-publico`.
- Crea una línea `reserved` para unidades de `general` y una línea `waiting` para unidades de `venta-publico`.
- Cada línea registra su depósito/cantidad en `order_item_stock_sources`.
- **TÉCNICA VERIFICADA:** `reserved_qty` existe, se actualiza/reconcilia en flujos históricos y no gobierna el gate de venta actual. Su definición comercial continúa abierta.

### Precio y total

- Cada línea usa `get_effective_price(variant_id)` al confirmar.
- Snapshot del carrito se usa para UI/transporte, no como autoridad final.
- Total = suma de líneas no canceladas menos promociones activas aplicables.
- Migraciones locales recientes excluyen `missing` del total y agregan trigger de recálculo; su despliegue no se prueba solo por existir en el repo.
- **TÉCNICA VERIFICADA:** los valores extra cargados por el admin en `orders.notes` (`shipping`, `discount`, `extras_amount` + `extras_label`, `extras_percentage`) forman parte de `total_amount`: subtotal + envío − descuento + extra + subtotal × % / 100 (`rpc_admin_add_order_items_atomic`, editor NJ).
  - **CONTRADICCIÓN corregida (canonical 366):** `rpc_checkout_cart()` reescribía el total solo con líneas − promos y borraba esos extras en cada compra posterior de la clienta (A57414, extra "ALHAJEROS" $8.500). Desde 366 suma `fn_order_notes_extras_total(notes, subtotal)`.
  - El dashboard de la clienta (`ActiveOrderTab`) lista esos extras como filas y los suma a su total; antes solo mostraba líneas de `order_items`.
  - `syncOrderTotalAndNotes` (guardar solo extras desde el admin NJ) excluye líneas `cancelled`/`expired` del subtotal.

### Estados de pedido

**Clasificación: TÉCNICA VERIFICADA.** Estos son valores observados de `orders.status`; `picked` y `waiting` no pertenecen a esta lista.

| Estado DB | Uso observado |
|---|---|
| `active` | Pedido abierto/operativo |
| `closing_soon` | Aviso previo al vencimiento |
| `closed` | Cerrado y en preparación/circuito de entrega |
| `sent` | Enviado; terminal para Kanban operativo |
| `stock_pending` | Alta/edición admin pendiente de resolver stock |
| `cancelled` | Cancelado; puede requerir devolución física |
| `expired` | Vencido/desarmado o pendiente de gestión según ventana |
| `devolución` / `devolucion` | Devolución; terminal |

### Estados de ítem

**Clasificación: TÉCNICA VERIFICADA.** Corresponden a productos/líneas dentro del pedido.

| Estado | Significado técnico observado |
|---|---|
| `reserved` | Stock tomado de depósito general, pendiente de apartar |
| `awaiting_apartado` | Retiro diferido, stock aún no comprometido de la forma normal |
| `picked` | Unidad físicamente apartada/resuelta |
| `waiting` | Espera de movimiento/origen, a menudo stock del local |
| `missing` | Falta confirmada o línea no disponible |
| `cancelled` | Cancelada; puede conservar fuentes hasta confirmación admin |
| `expired` | Línea vencida por mantenimiento |

### Kanban administrativo

La columna no es una copia directa de `orders.status`; `classification.ts` combina estado, ítems, deadline, fuentes y tipo de retiro:

- Activos
- Apartados
- Espera
- Cerrados
- Stock Pendiente
- Cancelados
- Vencido

Estados terminales `sent` y devolución no se muestran. `expired` sí se mantiene visible para gestión.

### Términos operativos humanos

El equipo puede hablar de un pedido “apartado” o “en espera” según su columna del Kanban. Esas expresiones son clasificaciones derivadas de sus ítems; no deben escribirse como valores de `orders.status`. En particular, `picked` y `waiting` son estados de ítem.

### Cierre

- `rpc_close_order` rechaza pedidos vencidos o con ítems `reserved`, `waiting` o `awaiting_apartado`.
- No vuelve a descontar stock.
- **TÉCNICA VERIFICADA:** resuelve pago configurado en software: COD (SEDE/MyM/Expreso Norte) a `Contra Reembolso`, resto a `Pagado`, salvo método explícito no pendiente. No convertir Expreso Norte ni el fallback de Andreani en política comercial confirmada.
- Encola avisos administrativos del pedido cerrado.

### Reemplazo técnico de un faltante

- **TÉCNICA VERIFICADA:** cuando un ítem está en `missing`, la clienta puede abrir un panel de alternativas y elegir un producto disponible.
- La elección explícita llama a `rpc_customer_replace_missing_item`, que en una operación atómica toma stock de la alternativa, agrega las nuevas líneas y cancela el ítem faltante original.
- No se encontró un flujo que elija o sustituya automáticamente un producto sin una acción de la clienta. El reemplazo actual se ejecuta al tocar una alternativa concreta; ese toque es la elección explícita, aunque la UI no presenta una segunda confirmación antes de llamar a la RPC. No hay una sustitución silenciosa decidida por FyL.

### Reserva, vencimiento y recordatorios

- **CANÓNICA, plazo de reserva:** el pedido normal dispone de 7 días desde su creación. El código calcula `dismantle_at` al día 7, a las 17:00 de Argentina, y lo mueve al siguiente día hábil si corresponde; los feriados viven en `order_deadline_holidays`.
- **TÉCNICA VERIFICADA, aviso interno:** `expires_at` se calcula 2 días antes de `dismantle_at` y activa `closing_soon`.
- **TÉCNICA VERIFICADA en trabajo local, vencimiento/desarme:** la migración 355 agrega 24 horas de gracia después de `dismantle_at` para pedidos normales antes de marcar `expired` y devolver stock; `local_deferred_pickup` queda fuera. Su despliegue productivo debe verificarse.
- **TÉCNICA VERIFICADA:** `rpc_orders_daily_maintenance` devuelve stock por fuentes, marca ítems/pedido expirados y limpia fuentes.
- **TÉCNICA VERIFICADA en trabajo local (2026-09-29), días restantes en el dashboard cliente:** título del header, chip, banner, panel explicativo y campanita usan un único valor, `customerDaysLeft()` en `nj/lib/orders/deadline.ts`. Vencimiento el mismo día calendario: "Hoy". Día calendario siguiente: "Mañana". Desde 2 días calendario: bloques de 24 h redondeados hacia arriba (2 días y 10 horas se muestran como "3 días"). Antes, el título redondeaba hacia arriba y el chip contaba días calendario; como `dismantle_at` cae a las 17:00, antes de esa hora mostraban "3 días" y "2 días" a la vez. La campanita muestra "Faltan N días" durante todo el día calendario ubicado 2 días antes del vencimiento, "mañana" el día anterior y "hoy" el día del vencimiento.
- **EN EVALUACIÓN, recordatorios:** la UI contiene avisos de 2 y 1 día; documentación histórica contempla 3/2/1 y día de vencimiento; el trabajo YCloud reciente usa plazo cumplido/desarme final. Ninguna cadencia se considera política comercial canónica todavía.

### Concurrencia e idempotencia

- Frontend: Web Locks o lease localStorage + BroadcastChannel; TTL 45 s.
- Backend: wrapper `rpc_checkout_cart(uuid,jsonb)`, `rpc_operations` y lock del carrito.
- Alta/edición admin tiene RPCs atómicas e idempotencia específica (`rpc_create_admin_order_atomic`, `rpc_admin_add_order_items_atomic`, `admin_order_edit_idempotency`).
- Reintentos deben reutilizar el mismo `operation_id` para el mismo intento del usuario.

## CONTEXTO CONFIRMADO POR EL NEGOCIO

Estado: Vigente como regla comercial  
Fuente: Contexto confirmado por responsable del negocio; coincidencia parcial con código  
Última revisión: 2026-09-23

- Flujo conceptual: carrito → revisión → Hacer pedido → reserva/preparación → cierre → envío o retiro.
- Pedido normal: mínimo de 4 productos surtidos.
- Reserva estándar: 7 días desde la creación, normalizada en la sección anterior.
- Los recordatorios a 3, 2 y 1 día y al vencimiento son antecedentes de diseño, no política definitiva.

### Quitar ítem y reingreso de stock (admin)

**Clasificación: TÉCNICA VERIFICADA (local 361).** Fuente: `rpc_remove_order_item_restore_stock`  
Última revisión: 2026-09-24

Al quitar manualmente un producto con fuentes de stock (`order_item_stock_sources`):

- El admin elige si el producto **vuelve al stock físico** o no.
- Default sugerido: **No** si el ítem tiene `admin_confirmed_missing` (agregado con confirmación sin stock); **Sí** si se descontó de stock real.
- `p_restore_stock=false` audita `quitado_sin_reingreso` y no muta `variant_size_warehouse_stock`.
- Callers de cancelación completa / ✓ de cancelados siguen con default `true` (reingreso).

No se agrega fricción al **agregar** productos.


- **Faltante:** FyL no puede entregar uno de los productos esperados.
- **Cambio voluntario:** el cliente decide reemplazar un producto que sí estaba disponible.
- **Sustitución:** se quita un producto y se agrega otro con conocimiento del cliente.
- Los tres casos son distintos y no deben agruparse bajo una única transición o mensaje.
- Ante un faltante, FyL debe contactar al cliente, identificar claramente el producto afectado, explicar que no pudo confirmarse o entregarse y resolver el caso con él.
- Las alternativas principales son revisar lo ocurrido, reintegrar el importe correspondiente cuando corresponda o permitir que el cliente elija otro producto.
- El reemplazo no es obligatorio y FyL no debe hacer una sustitución silenciosa.
- Si el cambio es voluntario, el flujo esperado es quitar/cancelar el producto anterior y agregar el nuevo producto elegido por el cliente.

### Devoluciones y reintegros

**Clasificación: NEGOCIO CONFIRMADO.** Fuente: Contexto confirmado por responsable del negocio.

- En pedidos enviados, corresponden principalmente cuando el problema es responsabilidad de FyL: producto con falla, producto incorrecto, error de preparación u otro problema atribuible al negocio.
- No está confirmada una política general de devolución por arrepentimiento o cambio de preferencia para envíos.
- Los casos no contemplados deben escalarse para resolución manual.
- Siguen pendientes el procedimiento, responsables, evidencia, medio y plazo del reintegro, tratamiento fiscal/notas de crédito y requisitos legales aplicables.

## RPCs principales

- `rpc_checkout_cart(uuid,jsonb)` / `rpc_checkout_cart()`
- `rpc_customer_request_close`
- `rpc_close_order`
- `rpc_customer_cancel_order`
- `rpc_cancel_order_full`
- `rpc_cancel_order_item`, `rpc_cancel_order_item_units`
- `rpc_remove_order_item_restore_stock`
- `rpc_mark_order_items_picked`
- `rpc_split_order_item_status`
- `rpc_mark_order_item_waiting_source`
- `rpc_apply_order_stock_deduction`
- `rpc_admin_add_order_items_atomic`
- `rpc_orders_daily_maintenance`
- `rpc_delete_empty_order`

## Archivos clave

- `nj/hooks/useCart.ts`
- `nj/lib/cart/checkout-flow.ts`
- `nj/lib/cart/checkout-operation.ts`
- `nj/lib/cart/checkout-lock.ts`
- `nj/hooks/useOrders.ts`
- `nj/lib/orders/classification.ts`
- `nj/lib/supabase/order-queries.ts`
- `nj/lib/supabase/order-edit.ts`
- `supabase/canonical/174_rpc_checkout_cart_strong_idempotency.sql`
- `supabase/canonical/335_rpc_checkout_cart_effective_price.sql`
- `supabase/canonical/351_rpc_close_order_resolve_payment_by_transport.sql`
- `supabase/canonical/355_orders_daily_maintenance_grace_window.sql`
- `supabase/canonical/366_checkout_preserve_order_notes_extras.sql`
- `supabase/canonical/119_order_item_operational_and_empty_order_maint.sql`
- `supabase/canonical/127_rpc_delete_empty_order.sql`

## INFERIDO / DESCONOCIDO

- **Inferido:** las migraciones 351-358 son la línea de trabajo más reciente, pero varias están sin seguimiento Git y no prueban el estado productivo.
- **Desconocido:** SLA de preparación/despacho, quién puede forzar cada transición y excepciones comerciales por cliente.
- **Desconocido:** cadencia definitiva de avisos que debe conservarse como política, frente a las distintas implementaciones históricas.
- **Desconocido:** definición productiva exacta de todas las RPC después de parches dinámicos 336/337 y migraciones locales recientes.
- **Desconocido:** procedimiento legal y operativo completo para devoluciones, reintegros y notas de crédito, más allá de los criterios comerciales confirmados.
