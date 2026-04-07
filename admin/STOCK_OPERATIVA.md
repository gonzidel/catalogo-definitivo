# Reglas operativas de stock (FYL Admin)

Documento breve para alinear criterios entre pantallas. No reemplaza migraciones ni la base productiva.

## Tres pantallas

| Pantalla | Uso |
|----------|-----|
| **Productos** (`products.html`) | Alta/edición de artículo y **talles con cantidades**. Escribe `variant_sizes` y el **total por variante** en `variant_warehouse_stock` solo para el almacén **general**. |
| **Stock** (`stock.html`) | Operación diaria: stock por **talle × depósito** (`general` / `venta-publico`), carga incremental, historial. |
| **Mover stock** (`move-stock.html`) | Traslado entre depósitos vía **RPC** `rpc_move_size_stock` (con registro en `stock_movements`). |

## Regla práctica

- El **detalle fiable por depósito** (sobre todo `venta-publico`) se controla en **Stock** y **Mover stock**.
- Tras cargar talles en **Productos**, si el producto ya vende o reparte entre depósitos, **conviene verificar** en **Stock** que los saldos por depósito coincidan con la operación.

## Coherencia

- Existe un trigger en base que, al cambiar **`variant_size_warehouse_stock`**, actualiza **`variant_sizes`** (suma por talle entre depósitos). **Productos** no escribe `variant_size_warehouse_stock`; por eso pueden aparecer diferencias hasta que **Stock** u otro flujo escriba esa capa.
- Si el guardado del **total general** falla en Productos, el guardado de talles **ya puede haberse aplicado**: revisar en **Stock** o reintentar guardar el producto.

## Auditoría

- Consultas **solo lectura** sugeridas: `scripts/stock-consistency-checks-readonly.sql` (ejecutar en SQL Editor de Supabase u otro cliente).
