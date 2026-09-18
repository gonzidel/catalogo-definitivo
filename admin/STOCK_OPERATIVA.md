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

### Talles vendidos sin descuento real de stock (watchlist 341)

- Card "Talles vendidos sin descuento real de stock (30d)" en el bloque **Situaciones a revisar** de `stock-audit.html`, alimentada por `vw_stock_audit_untracked_sales_watchlist`.
- Detecta ventas locales con `sell_without_stock` y altas admin con `admin_confirmed_missing` que nunca descontaron `variant_size_warehouse_stock` — el origen del incidente de stock fantasma resuelto en la migración `342_fix_remove_order_item_no_blind_restore.sql`.
- **No es auto-reconciliable**: no hay botón de "corregir" porque la corrección real es un **conteo físico** de esa variante/talle. La resolución es manual: contar la unidad y, si corresponde, actualizar el stock desde **Stock** (`stock.html`).
- **No hay cron de recordatorio.** Decisión explícita (2026-09-14): la visibilidad de esta card cada vez que un admin abre `stock-audit.html` es suficiente; agregar escalamiento automático (pg_cron + tabla de "verificado") queda descartado por ahora dado que un cron no puede reemplazar el conteo físico en sí. Si en el futuro se vuelve a evaluar, ver el runbook de la auditoría de stock fantasma para contexto completo.

#### Trazabilidad de "agregar sin stock" en venta local (343)

- El modal "sin stock" de `admin/public-sales.js` (y sus 3 HTML: `public-sales.html`, `-caja2.html`, `-caja3.html`) ahora tiene un campo de **motivo opcional** (texto libre, máx. 200 caracteres). No es obligatorio: si el vendedor lo deja vacío, la venta sigue funcionando igual que antes.
- `public_sale_items` tiene 2 columnas nuevas: `sell_without_stock` (boolean, antes se infería solo por `qty_venta_publico=0 AND qty_general=0`) y `sell_without_stock_reason` (texto libre, puede ser NULL).
- La card de la watchlist ahora muestra también **quién** fue el último vendedor que confirmó "sin stock" para esa variante/talle (`last_admin_email`) y su **motivo** (`last_reason`), vía `vw_stock_audit_untracked_sales_watchlist`.
- **Alcance intencionalmente limitado**: el motivo solo se captura en los 2 flujos principales de alta de venta nueva (búsqueda manual con selector de color, y grilla de talles de producto único). El flujo de escaneo QR/SKU nunca muestra el modal (agrega sin preguntar) y la edición de "pedidos locales" usa otra función (`rpc_update_local_order`, no `rpc_create_public_sale`) — ninguno de los dos quedó instrumentado con motivo, pero ambos siguen funcionando exactamente igual que antes de la 343.
