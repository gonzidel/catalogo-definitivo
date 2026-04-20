# Gobernanza de Stock — FYL

Documento corto de referencia para cualquier persona que toque stock, pedidos o ventas.
Complementa `admin/STOCK_OPERATIVA.md` y `docs/STOCK_SYSTEM_AUDIT.md`.

---

## 1. Fuente canónica vs capas derivadas

| Capa | Tabla | Rol | ¿Se escribe directamente? |
|---|---|---|---|
| **Canónica** | `variant_size_warehouse_stock` | Stock por `variant_id × size × warehouse_id` | Solo vía RPC o admin autorizado. Nunca desde cliente. |
| Derivada | `variant_sizes.stock_qty` | Suma por `variant_id × size` (todas las bodegas) | Nunca. Trigger **84** la sincroniza. |
| Derivada | `variant_warehouse_stock.stock_qty` | Suma por `variant_id × warehouse_id` | Nunca. Trigger **145** la sincroniza. |
| Deprecada | `product_variants.stock_qty` | Columna histórica | Nunca. No leer en UI de disponibilidad. |
| Deprecada | `product_variants.size` | Columna histórica | Nunca. Los talles viven en `variant_sizes`. |

**Regla de oro para UI (catálogo, carrito, dashboard):**
Leer siempre desde `variant_size_warehouse_stock` filtrando por los warehouses `general` y `venta-publico` (resolver primero sus UUIDs desde `warehouses.code`).

**Regla de oro para admin:**
Nunca hacer `upsert`/`update`/`insert` directo a `variant_size_warehouse_stock` desde código nuevo. Usar las RPCs:
- `rpc_set_variant_size_stock_batch` — con talle.
- `rpc_set_variant_warehouse_stock_batch` — sin talle.
- `rpc_save_product_variant_initial_stock` — carga inicial al crear variante.
- `rpc_move_size_stock` — mover stock entre bodegas.

---

## 2. ¿Por qué NO hay guard SQL sobre `variant_size_warehouse_stock`?

Se evaluó agregar un trigger `BEFORE INSERT/UPDATE/DELETE` similar a `148_guard_derived_stock_writes.sql`. **No se implementa** porque:

1. No existen escrituras directas activas desde JS a esa tabla (verificado en Sprint 5-6: las referencias restantes son bloques comentados o reads).
2. Un trigger estricto bloquearía scripts manuales legítimos (correcciones desde el SQL editor de Supabase, migraciones puntuales).
3. El control efectivo ya está en RLS por rol: `anon` y `authenticated` no pueden escribir; solo `service_role` o funciones `SECURITY DEFINER`.
4. El release gate (`vw_stock_audit_release_gate`) y `rpc_reconcile_stock` detectan y corrigen drift si algo se escapa.
5. Los triggers 84 y 145 garantizan coherencia de las derivadas aunque la canónica sea modificada.

Si en el futuro se necesita endurecer, la vía correcta es RLS explícito por rol en `variant_size_warehouse_stock`, no un trigger-guard.

---

## 3. Reconcile

Función: `rpc_reconcile_stock` (archivo `146_rpc_reconcile_stock.sql`).

### Qué hace
- Revisa drift de `variant_sizes.stock_qty` y `variant_warehouse_stock.stock_qty` vs la canónica.
- Revisa drift de `product_variants.reserved_qty` vs `order_item_stock_sources / order_items` activos.
- Modo dry-run o corrección real.

### Cómo correrla

```sql
-- Diagnóstico (no escribe)
SELECT public.rpc_reconcile_stock(p_fix_reserved_qty := false);

-- Corrección real (escribe)
SELECT public.rpc_reconcile_stock(p_fix_reserved_qty := true);
```

### Cuándo correrla
- Si el release gate muestra `go_live_ready = false`.
- Si aparece alerta en `vw_stock_audit_alerts_current`.
- Después de operaciones bulk (importación de inventario, migración).

### Salida esperada
JSON con claves:
- `reserved_qty_checked`, `reserved_qty_fixed`
- `variant_sizes_fixed`, `variant_warehouse_stock_fixed`
- `affected_variants` (truncado)

---

## 4. Release gate

Vista: `vw_stock_audit_release_gate` (archivos `144_stock_audit_readonly_views.sql` + `175_stock_audit_bloque2_gate_reserved_qty.sql`).

### Criterio binario
```sql
SELECT go_live_ready FROM public.vw_stock_audit_release_gate;
-- true  → se puede operar / deployar
-- false → STOP, investigar
```

### Columnas relevantes
- `variant_warehouse_diffs_count` — derivadas desincronizadas.
- `reserved_qty_diffs_count` — drift de reservas.
- `orphan_variants_count` — variantes con stock sin producto activo.
- `health_score` — 0-100 compuesto.

### Alertas detalladas
```sql
SELECT * FROM public.vw_stock_audit_alerts_current;
```

### Vista auxiliar operativa
Pantalla `admin/stock-audit.html` consume estas vistas.

---

## 5. Estados de disponibilidad visibles al usuario

| Estado UI | Significado técnico | Cuándo aparece |
|---|---|---|
| **Disponible** | `stock_canónico(general+venta-publico) - reserved_qty > 0` | Stock real comprable |
| **Sin stock** | Diferencia ≤ 0 y no hay flujo de reposición abierto | No mostrar como comprable |
| **Stock pendiente** (`pending_stock`) | Producto activo pero sin fila en `variant_size_warehouse_stock` aún | Producto nuevo / en proceso de carga |
| **Missing** (`incomplete`) | Variante existe pero faltan datos (imagen, talle, precio) | Requiere completar en `admin/incomplete-products.html` |
| **Sin stock confirmado** | No hubo lectura canónica exitosa (error de red o RLS) | No mostrar como comprable. Reintentar. |

**Regla de UI:** nunca inventar disponibilidad desde columnas derivadas o deprecadas. Si la canónica da 0 o error, la UI muestra "sin stock". Sin excepciones.

---

## 6. RPCs idempotentes

Todas las RPCs críticas aceptan `p_operation_id` (uuid) y `p_request` (jsonb con `{source, action, ...}`).
Repetir la misma llamada con el mismo `p_operation_id` devuelve el resultado previo (`idempotent_replay = true`) en vez de ejecutar dos veces.

| RPC | `p_operation_id` | Call sites actualizados |
|---|---|---|
| `rpc_checkout_cart` | ✅ obligatorio | `scripts/cart-persistent.js`, `client/dashboard-instant.js` |
| `rpc_create_public_sale` | ✅ obligatorio | `admin/public-sales.js`, `admin/local-order-edit.js` |
| `rpc_void_public_sale` | ✅ obligatorio | `admin/public-sales.js` |
| `rpc_mark_order_as_devolucion` | ✅ obligatorio | `admin/sent-orders.js` |
| `rpc_move_size_stock` | ✅ obligatorio | `admin/move-stock.js` (wrapper `rpcMoveSizeStockWithIdempotency`) |
| `rpc_send_order_to_local` | ✅ obligatorio | `admin/orders.js` |
| `rpc_apply_order_stock_deduction` | ✅ obligatorio | `admin/order-creator.js` |

### Cómo llamar una RPC idempotente desde JS

```js
function generateOperationId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // fallback UUIDv4-compatible
}

const opId = generateOperationId();
const { data, error } = await supabase.rpc('rpc_whatever', {
  p_some_arg: value,
  p_operation_id: opId,
  p_request: { source: 'admin/mi-archivo.js', action: 'mi_accion' },
});

if (error) {
  // Manejar operation_id_conflict vs conflict_in_progress:
  // - operation_id_conflict: mismo id, payload distinto → bug (no reintentar)
  // - conflict_in_progress: otra tx con mismo id corriendo → esperar y polear estado
  throw error;
}

if (data?.idempotent_replay === true) {
  // Ya se ejecutó antes. Resultado previo devuelto sin re-ejecutar.
}
```

**Regla:** un click de usuario = un `operation_id`. Reintentos internos reusan el mismo id. Nunca lo generes dentro de un retry loop.

---

## 7. Trazabilidad

| Tabla | Qué registra |
|---|---|
| `order_item_stock_sources` | Distribución por bodega de cada unidad descontada en un pedido |
| `stock_history` | Ajustes manuales desde admin (`log_stock_change`) |
| `stock_movements` | Movimientos entre bodegas (con `size`) |
| `rpc_operations` | Idempotencia: `operation_id → resultado` |
| `public_sales` / `public_sale_items` | Ventas públicas para void y auditoría |

Al devolver stock (cancelar, devolución) se lee `order_item_stock_sources` primero para regresar a la bodega correcta. Si no hay fuentes (pedidos legacy), fallback a `general`.

---

## 8. Qué NO hacer

- ❌ Leer disponibilidad de `product_variants.stock_qty`.
- ❌ Filtrar por `product_variants.size`.
- ❌ Inventar stock con fallbacks (`if (canónico === 0 && derivado > 0) usar derivado`).
- ❌ Llamar RPC crítica sin `operation_id`.
- ❌ Hacer `update` directo a `orders.status` después de una RPC transaccional (el RPC ya es atómico).
- ❌ Filtrar `warehouse_id` por string; `warehouse_id` es UUID. Resolver siempre desde `warehouses.code`.
