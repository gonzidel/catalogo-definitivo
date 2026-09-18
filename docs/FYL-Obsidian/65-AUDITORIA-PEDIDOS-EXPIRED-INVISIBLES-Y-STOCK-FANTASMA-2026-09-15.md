# 65 — Auditoría: pedidos "vencidos" invisibles, stock fantasma reservado y notificaciones muertas (2026-09-15)

Ver también: [[46-NJ-KANBAN-PEDIDOS-ADMIN-2026-07-15]], [[47-VENCIMIENTO-PEDIDOS-DIA-HABIL-2026-08-01]], [[48-AUDITORIA-ESTADOS-PEDIDOS-Y-FIXES-2026-08-01]], [[06-RESERVED-QTY-Y-RECONCILE]], [[60-AUDITORIA-CARGA-MASIVA-QR-2026-09-04]], [[64-AUDITORIA-STOCK-FANTASMA-CHECKOUT-2026-09-14]].

## Origen

El usuario reportó pedidos "desaparecidos" de clientas puntuales (Manuela Soledad Rodríguez, Pablik Patricia Alejandra, Galeano Zulma, Ramallo Mabel, etc.). No estaban borrados: `rpc_orders_daily_maintenance()` los había pasado a `status='expired'` normalmente, pero un bug de paginación en `fetchOrdersInitial` (fix `138e54c`, 2026-09-10) los dejaba fuera del fetch inicial del Kanban — y aunque se corrigiera eso, **`expired` estaba tratado como estado terminal** (`isFinalOrderStatus`) en `nj/lib/orders/classification.ts`, así que `getOrderKanbanColumn` devolvía `null` y el pedido no vivía en ninguna columna. Resultado: pedidos vencidos completamente invisibles en todo el admin, sin poder avisar a la clienta ni "Desarmar"/archivar.

## Hallazgos y fixes de esta sesión (orden cronológico)

### 1. `expired` deja de ser estado terminal invisible

- `nj/lib/orders/classification.ts` — `isFinalOrderStatus` ya no incluye `expired`. `getOrderKanbanColumn` clasificaba `status='expired'` en `"cancelled"` (2026-09-15); desde 2026-09-18 va a la columna **`"expired"` / Vencido** (ver § seguimiento abajo).
- `nj/lib/supabase/order-queries.ts` — `OPERATIONAL_STATUS_FILTER` sacó `expired` del `.not("status","in",...)` de `fetchOrdersInitial`. Solo 63 filas totales a la fecha del cambio, no hizo falta acotar por fecha.
- `nj/hooks/useOrders.ts` (`patchOrder`) — ya no expulsa del store pedidos que lleguen a `expired` vía realtime.
- Nueva función `searchOrdersGlobal()` en `order-queries.ts`: búsqueda global sin filtro de status, integrada en el buscador de columna existente (`KanbanColumn.tsx`, debounce 350ms) — muestra resultados "Fuera del tablero" vía `OrderSearchResultCard.tsx` (solo lectura) para pedidos en estado terminal (`expired`/`sent`/`devolución`) que igual conviene poder ubicar por nombre/DNI/Nº de pedido.

### 2. Acciones nuevas para pedidos ya `expired` (columna Cancelados)

- **"Archivar"** (antes "Desarmar", mismo botón, texto condicional): para `status='expired'` el modal aclara que el stock ya volvió solo al vencer (cron), y muestra dinámicamente cuánto stock real (si alguno) se sumaría al confirmar, vía nueva query `fetchPendingStockReturnQty` (suma `order_item_stock_sources.qty` de los ítems del pedido).
- **"+24hs" / Reabrir**: nueva RPC `rpc_admin_reopen_expired_order(p_order_id)` — pasa los ítems `expired` a `picked` (Apartados) y el pedido a `active` con nuevo `dismantle_at`, **sin tocar stock** (estos pedidos vienen de la carga masiva QR del 2026-09-05, ver [[60-AUDITORIA-CARGA-MASIVA-QR-2026-09-04]], donde el producto ya estaba físicamente apartado sin reserva formal en el sistema).
- **"Ya enviado"**: nueva RPC `rpc_admin_mark_expired_order_sent(p_order_id)` — corrige pedidos `expired` que en realidad ya se entregaron fuera del sistema (WhatsApp). Solo cambia `status`→`sent` y `closed_at`, no toca stock ni ítems. Caso real: A56173 (Juana Antonella Palomo), enviado el 8/9 pero nunca actualizado.
- Botón de aviso por WhatsApp ("Mensaje/Enviar") habilitado también en desktop (antes solo mobile, gate `isMobile` innecesario para esta acción puntual).

### 3. Bug: "Marcar sin stock" en Activos podía terminar devolviendo stock fantasma

Reportado con casos reales A56971/A56917: Fati usaba "Quitar producto" (✕) sobre un ítem ya `picked` para marcarlo sin stock. Eso corre `rpc_cancel_order_item` → status `cancelled`, pendiente de confirmación (✓) → `rpc_remove_order_item_restore_stock`, que **siempre** devuelve el stock si hay `order_item_stock_sources`, sin importar si el motivo real era "no hay stock físico". Además, la columna Cancelados mostraba el banner "producto(s) cancelado(s) por la clienta" aunque la acción fuera de un admin.

**Fix:** dos RPCs nuevas, sin tocar la lógica de cancelación normal (que sigue siendo correcta para el caso real "la clienta canceló y sí hay que devolver stock"):
- `rpc_admin_mark_item_missing(p_item_id)` — da de baja la reserva real (si existe) con un registro `writeoff_missing` en `stock_history`, sin sumar nada a `stock_qty`. Extiende "Marcar sin stock" también a la columna Apartados (antes solo existía en Activos, `showActiveReservedActions`).
- `rpc_admin_remove_cancelled_item_writeoff(p_order_item_id)` — equivalente al botón ✓ pero sin devolver stock, para ítems que ya quedaron `cancelled` con la reserva fantasma.
- UI: `OrderCardItems.tsx` ahora tiene botón "!" (marcar sin stock) junto al ✕ en Apartados, y "!"+✓ en Cancelados.

### 4. Limpieza de pedidos `expired` viejos/mal clasificados

45 pedidos `expired` en total. 22 creados antes de 2026-09-05 (previos a la carga masiva QR, sin motivo de seguir ahí). De esos, solo A55615 tenía 1 unidad real pendiente de devolver; el resto, cero impacto de stock.

- A56173 (Palomo Juana) → marcado `sent` vía `rpc_admin_mark_expired_order_sent`.
- Los otros 21 → archivados vía `rpc_cancel_order_full` (uno por uno, con aislación de errores). Verificado en `order_empty_deletion_audit`: 21 filas nuevas. Quedan solo pedidos `expired` desde 2026-09-05 en adelante.

### 5. Follow-up 2026-09-16 — `missing` cancelado con fuente obsoleta volvía a Cancelados

**Caso real:** A57074 (Dahiana Eren), GLE Negro T.38. El producto había sido marcado sin stock y luego la clienta lo quitó. La fila quedó `cancelled` + `admin_confirmed_missing=true`, pero conservó una `order_item_stock_sources.qty=1`. El stock real y reservado de la variante/talle eran 0. Por el criterio conservador de la migración 340 (`cancelled` + fuente positiva), el Kanban interpretó esa traza como una pieza física pendiente de devolver y mandó todo el pedido a Cancelados. Confirmar con ✓ habría podido acreditar una unidad fantasma.

**Causa:** `admin_confirmed_missing` no alcanza para distinguir el origen porque también se usa en altas manuales `picked` con fuentes reales (A56782/A56807). La señal inequívoca existe solo durante la transición de estado: `OLD.status='missing'` → `NEW.status='cancelled'`.

**Fix aplicado en producción:** migración `344_cleanup_missing_sources_on_cancel.sql`:

- agrega la trazabilidad `order_items.cancelled_from_status` y la completa al pasar cualquier fila a `cancelled`;
- el trigger de transición solo limpia fuentes cuando `cancelled_from_status='missing'`;
- registra las fuentes como `writeoff_missing` con delta 0;
- elimina `order_item_stock_sources` sin sumar stock a ningún depósito;
- no modifica `reserved_qty`: una fuente obsoleta no prueba que esa reserva siga contabilizada, y recalcularla durante mutaciones concurrentes del carrito podría pisar reservas legítimas; cualquier drift previo queda para `rpc_reconcile_stock`;
- fuerza `admin_confirmed_missing=true`;
- no afecta altas manuales, porque estas pasan de `picked → cancelled`.
- `order_has_cancelled_items_pending_stock_return` y `cancelledItemNeedsStockConfirmation` ignoran fuentes cuando `cancelled_from_status='missing'`; así una escritura concurrente tardía tampoco reclasifica el pedido ni habilita una devolución fantasma.

No incluye backfill automático: los cancelados históricos con `admin_confirmed_missing=true` son ambiguos y deben revisarse caso por caso. Rollback: `344_ROLLBACK_cleanup_missing_sources_on_cancel.sql` (quita trigger y función; no recrea trazas descartadas porque reintroduciría el riesgo).

### 6. Follow-up 2026-09-16 — doble descuento del total al confirmar “sin devolver stock”

Al resolver manualmente A57074 se confirmó otro bug: `rpc_cancel_order_item` ya había descontado GLE ($8.500) del total ($59.000 → $50.500). Después, `rpc_admin_remove_cancelled_item_writeoff` volvió a restar la misma línea al eliminarla, dejando el pedido enviado en $42.000 aunque sus cinco ítems restantes suman $50.500.

**Fix aplicado en producción:** `345_fix_cancelled_writeoff_double_total.sql` redefine la RPC para:

- no modificar `orders.total_amount` al confirmar un ítem ya cancelado;
- liberar `reserved_qty` por la suma de fuentes, no por `quantity`;
- no liberar otra vez si 344 prueba `cancelled_from_status='missing'`;
- mantener el writeoff con delta 0 y el borrado seguro del ítem.

La reparación de A57074 es un cambio de datos separado y debería llevar el total de $42.000 a $50.500 con guardas exactas sobre pedido, estado y suma de ítems. El usuario aprobó solo la migración 345, no la corrección del dato; A57074 quedó sin modificar en $42.000.

### 7. Follow-up 2026-09-17 — cancelación completa sin contrato verificable (Romina Ferster / A56917)

**Síntoma:** el dashboard podía mostrar “pedido cancelado” aunque el frontend solo hubiera comprobado `error=null`; ignoraba por completo el JSON de `rpc_customer_cancel_order` y mostraba el modal de éxito antes de refrescar. A56917 siguió `active` en base de datos y el checkout del 16/9, correctamente, anexó los productos al pedido abierto del 11/9. No hubo reapertura de un pedido terminal: la cancelación reportada nunca dejó evidencia persistida.

**Segundo defecto confirmado en el contrato anterior:** el trigger 319 podía borrar el pedido al cancelar la última línea, antes del `UPDATE orders SET status='cancelled'` ejecutado al final de la RPC. Por eso el JSON podía informar un resultado distinto del estado real y el pedido desaparecer del seguimiento admin.

**Fix preparado, todavía no aplicado en producción:** `346_fix_customer_cancel_verified_terminal_order.sql`:

- marca primero el pedido `cancelled` y luego cancela sus líneas dentro de la misma transacción;
- el trigger 319 no autoelimina líneas si el padre ya está `cancelled`;
- comprueba antes de responder que el pedido siga terminal y que no quede ninguna línea no cancelada;
- retorna `ok=true` + `verified=true` únicamente después de cumplir esas postcondiciones;
- permite reintento idempotente si el pedido ya estaba `cancelled` o si una versión vieja lo archivó y existe recibo en `order_empty_deletion_audit`;
- registra un recibo independiente en `customer_order_cancellation_audit`, que sobrevive al archivado posterior;
- conserva el pedido en Cancelados hasta que el admin use “Desarmar”;
- el checkout vigente solo reutiliza `active/closing_soon`, así que el siguiente checkout crea un pedido y `order_number` nuevos.

Frontend preparado:

- `rpcCustomerCancelOrder` valida ID, `verified=true` y coherencia `cancelled/deleted`;
- `ActiveOrderTab` no cierra el modal ni muestra éxito si falta esa confirmación;
- el dashboard legacy dejó de cancelar ítems/direct CRUD por separado y usa la misma RPC atómica;
- una operación checkout ya `completed` nunca se reutiliza como una compra nueva solo porque coincide el fingerprint; únicamente los intentos que ya estaban esperando el mismo lock comparten el resultado;
- al confirmar una cancelación se limpia el recibo local del checkout anterior;
- `OrderCard` muestra todas las líneas canceladas del pedido terminal, no solo las que aún tienen stock pendiente.

**Validación 2026-09-17:** la rama Supabase temporal no pudo reconstruirse porque el historial remoto solo contiene cinco migraciones tardías de hardening; fue eliminada inmediatamente. Se descargó únicamente el esquema productivo, sin datos, y se restauró en PostgreSQL/Supabase local. Allí 346 y su rollback compilaron y se reaplicaron correctamente. Los fixtures transaccionales (`346_customer_cancel_runtime_tests.sql`) pasaron para reservado, picked con fuente pendiente, replay, auditoría, permisos, conservación en Cancelados y creación de otro pedido/número. Una prueba con dos sesiones reales confirmó la carrera: checkout insertó mientras cancelación estaba en vuelo; la cancelación quedó verificada y el insert concurrente fue rechazado al commit, sin línea residual.

**Despliegue seguro:** backend 346 primero; después frontend. Rollback: `346_ROLLBACK_fix_customer_cancel_verified_terminal_order.sql` + versión frontend anterior. El rollback conserva deliberadamente `customer_order_cancellation_audit` para no destruir evidencia; no requiere revertir stock.

## Auditoría final de "problemas del mismo tipo nunca detectados" (2026-09-15, esta sesión)

Se pidió explícitamente auditar más problemas de la misma familia (estados/flags que quedan invisibles o sin consumidor). Se encontraron y resolvieron/documentaron:

### A) 🔴 Crítico, corregido — `reserved_qty` inflado en 1567 variantes (11.172 unidades bloqueadas del catálogo público)

`vw_stock_audit_reserved_qty_diff` mostró **1578 filas de drift** (1567 `reserved_qty_inflated` = 11.172 unidades, 11 `reserved_qty_deflated` = 22 unidades) — significativamente peor que baselines previos (246/555 filas en agosto, ver [[06-RESERVED-QTY-Y-RECONCILE]]). Esto bloqueaba stock real de aparecer como disponible en el catálogo público (pérdida de ventas activa).

**Acción aprobada y ejecutada:** `SELECT public.rpc_reconcile_stock(true);` (misma función usada y aprobada en auditorías previas de agosto, no destructiva — recalcula `variant_sizes.stock_qty`, `variant_warehouse_stock.stock_qty` y `product_variants.reserved_qty` desde las tablas fuente reales, nunca toca `variant_size_warehouse_stock`).

**Resultado verificado:**
```json
{
  "before": {"reserved_qty_diffs": 1578, "orphan_rows": 22},
  "after":  {"reserved_qty_diffs": 0,    "orphan_rows": 0},
  "reserved_qty": {"checked": 1578, "fixed": 1578, "remaining_diffs": 0}
}
```
`SELECT count(*) FROM vw_stock_audit_reserved_qty_diff` post-fix: **0**.

No se investigó a fondo la causa raíz del nuevo drift acumulado desde agosto (probablemente combinación normal de carritos abiertos/abandonados + los mismos flujos ya identificados en 249/260/266 — el fix de esos huecos evita que se genere drift *nuevo*, pero no hay reconciliación automática periódica, solo manual on-demand). **Pendiente a futuro:** evaluar si conviene un cron periódico de reconciliación (ej. semanal) en vez de depender de auditorías manuales esporádicas.

### B) 🔴 Crítico, no corregido (decisión del usuario: descartado por ahora) — sistema de notificaciones automáticas nunca conectado

`supabase/canonical/256_order_notifications_dispatch_webhook.sql` diseña un consumidor completo (función `rpc_dispatch_pending_order_notifications`, tabla `app_settings` con la URL del webhook n8n, cron cada 5 min) para el outbox `public.order_notifications` (que sí se sigue poblando desde `123_order_expiry_and_notifications.sql` / `rpc_orders_daily_maintenance`). **Confirmado que esa migración nunca se aplicó a producción**: ni la función, ni `app_settings`, ni el cron existen en `fyl-core`.

**Estado real (verificado en vivo):** `order_notifications` tiene **1622 filas, 0 con `sent_at`**, la más vieja de **2026-03-10**. Desglose por tipo: `MIN_REACHED` 743, `MIN_MISSING` 371, `DAY_4` 253, `DAY_6` 140, `DAY_7` 69, `EXPIRED` 30, `DAY_11` 9, `DAY_13` 7. Ninguno se envió jamás desde que existe la tabla.

Nota: esto es un sistema **distinto** del que sí funciona (`admin_order_message_notifications` / `rpc_enqueue_customer_closed_notifications`, migración 305 — cola de mensajes que el admin dispara manualmente al cerrar un pedido, healthy: 0 pendientes sin dismiss). El outbox muerto es específicamente el de recordatorios proactivos (carrito con mínimo alcanzado/faltante, avisos de vencimiento por día).

**Decisión del usuario (2026-09-15):** no es prioridad ahora, se deja apagado. Si en el futuro se decide activarlo, hace falta: (1) crear el webhook receptor en n8n, (2) aplicar la migración 256 (o una versión actualizada) en producción, (3) setear `app_settings.n8n_order_notifications_webhook_url`. Las 1622 filas actuales podrían enviarse igual una vez conectado (son "atrasadas" pero el contenido sigue siendo válido) o limpiarse antes si se prefiere empezar de cero — no decidido.

### C) 🟡 Medio, pendiente de revisión puntual — ventas confirmadas sin descuento real de stock

`vw_stock_audit_untracked_sales_watchlist` (vista nueva, creada el 2026-09-14, nunca revisada hasta hoy). Total histórico (30 días): 818 filas / 2081 unidades. Filtrando solo desde el 2026-09-05 (después del reajuste de stock por carga masiva QR, ver [[60-AUDITORIA-CARGA-MASIVA-QR-2026-09-04]] — antes de esa fecha el usuario indicó que no importa):

- **361 filas / 796 unidades** relevantes.
- `admin_order_confirmado_sin_verificar`: 259 filas / 676 unidades — admin confirmó ítems de pedido sin que el sistema verificara el descuento real de stock.
- `public_sale_sin_stock`: 152 filas / 405 unidades — venta pública confirmada con motivo explícito "vender sin stock" (`343_public_sale_sell_without_stock_reason`) cuando el sistema ya mostraba 0 en ese talle.

Esto es principalmente una lista de **atención/awareness** (varios de estos casos son ventas intencionales con motivo registrado, no bugs), pero el riesgo real es el opuesto al hallazgo A: acá el sistema podría estar **sobreestimando** el stock disponible (mostrando como vendible algo que ya se vendió sin descontarse), es decir riesgo de sobreventa en el catálogo público.

**No se corrigió stock en este punto** — requiere revisión caso por caso (no es seguro descontar en bloque sin chequear cada variante, podría llevar algún talle a negativo). **Pendiente:** revisar la lista completa (361 filas) y decidir qué unidades corregir manualmente.

## Verificación general post-sesión

- `cron.job_run_details` (14 días): 0 fallos en `orders-daily-maintenance` (jobid 1) ni `catalog-snapshot-refresh-if-dirty` (jobid 2).
- `orders.status`: sin valores inesperados fuera del set conocido (`active`, `closing_soon`, `closed`, `sent`, `devolución`, `expired`, `cancelled`).
- Sin `stock_qty` ni `reserved_qty` negativos en toda la base.
- `rpc_close_order` ya tiene el guard server-side (rechaza cerrar con ítems `reserved`/`waiting`/`awaiting_apartado` pendientes) — el hallazgo "pendiente" de [[48-AUDITORIA-ESTADOS-PEDIDOS-Y-FIXES-2026-08-01]] ya está resuelto en producción.

## Pendiente / no incluido en este cambio

- Reconexión del outbox de notificaciones automáticas (`order_notifications` → webhook) — descartado por el usuario por ahora (punto B).
- Revisión caso por caso de las 361 filas de `vw_stock_audit_untracked_sales_watchlist` posteriores al 2026-09-05 — no se decidió corrección de stock todavía (punto C).
- Evaluar cron periódico de reconciliación de `reserved_qty` en vez de depender de auditorías manuales (para que el drift de 11.172 unidades no se vuelva a acumular silenciosamente).

---

## Seguimiento 2026-09-18 — columna Kanban **Vencido**

Los pedidos por tiempo ya **no viven en Cancelados**. Nueva columna `expired` / label **Vencido** en Pedidos y Retiro:

| Semáforo | Criterio | Acciones |
|---|---|---|
| Amarillo | ≤1 día calendario para `dismantle_at` | Mensaje (aviso por vencer) / Enviar / +24hs / Desarmar |
| Rojo | plazo vencido o `status=expired` | Mensaje vencido / Enviar / +24hs / Ya enviado / Archivar\|Desarmar |
| Azul | `admin_order_expiry_warn_sent.sent_at` &lt; 24h | mismo set; baja al final de la lista |

- Cancelados queda solo para cancelaciones reales (ítems/pedido), respetando `cancelled_from_status` (344).
- Migración canónica `349_admin_expiry_kanban.sql`: versiona reopen/mark-sent (ya en prod), lista con `sent_at`, clear tras +24hs. **Aplicar en prod con aprobación explícita.**
- Riesgo reopen sin stock: sin cambio de política (sigue sin tocar stock; ver §2 y nota 60).
