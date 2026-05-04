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

## Enlaces

- [[07-RELEASE-GATE-Y-AUDITORIA]] · [[04-RPCS-CRITICAS]] · [[24-AUDITORIA-STOCK-2026-05-04]] · `docs/STOCK_GOVERNANCE.md` §3
