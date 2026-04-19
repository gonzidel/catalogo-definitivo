# Reglas operativas de stock (FYL Admin)

Documento breve para alinear criterios entre pantallas. No reemplaza migraciones ni la base productiva.

## Tres pantallas

| Pantalla | Uso |
|----------|-----|
| **Productos** (`products.html`) | Alta/edición de artículo y **talles con cantidades**. Guarda vía `rpc_save_product_variant_initial_stock` (fuente canónica: `variant_size_warehouse_stock` en depósito `general`). |
| **Stock** (`stock.html`) | Operación diaria: stock por **talle × depósito** (`general` / `venta-publico`), carga incremental, historial. |
| **Mover stock** (`move-stock.html`) | Traslado entre depósitos vía **RPC** `rpc_move_size_stock` (con registro en `stock_movements`). |

## Regla práctica

- El **detalle fiable por depósito** (sobre todo `venta-publico`) se controla en **Stock** y **Mover stock**.
- Tras cargar talles en **Productos**, si el producto ya vende o reparte entre depósitos, **conviene verificar** en **Stock** que los saldos por depósito coincidan con la operación.

## Coherencia

- La fuente de verdad operativa es **`variant_size_warehouse_stock`**.
- Trigger **84** sincroniza `variant_sizes.stock_qty` desde `variant_size_warehouse_stock`.
- Trigger **145** sincroniza `variant_warehouse_stock.stock_qty` desde `variant_size_warehouse_stock`.
- `variant_sizes` y `variant_warehouse_stock` deben tratarse como capas derivadas de lectura/compatibilidad.
- Si hay diferencias entre capas, ejecutar `rpc_reconcile_stock` desde Auditoría.

## Auditoría

- Vista operativa: `stock-audit.html` (release gate + anomalías + timeline).
- Consultas **solo lectura**: `scripts/stock-consistency-checks-readonly.sql`.
- Criterio de lanzamiento: `vw_stock_audit_release_gate.go_live_ready = true`.
