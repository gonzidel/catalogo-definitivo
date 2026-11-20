# 76 — Auditoría: "Archivar" pedido vencido falla + regla de 5 días para pedidos todo sin stock (2026-11-20)

Clasificación: **TÉCNICA VERIFICADA** (código y producción, solo lectura) para el bug; **NEGOCIO CONFIRMADO** (pedido del dueño el 2026-11-20) para la regla de 5 días.

Estado: migraciones **410** y **411/411b** escritas en ramas; **no aplicadas en producción** al momento de esta nota.

## Caso disparador

Pedido `A58953` (Gesica Croce, id `431560a8-9b3f-41fe-ac32-60bf128ccdf9`): creado 2026-11-10, 3 ítems, los 3 `missing` (sin stock). La clienta no quitó ni agregó nada. El admin recibió el aviso de "por vencer" y, al intentar eliminarlo (botón **Archivar** en la columna Vencido, porque el pedido ya estaba `expired`), apareció:

> `rpc_cancel_order_full: el pedido ... no quedó elegible para borrado tras cancelar ítems operacionales`

Logs de Postgres: 2026-11-19 16:03 y 2026-11-20 12:40 UTC (mismo error).

## Bug 1 — `rpc_cancel_order_full` toma "pedido ya borrado" como "no elegible"

Mecanismo (leído del código desplegado, no reproducido en producción):

1. Pase 1 cancela los ítems `reserved/waiting/missing` con `rpc_cancel_order_item`.
2. Al cancelar el último, el trigger `order_items_after_cancelled_try_empty_order` (319) ya borra el pedido (`maint_try_delete_order_if_eligible`).
3. El chequeo final vuelve a llamar a `maint_try_delete_order_if_eligible`, que devuelve `false` porque el pedido no existe → la RPC lanza la excepción y revierte todo.

Con ítems `picked` no pasaba: el Pase 2 (`rpc_remove_order_item_restore_stock`) sí propaga `order_deleted`.

Evidencia: los únicos pedidos vencidos que llevan semanas sin poder archivarse son los que no tienen ningún ítem `picked`:

| Pedido | Ítems | Vencido desde |
|---|---|---|
| A57551 | 2 `reserved` | 2026-10-07 |
| A58319 | 1 `reserved` | 2026-10-28 |
| A58710 | 1 `reserved` | 2026-11-11 |
| A58953 | 3 `missing` | 2026-11-18 |

Aclaración: solo `A58953` es "vencido + todo sin stock". Los otros tres tienen stock real reservado (se devolvería al archivar); comparten el síntoma, no el origen comercial.

Arreglo: migración `410_rpc_cancel_order_full_order_already_deleted.sql` (un único bloque nuevo tras el Pase 1: si el pedido ya no existe, `v_order_deleted := true`). Rollback `410_ROLLBACK_...` (vuelve a 267).

## Drift repo vs producción detectado

- Producción: `order_has_cancelled_items_pending_stock_return` usa `cancelled_from_status <> 'missing'`; la migración 319 del repo usa `admin_confirmed_missing`.
- Producción: el trigger `order_items_after_cancelled_try_empty_order` tiene una condición extra (no actuar si el pedido ya está `cancelled`) que no está en el repo.
- Producción: `rpc_cancel_order_full` = 267 (sin diferencias).
- `OrderActions.tsx` (modal "Archivar pedido vencido") dice "el stock ya volvió al sistema automáticamente al vencer", pero la mantención desplegada deja ítems y fuentes reservados hasta que un admin archiva. Además cuenta como "unidades a sumar" las fuentes de ítems `missing`, que en realidad se dan de baja sin devolver stock (`writeoff_missing`). **Pendiente de corregir; no se tocó para no ampliar el alcance.**

## Regla de 5 días (migración 411 / 411b)

Decisiones del dueño (2026-11-20):

- Solo pedidos con **todos** los ítems `missing`. Pedidos con cualquier ítem `reserved/waiting/picked` no se tocan.
- Se cuenta desde `orders.created_at` (5 días).
- Retira Local diferido (`local_deferred_pickup = true`) queda **fuera**.
- Aviso a la clienta solo en "Mi pedido" (sin WhatsApp).

Verificación previa en producción (solo `SELECT`, 2026-11-20): **0 candidatos** con el criterio de 411 → activar la regla no toca ningún pedido existente.

Camino de borrado: `cleanup_missing_order_item_sources` (sin devolver stock, deja `writeoff_missing` con `quantity_changed = 0`) → `UPDATE order_items SET status='cancelled'` → trigger borra el pedido y deja `order_empty_deletion_audit` (source `trigger_order_items_cancelled`).

Activación en dos pasos: 411 (función, con `p_dry_run`) y 411b (cron horario `7 * * * *`). Rollback: `411_ROLLBACK_...` (desprograma y borra la función).

## Deuda restante

- `A58763`, `A58863`, `A58941`: Retira Local diferido, todo `missing`, sin `dismantle_at`/`expires_at` → nunca vencen. Decisión del dueño: tratarlos aparte.
- Corregir texto/cálculo del modal "Archivar pedido vencido" (ver drift).
- Sincronizar `supabase/canonical` con las definiciones reales de producción (319 y trigger de cancelados).

## Verificación post-deploy sugerida (solo lectura)

1. Tras 410: archivar `A58953` desde Orders → desaparece; fila en `order_empty_deletion_audit`; `stock_history` con `writeoff_missing`, `quantity_changed = 0`; `variant_size_warehouse_stock` de J25 Verde 37/38 sin cambios.
2. Tras 411: `SELECT public.rpc_orders_auto_delete_all_missing(20, true);` devuelve la cantidad esperada (0 hoy) antes de aplicar 411b.
