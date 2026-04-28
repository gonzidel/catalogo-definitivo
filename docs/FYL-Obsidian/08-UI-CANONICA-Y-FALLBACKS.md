# 08 — UI canónica y fallbacks (FYL)

> Basado en `docs/STOCK_GOVERNANCE.md` §5, comentarios en `scripts/product-alternatives.js` / `admin/stock.js`, y saneamiento de catálogo descrito en [[21-CONTEXTO-AGENTE-HARDENING-2026-04]].

## Qué significa “UI no inventa stock”

- No usar `product_variants.stock_qty` / `size` para **disponible comprable**.
- No rellenar con números de `variant_sizes` si el diseño de pantalla requiere **canónica por depósito** sin haberla leído.
- Si `variant_size_warehouse_stock` (o el fetch RPC) **falla** o devuelve 0, la UI debe mostrar **sin stock** o estado de error según gobernanza, no un valor estimado.

## Pantallas que leen stock canónico (patrón)

| Área | Comportamiento típico (verificar en código) |
|------|---------------------------------------------|
| Catálogo / PDP / carrito | Consultas a `variant_size_warehouse_stock` (y resolución de `warehouses` por **UUID** desde `warehouses.code`) |
| `product-alternatives.js` | Uso de **UUIDs** de bodega; se eliminaron/ajustaron rutas que comparaban con strings `general`/`venta-publico` (hotfix documentado en conversación de saneamiento) |
| `admin/stock.js` | Lectura; **escritura** hacia canónica vía RPCs batch, no `upsert` libre a canónica en rutas migradas (comentarios 164/165/166) |
| `admin/fyl-products.js`, `incomplete-products` | Hacia migración: comentarios en 165/164 señalan pendientes; **leer** SQL y JS para el estado real |
| Venta pública `admin/public-sales.js` | Múltiples **select** a `variant_size_warehouse_stock` para armar contexto; mutaciones vía RPCs de venta |

*“Pendiente de verificación” fila a fila:* búsqueda `\.from\("variant_size_warehouse_stock"\)\.(update|insert|upsert` en `admin/*.js`.*

## Fallbacks eliminados o señalados

- `admin/stock.js` (render): si una fila usa `fallbackFromVariantSizes` se **marca** en UI (mensaje *no desde canónica*) — ~línea 1273. No sustituye canónica sin aviso: es advertencia al usuario.
- Cualquier fallback que **pinte** stock como si fuera canónico sin haber leído la canónica debería considerarse **bug** (criterio de `STOCK_GOVERNANCE.md` §5).

## Missing real vs admin confirmado

| Concepto | Significado aprox. |
|----------|---------------------|
| **Missing** real | Línea/pieza sin stock disponible en la lógica de pedido; el cliente no debe tratarlo como “confirmado” con cantidad surtida. |
| **admin_confirmed_missing** / manual confirmado | Marca de negocio: el flujo de administración acepta la línea aun faltando stock “duro”; en **dashboard cliente** el resumen puede tratarlo como “confirmado” a efectos de copia/UX. |

Implementación: contadores y etiquetas en `client/dashboard-instant.js` (función tipo `getOrderItemCounterSummary*`) — *confirmar nombres en código actual*.

## Dashboard cliente y admin/orders

- **Cliente:** pedidos, cancelaciones y checkout en `client/dashboard-instant.js`; `loadOrders` y feedback post-pedido usan `safeInsertBefore` (ver [[10-BUGS-RESUELTOS]]).
- **Admin:** `admin/orders.js` — búsqueda de stock para contexto; picked con `rpc_mark_order_items_picked` (idempotente).

## Enlaces

- [[02-MODELO-STOCK-ACTUAL]] · [[03-FLUJO-PEDIDOS-Y-STOCK]] · `docs/STOCK_GOVERNANCE.md`
