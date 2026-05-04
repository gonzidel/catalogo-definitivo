# 02 — Modelo de stock actual (FYL)

> Basado en `docs/STOCK_GOVERNANCE.md` y comentarios en `supabase/canonical/` (vistas 144, 146, 175, RPCs 164, 165, 176).

## Fuente canónica

| Rol | Tabla / objeto |
|-----|----------------|
| **Canónica (stock real por talle y depósito)** | `variant_size_warehouse_stock` — columnas típicas: `variant_id`, `size`, `warehouse_id`, `stock_qty` |

Toda lógica de “cuánto hay en depósito X para talle Y” debe alinearse con **filas en esta tabla** (más RLS/rol).

## Tablas y columnas de apoyo (no canónicas para disponibilidad)

| Objeto | Rol | Escritura |
|--------|-----|------------|
| `variant_sizes` | `stock_qty` agregado por talle (todas las bodegas) | **Derivado**; trigger **84** (`trigger_sync_variant_sizes_on_warehouse_stock` en comentarios 146) |
| `variant_warehouse_stock` | `stock_qty` por `variant_id` + `warehouse_id` sin talle | **Derivado**; trigger **145** |
| `product_variants.reserved_qty` | Reserva agregada a nivel variante (carritos + pedidos vía fuentes) | Actualizado por flujos de negocio / reconciliación; **auditar** con `vw_stock_audit_reserved_qty_diff` |
| `order_item_stock_sources` | Cantidad descontada por depósito por línea de pedido | Escrito por RPCs de pedido / cancelación; base para trazabilidad y reserved |

**Deprecado / no usar para “disponible” en UI de catálogo:**

- `product_variants.stock_qty`
- `product_variants.size` (talles viven en `variant_sizes`)

## Derivadas: reglas

- `variant_sizes.stock_qty` y `variant_warehouse_stock.stock_qty` deben **coincidir** con agregados desde `variant_size_warehouse_stock`. Las vistas `vw_stock_audit_variant_sizes_diff` y `vw_stock_audit_variant_warehouse_diff` detectan desalineación (versión 175+ corrige criterio de `variant_warehouse` para evitar falsos positivos en variantes sin filas de talle).

## Qué **no** debe escribirse directo (desde app)

| Prohibido desde JS de producto | Motivo |
|--------------------------------|--------|
| `INSERT`/`UPDATE` directo a `variant_size_warehouse_stock` (app cliente; admin nuevo) | Saltar RLS, invariantes y trazas; reemplazado por RPCs batch y movimientos |
| Ajuste manual frecuente de `variant_sizes` / `variant_warehouse_stock` | Rompe coherencia con canónica; usar reconcile |
| Confiar en columnas `product_variants.stock_*` / `size` para UI pública | Legacy |

*Pendiente de verificación puntual:* si queda **algún** `upsert` legacy en `admin/*.js` hacia canónica — usar grep recomendado en [[99-AUDITORIA-FINAL]].

## Cómo lee `catalog_public_view` el stock (importante)

`catalog_public_view` **no consulta `variant_size_warehouse_stock` directamente**. Filtra variantes visibles usando:

```sql
inner join (
    select distinct variant_id from variant_sizes where stock_qty > 0
) vs_with_stock on vs_with_stock.variant_id = pv.id
```

Y construye la "Numeración" (talles visibles) también desde `variant_sizes WHERE stock_qty > 0`.

**Consecuencia directa:** si el trigger 84 (`trigger_sync_variant_sizes_on_warehouse_stock`) está inactivo, `variant_sizes` queda desactualizado y el catálogo muestra datos de stock incorrectos (productos sin stock que aparecen, o productos con stock que no aparecen).

**Adicionalmente:** `catalog_public_view` no expone `product_id` en su SELECT final. Las columnas disponibles son `"Articulo"`, `"Color"`, `"Numeracion"`, `"Precio"`, `"Filtro1"`, `"Filtro2"`, `"Filtro3"`, etc. Para identificar productos por ID desde la vista, hay que hacer join por `"Articulo"` + `"Color"` o una subquery a `product_variants`.

## Reglas de oro (resumen)

1. **Leer** stock operativo (catálogo, alternativas, carrito) desde `variant_size_warehouse_stock` filtrando `warehouses` por `code` resuelto a **UUID** (`general`, `venta-publico` típicamente).
2. **Escribir** stock solo vía:
   - `rpc_set_variant_size_stock_batch` (con talle)
   - `rpc_set_variant_warehouse_stock_batch` (sin talle, por depósito)
   - `rpc_save_product_variant_initial_stock` (carga inicial al crear variante, ver `139`)
   - `rpc_move_size_stock` (movimiento / transferencia, idempotente vía 173+)
   - y RPCs de pedido que descontarán o devolverán stock (`rpc_apply_order_stock_deduction`, cancelaciones, checkout…)
3. **No añadir** trigger-guard en `BEFORE INSERT/UPDATE/DELETE` sobre canónica: decisión documentada en `STOCK_GOVERNANCE.md` §2 (Razonamiento: RLS, scripts manuales, 84/145, reconcile, gate). *Ver* [[11-DECISIONES-TECNICAS]].
4. **No modificar** triggers **84/145** sin análisis de riesgo y prueba de derivados.

## Enlaces

- [[04-RPCS-CRITICAS]] · [[06-RESERVED-QTY-Y-RECONCILE]] · [[08-UI-CANONICA-Y-FALLBACKS]]
- `docs/STOCK_GOVERNANCE.md` sección 1–2
- `supabase/canonical/144_stock_audit_readonly_views.sql`, `175_stock_audit_bloque2_gate_reserved_qty.sql`
