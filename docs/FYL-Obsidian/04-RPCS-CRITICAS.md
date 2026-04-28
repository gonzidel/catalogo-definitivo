# 04 — RPCs críticas (saneamiento FYL)

> Referencia de implementación en `supabase/canonical/`. La migración “ganadora” es la de **número más alto** si hay redefiniciones. Para despliegue, ver [[13-RPCS-DEPLOY-STATE]] (si está actualizado) o comparar con DB real.

Leyenda **Idem.:** idempotente vía `rpc_operations` (u operación lógica equivalente) con `p_operation_id` explícito.

| RPC | Archivo (canónico) | Qué hace | Idem. | Parámetros clave | Toca (principal) | Evita / notas |
|-----|-------------------|----------|-------|------------------|--------------------|--------------|
| `rpc_checkout_cart(uuid, jsonb)` | `174_rpc_checkout_cart_strong_idempotency.sql` (+ delegación 124) | Checkout B2B: carrito → pedido, descuenta stock por talle/depósito, vacía carrito. | Sí | `p_operation_id`, `p_request` (ej. `cart_fingerprint`, `source`) | `carts`, `cart_items`, `orders`, `order_items`, `variant_size_warehouse_stock`, `order_item_stock_sources`… | Doble submit; conflicto con mismo id distinto payload |
| `rpc_create_public_sale` | `171_rpc_create_public_sale_strong_idempotency.sql` (evolución desde `14_public_sales.sql`) | Alta venta pública. | Sí | `p_operation_id`, `p_request` | `public_sales` y tablas vinculadas | Venta duplicada en retry |
| `rpc_void_public_sale` | `170_rpc_void_public_sale_strong_idempotency.sql` (79…) | Anula venta pública. | Sí | `p_operation_id`, ids en request | Misma familia + stock crédito según lógica | Anulación doble |
| `rpc_mark_order_as_devolucion` | `172_rpc_mark_order_as_devolucion_strong_idempotency.sql` (20, 161…) | Marca pedido en devolución. | Sí | `p_operation_id`, `p_request` | `orders`, flujos de items/stock asociados | — |
| `rpc_move_size_stock` | `173_rpc_move_size_stock_strong_idempotency.sql` (13, 162…) | Mueve cantidad entre depósitos por talle. | Sí | `p_operation_id`, `p_request` | `variant_size_warehouse_stock`, `stock_movements` (si aplica) | Movimiento duplicado |
| `rpc_mark_order_items_picked` | `177_rpc_mark_order_items_picked.sql` | Pasa items a `picked` vía `rpc_operations`. | Sí | `p_operation_id`, `p_request`, ids de items | `order_items` (no toca canónica directa) | Doble “picked” con mismo id |
| `rpc_set_variant_size_stock_batch` | `164_rpc_set_variant_size_stock_batch.sql` | Establece stock absoluto por filas talle+depósito en batch, transaccional, auditoría `stock_history`. | No* | `p_items` json (variant, size, warehouse, qty) | `variant_size_warehouse_stock`, `stock_history` | Races; writes dispersos en cliente |
| `rpc_set_variant_warehouse_stock_batch` | `165_rpc_set_variant_warehouse_stock_batch.sql` | Igual, variantes **sin** talles (solo wh). | No* | `p_items` | `variant_warehouse_stock`, `stock_history` | Confusión con variante con talles (RPC rechaza) |
| `rpc_apply_order_stock_deduction` | `166_rpc_apply_order_stock_deduction.sql` | Descuento transaccional por pedido (deltas) con `FOR UPDATE`. | No* | `p_items` jsonb, `p_order_id`, `p_source` | `variant_size_warehouse_stock`, `stock_history` | Cálculo en cliente + upsert duro |
| `rpc_reconcile_stock(boolean)` | `176_rpc_reconcile_stock_reserved_qty.sql` (reemplaza 146) | Alinea derivados desde canónica; opcional fija `reserved_qty`. | N/A | `p_fix_reserved_qty` default `false` | `variant_sizes`, `variant_warehouse_stock`, `product_variants` (condicional) | Drift acumulativo |

\*No usan `rpc_operations` de la misma forma; idempotencia “natural” o por diseño de batch; no reemplazan la necesidad de no reenviar el mismo descuento dos veces desde UI sin control.

**Cancelación de ítems:** `rpc_cancel_order_item` (126/85 según rama) — transaccional retorno de stock; ver comentarios en migraciones. Incluir en ampliación futura si se documenta en detalle.

## Enlaces

- [[05-IDEMPOTENCIA-RPC-OPERATIONS]] · [[06-RESERVED-QTY-Y-RECONCILE]] · `docs/STOCK_GOVERNANCE.md` §6
