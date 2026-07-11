# 06 — `reserved_qty` y `rpc_reconcile_stock`

> Definición de diffs: `supabase/canonical/175_stock_audit_bloque2_gate_reserved_qty.sql` (`vw_stock_audit_reserved_qty_diff`). Función: `176_rpc_reconcile_stock_reserved_qty.sql`.

## Qué representa `product_variants.reserved_qty`

- Campo **agregado a nivel variante** que resume cantidad reservada para pedidos activos (vía `order_item_stock_sources`) y carrito abierto B2B (`cart_items`) según excluyentes de estado en la vista 175.
- Debe alinearse con la **suma real** de reservas; desalineación → filas en `vw_stock_audit_reserved_qty_diff` y afecta el gate (175). El drift es acumulativo: se genera gradualmente cuando pedidos se cierran, cancelan o vencen sin recalcular este campo.
- **inflated** (stored > real): el sistema cree que hay más reservas de las que hay → stock disponible subestimado → puede bloquear pedidos innecesariamente.
- **deflated** (stored < real): el sistema cree que hay menos reservas de las que hay → stock disponible sobreestimado → **riesgo de sobreventa**. Prioridad de corrección.

## Cómo se incrementa / decrementa (visión lógica)

- **Al reservar / descontar** en flujos de pedido, checkout y carrito, el backend mantiene coherencia; la reconciliación corrige **drift** acumulado (bugs, migraciones, scripts).
- *Detalle de triggers por acción individual:* **pendiente de verificación** en una sola hoja (varias RPCs participan). Para auditoría, usar vistas y `rpc_reconcile_stock`.

## Vistas que auditan drift

| Vista | Uso |
|------|-----|
| `vw_stock_audit_reserved_qty_diff` | Diferencia entre `reserved_qty` y suma "real" (órdenes + carrito según 175) |
| `vw_stock_audit_variant_sizes_diff` | `variant_sizes` vs suma canónica |
| `vw_stock_audit_variant_warehouse_diff` | `variant_warehouse_stock` vs suma canónica |
| `vw_stock_audit_release_gate` | Incluye KPIs, `go_live_ready`, `blocking_reasons` (146+175) |

## Cómo correr `rpc_reconcile_stock`

> Permisos: **admin** (`admins.user_id = auth.uid()`) o `service_role`. Ver 176.

### ⚠️ `rpc_reconcile_stock(false)` NO es un dry-run

El parámetro `p_fix_reserved_qty` controla **solo** el bloque de `product_variants.reserved_qty`. Los otros dos bloques **siempre escriben**, sin importar el valor del parámetro:

- Actualiza y completa `variant_sizes.stock_qty` desde `variant_size_warehouse_stock`.
- Actualiza y completa `variant_warehouse_stock.stock_qty` desde `variant_size_warehouse_stock`.

**No existe modo de solo lectura total en esta función.** Para diagnosticar sin modificar nada, consultar las vistas `vw_stock_audit_*` directamente.

```sql
-- ESCRIBE variant_sizes y variant_warehouse_stock desde canónica.
-- NO es un dry-run. NO escribe product_variants.reserved_qty.
SELECT public.rpc_reconcile_stock(false);

-- ESCRIBE todo lo anterior + corrige product_variants.reserved_qty.
SELECT public.rpc_reconcile_stock(true);
```

### Permisos para ejecutar `rpc_reconcile_stock(true)` — Decisión 2026-05-04

**Decisión de negocio:** `rpc_reconcile_stock(true)` (que escribe `product_variants.reserved_qty`) es una operación crítica reservada a **super_admin**. Admins normales pueden ver las vistas de auditoría y ejecutar `rpc_reconcile_stock(false)`, pero no la variante que corrige reservas.

**Estado actual del sistema:** la RPC valida únicamente presencia en `public.admins`, sin distinción de rol super_admin. La validación granular **aún no está implementada en DB** — pendiente de migración SQL en FASE 6/7 del roadmap. Ver [[11-DECISIONES-TECNICAS]] §D6.

### Gap de UI: reserved_qty no se corrige desde admin/stock-audit.js

`admin/stock-audit.js` llama `rpc_reconcile_stock()` sin parámetro (equivale a `false`). El gate puede quedar en `no-go` por `reserved_qty_diffs` aunque el operador ejecute reconciliación desde la UI, porque `reserved_qty` nunca se corrige por esa ruta.

**Para corregir `reserved_qty` hay que ejecutar desde el SQL Editor de Supabase (solo super_admin):**

```sql
-- Paso 1: identificar variantes deflated (riesgo de sobreventa) antes de corregir
SELECT
  product_id, product_name, variant_id, variant_color, variant_sku,
  stored_reserved_qty, real_reserved_qty, order_sources_qty, cart_open_qty, delta, anomaly_type
FROM vw_stock_audit_reserved_qty_diff
WHERE anomaly_type = 'reserved_qty_deflated'
ORDER BY ABS(delta) DESC;

-- Paso 2: corregir todo el drift de reserved_qty
SELECT public.rpc_reconcile_stock(true);
```

### Orden recomendado ante gate no-go por reserved_qty_diffs

1. Consultar `vw_stock_audit_reserved_qty_diff WHERE anomaly_type = 'reserved_qty_deflated'` → revisar manualmente las variantes con stock sobreestimado.
2. `rpc_reconcile_stock(false)` → corrige diffs de `variant_sizes` y filas huérfanas (siempre escribe).
3. `rpc_reconcile_stock(true)` → corrige `reserved_qty` (solo desde SQL Editor).
4. Re-ejecutar `vw_stock_audit_release_gate` para verificar.

## Cómo interpretar el JSON de salida (176)

Estructura principal:

- `ok: true`
- `fix_reserved_qty_requested`: valor del parámetro
- `before` / `after`: conteos de filas con diff en `variant_sizes`, `variant_warehouse`, `orphan_rows`, `reserved_qty_diffs` **antes y después** de correr
- `rows_changed`: filas afectadas en tablas derivadas
- `reserved_qty`: `checked` (diffs iniciales), `fixed` (variantes corregidas), `remaining_diffs` (post), `affected_variant_ids` (hasta 50)

## Estado según auditoría 2026-05-04

| Métrica | Valor |
|---------|-------|
| Diffs `reserved_qty` | 782 |
| Deflated (sobreestimado, riesgo) | 4 |
| Inflated (subestimado) | 778 |

Ver [[24-AUDITORIA-STOCK-2026-05-04]] para detalle completo y plan de corrección.

## Migración 188 — liberación de `reserved_qty` al estado final (producción)

**SQL canónico:** `supabase/canonical/188_order_reserved_qty_release_on_final_status.sql`  
**Verificación post-deploy:** `supabase/canonical/188_POST_DEPLOY_VERIFICATION.sql` · plan manual previo: `supabase/canonical/188_STAGING_TEST_PLAN_order_reserved_release.md`.

### Motivo del fix

Al pasar un pedido a estado final excluido por `vw_stock_audit_reserved_qty_diff` (`sent`, `expired`, `devolución`), las filas de `order_item_stock_sources` dejan de contar en `real_reserved_qty` pero **`product_variants.reserved_qty` no se reducía** (p. ej. tras `rpc_apply_order_stock_deduction`). Eso producía **`reserved_qty_inflated`**, tarjeta «Stock disponible subestimado» en auditoría y necesidad recurrente de `rpc_reconcile_stock(true)` como parche.

188 corrige **solo** `reserved_qty` al entrar en ese estado final (transición desde **fuera** del conjunto final), con idempotencia por tabla **`order_reserved_qty_released`** (PK `order_id`). **No** modifica `variant_size_warehouse_stock`, **no** borra fuentes ni historial.

### Despliegue en producción

- **Estado:** migración **188 aplicada en producción** (confirmación operativa del equipo).
- **Backfill masivo:** **no** ejecutado; el trigger actúa **hacia adelante** en nuevas transiciones. El histórico previo se cierra con **`rpc_reconcile_stock(true)` una sola vez** (ver abajo), no con script masivo por pedidos.

### Reconciliación histórica (una vez)

Tras validar objetos y un caso `closed` → `sent`, se ejecutó **una sola vez**:

```sql
SELECT public.rpc_reconcile_stock(true);
```

**Registrar en bitácora operativa** (pegar aquí o en ticket): JSON de salida — en particular `reserved_qty.fixed`, `reserved_qty.remaining_diffs`, y el resultado de la query de infladas (sección 6 del SQL de verificación).

### Resultado de la verificación (completar operador)

| Comprobación | Resultado |
|--------------|-----------|
| Tabla `order_reserved_qty_released` | |
| Funciones `release_reserved_qty_for_order` / `trgfn_orders_release_reserved_qty_on_final_status` | |
| Trigger `trg_orders_release_reserved_qty_on_final_status` activo (`tgenabled = O`) | |
| Prueba `closed` → `sent`: fila en ledger + `reserved_qty` coherente + sin doble descuento | |
| Infladas **antes** `reconcile(true)` (query sección 6) | `inflated_rows=` ___ `total_delta=` ___ |
| Infladas **después** `reconcile(true)` | `inflated_rows=` ___ `total_delta=` ___ |

### Casos especiales (sin cambio en esta entrega)

- **`rpc_orders_daily_maintenance` / `expired`:** si las fuentes ya están en 0 antes del cambio de estado, el trigger puede no restar nada; ver comentario en `188_*.sql`. Sin backfill masivo por pedido.

## Migración 246 — asimetría en `rpc_remove_order_item_restore_stock` (producción, 2026-07-04)

**SQL canónico:** `supabase/canonical/246_fix_reserved_qty_release_picked_status.sql`

### Motivo del fix

`rpc_remove_order_item_restore_stock` (140) restauraba el stock físico correctamente para ítems en cualquier status no-`missing` (`picked`, `reserved`, `waiting`), pero solo liberaba `product_variants.reserved_qty` cuando el status era `reserved` o `waiting`. Como `picked` es el status dominante (~99.8% de los `order_items`, el caso normal cuando hay stock disponible al agregar el ítem), **cada vez que un admin quitaba un ítem `picked`** de un pedido (PAU, `admin/orders.js`, `admin/sent-orders.js`, `nj` dashboard, o `rpc_cancel_order_full` en su pase 2) el stock volvía pero `reserved_qty` quedaba inflado para siempre.

**Evidencia (producción, previa al fix):**
- `vw_stock_audit_reserved_qty_diff`: 2159 variantes con drift, **100% `reserved_qty_inflated`** (nunca deflated → nunca hubo riesgo de sobreventa por esta causa, pero sí bloqueos falsos de "stock insuficiente" en `rpc_checkout_cart`, que fue el síntoma que disparó la investigación).
- `stock_history`: 601 eventos históricos de esta RPC, **530 "fallback picked"** (el caso no cubierto), acumulados desde 2026-04-04.
- Funciones hermanas `rpc_cancel_order_item_units` (137) y `rpc_cancel_order_item_return_stock` (126) ya liberaban `reserved_qty` sin filtrar por status → confirma que la restricción de 140 era un bug, no una regla de negocio.

### Cambio aplicado

Único ajuste: la condición de liberación de `reserved_qty` pasó de `v_status in ('reserved', 'waiting')` a `v_status in ('picked', 'reserved', 'waiting')` — exactamente el mismo conjunto que ya usaba la propia función para decidir si restaura stock físico (rama fallback). `missing` se sigue excluyendo (nunca descontó stock).

**Callers de 140** (todos se benefician sin cambios de su lado): `admin/orders.js`, `admin/orders-ops.js` (PAU), `admin/sent-orders.js`, `nj/lib/supabase/order-queries.ts` (`rpcRemoveOrderItemRestoreStock`, `resolveStockPendingOrderRpc`), y transitivamente `rpc_cancel_order_full` (pase 2, ítems `picked`).

### Revisión previa al deploy

Antes de aplicar se verificó:
- Universo real de `order_items.status` en producción: solo `picked` (46195), `missing` (36), `reserved` (27) — sin statuses inesperados que pudieran colar un decremento indebido.
- Los 3 caminos que incrementan `reserved_qty` (`rpc_apply_order_stock_deduction` 166, `rpc_admin_manual_inject_and_deduct` 179, legacy `rpc_reserve_item`) lo hacen sin filtrar por status → liberar en `picked` es simétricamente correcto.
- No dispara el guard de canonicalidad (`150_guard_critical_rpc_versions.sql` solo protege `rpc_checkout_cart`/`rpc_close_order`/`rpc_void_public_sale`) ni el whitelist de RPCs críticas.
- Reversión: recrear la función con la condición anterior si hiciera falta.

### Gap conocido, no cubierto por 246 (dormant, 0 ocurrencias históricas) — **resuelto en 249, ver abajo**

`rpc_cancel_order_item` (85), usado por `rpc_customer_cancel_order` (235, cancelación de pedido por el cliente desde `nj` `ActiveOrderTab.tsx`), marca un ítem `picked` cancelado por el cliente como `status = 'cancelled'` **a propósito**, dejando el stock/`reserved_qty` pendiente de que el admin lo confirme luego vía 140. Pero 140 (incluso post-246) solo libera `reserved_qty` para `('picked','reserved','waiting')` — **no** para `'cancelled'**. Si ese flujo llegara a usarse, el mismo patrón de drift inflado reaparecería por esta vía. Verificado en su momento: **0 filas históricas** en `admin_notifications` con `notification_type = 'item_cancelled'` → nunca ocurrió en producción. Quedó documentado como deuda a resolver si/cuando se use ese flujo.

**Actualización:** el flujo ya se construyó y se usa activamente en el Kanban `nj` (botón "✓" sobre ítems cancelados → `confirmCancelledItem` en `nj/hooks/useOrders.ts` → `rpc_remove_order_item_restore_stock`). El gap dejó de ser dormant y se cerró en la migración 249 (sección siguiente).

## Migración 249 — cierre del gap `cancelled` / `missing con fuentes` (producción, 2026-07-10)

**SQL canónico:** `supabase/canonical/249_fix_reserved_qty_release_cancelled_and_missing_with_sources.sql`

### Motivo del fix

Auditoría de extremo a extremo de todos los flujos de stock (creación manual admin, edición de pedido, cancelación por cliente, confirmación admin de ítems cancelados, split picked/waiting/missing) pedida explícitamente por el usuario. Confirmó en código el gap ya documentado arriba, y encontró un segundo caso con el mismo patrón:

1. **Ítem `picked` → cancelado por cliente → confirmado por admin ("✓"):** `rpc_cancel_order_item` (126) pasa el ítem a `status='cancelled'` sin tocar `reserved_qty` ni borrar `order_item_stock_sources` (eso solo ocurre para `reserved`/`waiting`). Al confirmar con "✓", `rpc_remove_order_item_restore_stock` restaura el stock físico por fuentes (no filtra por status), pero **no liberaba `reserved_qty`** porque el status ya no era `picked`.
2. **Ítems `missing` con `order_item_stock_sources` reales:** heredados de `rpc_split_order_item_status` (129, split de un ítem que sí tenía reserva real) o creados por `rpc_admin_manual_inject_and_deduct` (179, `admin_confirmed_missing`, que incrementa `reserved_qty` explícitamente en su paso 4e). En ambos casos, al quitar el ítem se restaura stock físico por fuentes pero `'missing'` estaba excluido de la liberación de `reserved_qty`.

**Evidencia (producción, previa al fix, 2026-07-10):**
```sql
select anomaly_type, count(*) as n_variants, sum(abs(delta))::int as total_abs_diff
from vw_stock_audit_reserved_qty_diff group by anomaly_type;
```
- `reserved_qty_inflated`: 534 variantes, 2039 unidades de diferencia acumulada.
- `reserved_qty_deflated`: 2 variantes, 5 unidades.

### Cambio aplicado

La condición de liberación de `reserved_qty` en `rpc_remove_order_item_restore_stock` pasó de depender solo del status final (`v_status in ('picked','reserved','waiting')`) a depender de si la función efectivamente restauró stock:

```sql
if v_item.variant_id is not null
   and (v_has_sources or v_status in ('picked', 'reserved', 'waiting'))
then
  update product_variants set reserved_qty = greatest(coalesce(reserved_qty,0) - v_qty, 0) ...
```

Es exactamente la misma condición que ya gobierna la restauración de stock físico en esa función (bloque por fuentes + fallback). No cambia ningún otro comportamiento (stock físico, borrado de ítem, total del pedido, borrado de pedido vacío).

### Estado

- Migración aplicada en producción (`dtfznewwvsadkorxwzft` / fyl-core) el 2026-07-10 vía MCP `apply_migration`.
- **Drift histórico corregido el 2026-07-11** con aprobación explícita del usuario: `SELECT public.rpc_reconcile_stock(true)` (invocado con `SET LOCAL request.jwt.claim.role = 'service_role'` desde SQL Editor/MCP, ya que la sesión no tenía JWT de usuario admin). Resultado del JSON de salida:
  - `before.reserved_qty_diffs`: 555 (subió de 536 a 555 en las ~17h entre el diagnóstico inicial y la corrida, por actividad normal de pedidos).
  - `reserved_qty.fixed`: 555 — todas las variantes con drift corregidas.
  - `after.reserved_qty_diffs` / `remaining_diffs`: 0.
  - Efecto lateral menor, dentro del mismo call: 1 fila huérfana (`orphan_rows`) resuelta y 1 fila insertada en `variant_sizes`.
  - Verificación posterior: `SELECT count(*) FROM vw_stock_audit_reserved_qty_diff` → `0`.
- Verificación pendiente (funcional, no de datos): cancelar un ítem `picked` desde el dashboard cliente → confirmar con "✓" en el Kanban `nj` → comprobar que `reserved_qty` de esa variante baja correctamente en el próximo caso real (antes del fix 249 quedaba igual).

### Segunda fuente de drift detectada en vivo durante la revisión (sin resolver)

Mientras se validaba 246, la auditoría mostró nuevas filas `reserved_qty_inflated` apareciendo en tiempo real (crecimiento de 0 → 28 → 39 en ~15 min) sobre pedidos creados por la nueva feature `nj/order-edit` (aún sin commitear, en pruebas activas el mismo día). Se rastreó un caso puntual (pedido `4ca9ec56`, variante `M821` Cobre): sus filas de `order_item_stock_sources` desaparecieron sin dejar ningún registro en `stock_history` y sin que el `order_item` fuera borrado ni su status cambiara — patrón que **no coincide** con ninguna RPC auditada (`rpc_remove_order_item_restore_stock`, `rpc_cancel_order_item`, `rpc_cancel_order_full`) ni con código de `nj/lib/supabase/order-edit.ts` u `order-queries.ts` (ninguno escribe/borra `order_item_stock_sources` directamente salvo dentro de esas RPCs). Hipótesis más probable: edición manual de datos en Supabase Studio durante las pruebas, no un bug de aplicación — pero no se pudo confirmar. **Pendiente:** re-auditar `vw_stock_audit_reserved_qty_diff` cuando terminen las pruebas de `nj/order-edit` para confirmar si el drift se estabiliza tras 246 o si sigue creciendo por esta causa no identificada.

## Enlaces

- [[07-RELEASE-GATE-Y-AUDITORIA]] · [[04-RPCS-CRITICAS]] · [[24-AUDITORIA-STOCK-2026-05-04]] · `docs/STOCK_GOVERNANCE.md` §3
