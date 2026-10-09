# Stock

Última revisión: 2026-09-23

## VERIFICADO EN CÓDIGO

### Fuente física canónica

Estado: Vigente en código  
Fuente: SQL canónico y consumidores frontend  
Última revisión: 2026-09-23

El stock físico por talle vive en `variant_size_warehouse_stock`, identificado por variante, talle y depósito. Los depósitos comerciales observados son `general` y `venta-publico`.

`variant_sizes.stock_qty` y `variant_warehouse_stock.stock_qty` son capas derivadas/sincronizadas. `product_variants.stock_qty` aparece como compatibilidad histórica y no debe elegirse como autoridad sin seguir el flujo específico.

### Stock vendible

Estado: Vigente en la definición SQL local más reciente  
Fuente: `supabase/canonical/330_sellable_stock_canonical.sql`  
Última revisión: 2026-09-23

La cantidad vendible es:

```text
max(sum(stock_qty de general y venta-publico), 0)
```

**Clasificación: TÉCNICA VERIFICADA.** La definición actual **no resta** `reserved_qty`, carritos, `order_item_stock_sources` ni líneas `awaiting_apartado`. Esto contradice documentación histórica que trataba las reservas lógicas como parte del cálculo vendible.

Las lecturas canónicas son:

- `fn_sellable_qty(variant_size_id)`
- `fn_sellable_stock_batch(variant_size_ids)`; admite como máximo 500 IDs por llamada
- `catalog_public_available_view` y `catalog_public_snapshot` para catálogo

En la UI, una respuesta ausente o fallida no equivale a cero ni a disponible: se trata como dato desconocido. La cantidad agregable se limita contra la respuesta conocida.

### Contexto empresarial confirmado

Estado: Vigente  
Fuente: Contexto confirmado por responsable del negocio y código  
Última revisión: 2026-09-23

- `sellable_qty` es la disponibilidad que debe gobernar la venta web.
- Una PDP debe ofrecer únicamente talles con `sellable_qty > 0`.
- El carrito debe revalidar por lote mediante `fn_sellable_stock_batch`.
- Checkout debe volver a validar bajo locks de base de datos antes de confirmar.
- `0` significa lectura válida sin disponibilidad; `null` significa que el dato no pudo obtenerse o no apareció. **Nunca convertir un miss `null` en una confirmación de stock cero.**
- La protección entre pestañas mediante operación por cliente, localStorage y BroadcastChannel es una defensa deliberada contra operaciones duplicadas.

### Consumo en pedidos

1. Checkout bloquea las filas relevantes de stock.
2. Consume primero `general`.
3. Consume el remanente desde `venta-publico`.
4. Registra cada origen en `order_item_stock_sources`.
5. Las unidades de `general` generan ítems `reserved`; las de `venta-publico`, ítems `waiting`.

`order_item_stock_sources` es la trazabilidad necesaria para devolver stock al cancelar, quitar o vencer líneas. No debe reconstruirse el origen suponiendo un depósito.

### Límite documental de `reserved_qty`

**Clasificación: EN EVALUACIÓN.** No existe todavía una definición comercial canónica de `reserved_qty`. El código permite documentar dónde se lee, escribe y reconcilia, pero no autoriza a inferir:

- cuándo debería aumentar como regla de negocio;
- cuándo debería disminuir;
- qué tipos de reserva representa;
- qué comportamiento comercial corresponde ante cancelación o vencimiento;
- si debería incluir o excluir `local_deferred_pickup`.

Hasta resolverlo, no usar `reserved_qty` como sinónimo de reserva comercial ni cambiar su mantenimiento basándose en una interpretación documental.

### Escrituras administrativas

Las rutas de escritura observadas pasan por RPCs como:

- `rpc_set_variant_size_stock_batch`
- `rpc_set_variant_warehouse_stock_batch`
- `rpc_save_product_variant_initial_stock`
- `rpc_move_size_stock`
- `rpc_admin_zero_variant_size_stock`
- RPCs de venta pública y anulación con trazabilidad

Hay guardas contra escritura directa en capas derivadas. Antes de sumar otra escritura de stock debe comprobarse que respeta esas guardas, registra movimiento y mantiene sincronizadas las proyecciones.

### Confirmación manual sobre un talle reservado por otro pedido

`rpc_admin_manual_inject_and_deduct` confirma un producto que el sistema da en 0 pero está en la estantería: suma y resta la cantidad (neto 0), crea una fuente propia y sube `reserved_qty`. Si ese par era el que otro pedido abierto ya tenía reservado, quedan dos reclamos sobre una sola unidad. Cuando el primer pedido se cancela o vence, su fuente reingresa y aparece stock fantasma. **TÉCNICA VERIFICADA (2026-10-07):** fue el caso del 1632 Negro T37: A57180 reservó el último par, A57453 lo confirmó a mano y al vencer A57180 reingresó +1. En 30 días hubo 30 confirmaciones así sobre 590.

**NEGOCIO CONFIRMADO (2026-10-07):** antes de confirmar a mano, el admin ve qué pedidos abiertos tienen ese talle reservado y elige una de dos opciones:

- **Es el par de ese pedido:** se le pasa al pedido nuevo y el otro pedido queda "sin stock" en ese producto. No se suma stock y se le avisa a la clienta.
- **Hay otro par:** confirmación manual como antes.

Implementación en la migración 370 (`370_manual_confirm_take_reservation.sql`, **pendiente de aplicar**):

- `rpc_admin_manual_confirm_candidates` lista las reservas en conflicto.
- `take_from_order_item_id` en la confirmación manual y en `rpc_admin_add_order_items_atomic`. El ítem origen pasa por `rpc_admin_mark_item_missing` y se registra `stock_history.change_type = 'reserva_tomada'` (stock sin cambio).
- Vista de seguimiento `vw_stock_audit_manual_confirm_reserved`: confirmaciones manuales de 90 días sobre talles reservados por otro pedido, con qué pasó con ese otro pedido, más las reservas tomadas.

En el NJ el aviso aparece al guardar en editar pedido y en crear pedido. El admin vanilla (`admin/orders.js`, `admin/order-creator.js`) no muestra el aviso y confirma como antes.

### Reconciliación y auditoría

- `rpc_reconcile_stock` recalcula capas derivadas. En las definiciones nuevas, pasar `false` no garantiza un dry-run puro: controla la corrección de `reserved_qty`, pero puede escribir otras capas.
- Las vistas `vw_stock_*` cubren auditoría, inmovilizados, publicación y rendimiento.
- `stock_movements` registra pases entre depósitos (`rpc_move_stock`, `rpc_move_size_stock`).
- `stock_history` lo escriben solo algunas RPCs. **TÉCNICA VERIFICADA (2026-10-05):** no registran ahí `rpc_checkout_cart`, el reingreso de `rpc_cancel_order_item`, el mantenimiento de vencidos anterior a 367 ni el borrado de pedidos; `rpc_save_product_variant_initial_stock` registra solo el total por variante, sin talle. Por eso las auditorías R2776 y L3040 no pudieron identificar qué pedido devolvió cada unidad.
- `stock_ledger` (migración 368, **TÉCNICA VERIFICADA: aplicada en producción 2026-10-05 13:41 ART**; ensayo con rollback forzado y prueba funcional post-aplicación OK; 11 chequeos de permisos/triggers OK; rollback en `368_ROLLBACK_...sql`, conserva la tabla): registro automático por triggers, sin tocar RPCs. Guarda cada cambio de `variant_size_warehouse_stock.stock_qty` (talle, depósito, antes/después), cada alta/baja de `order_item_stock_sources` con su pedido, y una foto de ítems y pedidos antes de borrarse. Cada fila lleva `txid`, la RPC de origen, `auth.uid()` y el rol de la API; se une por `txid` para saber qué pedido explica un movimiento. Lectura solo admin (RLS `is_admin()`), vista `vw_stock_ledger_readable`. Consultas de ejemplo en `368_..._tests.sql`.
- Existen controles específicos para ventas públicas sin stock, fuentes pendientes/canceladas y ventas sin trazabilidad.

### Reglas importantes

| Regla | Estado | Fuente | Revisión |
|---|---|---|---|
| El físico por talle/depósito es la autoridad | Verificado | `variant_size_warehouse_stock` | 2026-09-23 |
| Vendible suma `general` + `venta-publico` sin restar reservas | Verificado en SQL local | Migración 330 | 2026-09-23 |
| Checkout consume `general` antes de `venta-publico` | Verificado | RPC de checkout | 2026-09-23 |
| Toda devolución debe seguir las fuentes registradas | Verificado | RPCs de cancelación/mantenimiento | 2026-09-23 |
| `reserved_qty` no gobierna el gate de venta actual | TÉCNICA VERIFICADA | Migraciones 330 y posteriores | 2026-09-23 |
| `null` y `0` tienen semánticas distintas | Confirmado por negocio y código | `sellable-stock.ts` y selftest | 2026-09-23 |
| Confirmar a mano un par reservado por otro pedido: avisar y, si es ese par, el otro pedido queda sin stock (sin stock fantasma) | NEGOCIO CONFIRMADO | Migración 370 (pendiente de aplicar) | 2026-10-07 |

## Tablas, vistas y RPCs clave

- Tablas: `variant_size_warehouse_stock`, `variant_sizes`, `variant_warehouse_stock`, `product_variants`, `stock_movements`, `order_item_stock_sources`, `stock_ledger` (368).
- Vistas: `catalog_public_available_view`, `catalog_public_snapshot`, `vw_stock_fast_sellers`, `vw_stock_dead_products`, `vw_stock_publication_inefficiency`, `vw_stock_tag_summary`.
- RPCs: `fn_sellable_qty`, `fn_sellable_stock_batch`, `rpc_reconcile_stock`, `rpc_move_size_stock`, `rpc_set_variant_size_stock_batch`, `rpc_set_variant_warehouse_stock_batch`.

## Archivos clave

- `nj/lib/stock/sellable-stock.ts`
- `nj/lib/stock/catalog-availability.ts`
- `supabase/canonical/73_variant_size_warehouse_stock.sql`
- `supabase/canonical/84_sync_variant_sizes_on_warehouse_stock.sql`
- `supabase/canonical/145_sync_variant_warehouse_stock.sql`
- `supabase/canonical/148_guard_derived_stock_writes.sql`
- `supabase/canonical/330_sellable_stock_canonical.sql`
- `supabase/canonical/340_cancelled_pending_stock_count_sources.sql`
- `docs/STOCK_GOVERNANCE.md`

## INFERIDO / DESCONOCIDO

- **Inferido:** la intención vigente es que toda decisión comercial de disponibilidad use la capa vendible canónica, aunque aún quedan consumidores históricos.
- **Desconocido:** qué definiciones y permisos están efectivamente desplegados en producción; el repositorio local no sustituye una inspección del proyecto Supabase.
- **Desconocido:** quién autoriza ajustes manuales, qué diferencias requieren aprobación y cuál es el procedimiento de inventario físico.
- **Desconocido:** si todos los canales externos descuentan por las RPCs canónicas o existen ventas fuera del sistema.
- **Desconocido:** definición comercial completa de `reserved_qty`, incluidos aumentos, disminuciones, componentes y tratamiento de vencimiento/cancelación/retiro diferido.
