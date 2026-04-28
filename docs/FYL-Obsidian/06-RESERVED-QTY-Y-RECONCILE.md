# 06 — `reserved_qty` y `rpc_reconcile_stock`

> Definición de diffs: `supabase/canonical/175_stock_audit_bloque2_gate_reserved_qty.sql` (`vw_stock_audit_reserved_qty_diff`). Función: `176_rpc_reconcile_stock_reserved_qty.sql`.

## Qué representa `product_variants.reserved_qty`

- Campo **agregado a nivel variante** que resume cantidad reservada para pedidos activos (vía `order_item_stock_sources`) y carrito abierto B2B (`cart_items`) según excluyentes de estado en la vista 175.
- Debe alinearse con la **suma real** de reservas; desalineación → filas en `vw_stock_audit_reserved_qty_diff` y afecta `health_score` / gate (175).

## Cómo se incrementa / decrementa (visión lógica)

- **Al reservar / descontar** en flujos de pedido, checkout y carrito, el backend mantiene coherencia; la reconciliación corrige **drift** acumulado (bugs, migraciones, scripts).
- *Detalle de triggers por acción individual:* **pendiente de verificación** en una sola hoja (varias RPCs participan). Para auditoría, usar vistas y `rpc_reconcile_stock`.

## Vistas que auditan drift

| Vista | Uso |
|------|-----|
| `vw_stock_audit_reserved_qty_diff` | Diferencia entre `reserved_qty` y suma “real” (órdenes + carrito según 175) |
| `vw_stock_audit_variant_sizes_diff` | `variant_sizes` vs suma canónica |
| `vw_stock_audit_variant_warehouse_diff` | `variant_warehouse_stock` vs suma canónica |
| `vw_stock_audit_release_gate` | Incluye KPIs, `go_live_ready`, `blocking_reasons` (146+175) |

## Cómo correr `rpc_reconcile_stock`

> Permisos: **admin** (`admins.user_id = auth.uid()`) o `service_role`. Ver 176.

**Importante (176):** el parámetro `p_fix_reserved_qty` gobierna **solo** el bloque de corrección de `product_variants.reserved_qty`.  
Los bloques de reconciliación de **`variant_sizes` y `variant_warehouse_stock` desde canónica sí ejecutan escrituras** al llamar la función (comportamiento heredado de 146) — no es un “dry-run” global de todo el stock derivado.  
*Si hace falta un modo solo lectura total, no está en esta función — pendiente de verificación de requisito.*

```sql
-- Corrige tablas derivadas (variant_sizes / variant_warehouse) desde canónica;
-- reserva: solo cuenta diff de reserved, NO escribe product_variants.reserved_qty
SELECT public.rpc_reconcile_stock(false);

-- Además: escribe product_variants.reserved_qty según la vista de diff
SELECT public.rpc_reconcile_stock(true);
```

## Cómo interpretar el JSON de salida (176)

Estructura principal:

- `ok: true`
- `fix_reserved_qty_requested`: valor del parámetro
- `before` / `after`: conteos de filas con diff en `variant_sizes`, `variant_warehouse`, `orphan_rows`, `reserved_qty_diffs` **antes y después** de correr
- `rows_changed`: filas afectadas en tablas derivadas
- `reserved_qty`: `checked` (diffs iniciales), `fixed` (variantes corregidas), `remaining_diffs` (post), `affected_variant_ids` (hasta 50)

## Enlaces

- [[07-RELEASE-GATE-Y-AUDITORIA]] · [[04-RPCS-CRITICAS]] · `docs/STOCK_GOVERNANCE.md` §3
