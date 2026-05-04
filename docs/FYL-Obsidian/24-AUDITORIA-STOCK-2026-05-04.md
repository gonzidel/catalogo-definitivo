# 24 — Auditoría de stock 2026-05-04

Fecha: 2026-05-04
Tipo: diagnóstico ejecutivo + plan de corrección
Alcance: stock, reservas, visibilidad de catálogo

---

## Resultados del dashboard general (PASO 0)

```json
{
  "Diffs variant_sizes": 10,
  "Diffs variant_wh_stock": 0,
  "Filas huérfanas": 7,
  "Señales críticas": 0,
  "Señales warning": 5884,
  "Diffs reserved_qty": 782,
  "Variantes afectadas": 1982,
  "Trigger 84 activo": true,
  "Trigger 145 activo": true,
  "Stock limpio": false,
  "Decisión": "no-go",
  "Razones bloqueantes": ["variant_sizes_diffs", "orphan_rows", "reserved_qty_diffs"],
  "Medido el": "2026-05-04 12:07:51 UTC"
}
```

### Desglose reserved_qty

| Tipo | Cantidad | Riesgo |
|------|----------|--------|
| Deflated (stock sobreestimado) | 4 | ALTO — puede habilitar sobreventa |
| Inflated (stock subestimado) | 778 | MEDIO — clientes ven menos disponibilidad de la real |
| **Total diffs** | **782** | |

---

## Interpretación

### Lo que está bien

- **Triggers 84 y 145 ACTIVOS.** La cadena de sincronización `variant_size_warehouse_stock → variant_sizes → variant_warehouse_stock` funciona automáticamente.
- **0 señales críticas.** No hay eventos de trazabilidad con inconsistencia grave en pedidos activos.
- **0 diffs en variant_warehouse_stock.** Las sumas por depósito están alineadas con la canónica.

### El problema principal: drift histórico de `reserved_qty`

**782 variantes** tienen `product_variants.reserved_qty` desincronizado con la suma real de reservas activas (pedidos abiertos + carritos open B2B).

- **4 deflated** (crítico): `reserved_qty` almacenado es menor al real. El sistema cree que hay menos reservas de las que hay. Estas 4 variantes pueden aceptar pedidos que superan el stock real disponible. Deben identificarse y corregirse primero.
- **778 inflated** (operativo): `reserved_qty` almacenado es mayor al real. El sistema cree que hay más reservas de las que hay. Clientes ven stock disponible como menor a lo real. Bloquea pedidos innecesariamente pero no genera sobreventa.

**Causa probable:** El drift de `reserved_qty` es acumulativo. Se genera gradualmente cuando pedidos se envían, se cancelan o vencen y el campo no se recalcula. No indica errores en el stock físico; indica que el campo derivado está desactualizado.

### Los 10 diffs en `variant_sizes`

Con triggers activos, estos 10 diffs son **residuos históricos** — registros de `variant_sizes` que quedaron con valores distintos a la suma canónica antes de que el trigger 84 estuviera activo, o por edge cases puntuales (ej. rollback de transacción que dejó `variant_sizes` en un estado intermedio). Son corregibles con `rpc_reconcile_stock`.

### Las 7 filas huérfanas

7 filas en `variant_size_warehouse_stock` que no tienen fila correspondiente en `variant_sizes`. Causas posibles:
- Filas creadas antes de la existencia del trigger 84.
- `variant_sizes` eliminado manualmente después de insertar stock.

Estas filas tienen stock real en depósitos pero ese stock **no contribuye al catálogo** porque `catalog_public_view` filtra por `variant_sizes`. Son stock invisible hasta que se reconcilie.

### Las 5884 señales warning

Estas señales vienen de `vw_stock_audit_reference_signals` (trazabilidad histórica: `stock_history`, `public_sale_items`, `order_item_stock_sources`). Representan registros históricos con trazabilidad incompleta — típicamente registros creados antes de que el sistema de trazabilidad completa existiera. **No son stock roto en tiempo real.** No tienen corrección automática por RPC; son información de auditoría histórica.

### Las 1982 variantes afectadas

Este número es el UNION DISTINCT de variantes con cualquier anomalía. La mayoría proviene de las 782 con drift de `reserved_qty` y de las variantes referenciadas en las señales warning.

---

## Resultado de corrección — FASE 5 ejecutada (2026-05-04 14:00 UTC)

### rpc_reconcile_stock(false) — Paso 2

| Métrica | Antes | Después |
|---------|-------|---------|
| `variant_sizes_diffs` | 10 | **0** |
| `orphan_rows` | 7 | **0** |
| `variant_warehouse_diffs` | 0 | 0 |
| `variant_sizes_updated` | — | 10 |
| `variant_sizes_inserted` | — | 7 |

- Los 10 talles con drift (JMEEK, 72, LIKO, 195, XH69) quedaron con `stock_qty = 0` → desaparecieron del catálogo.
- Las 7 filas huérfanas insertadas → ese stock ahora es visible.

### rpc_reconcile_stock(true) — Paso 3

| Métrica | Antes | Después |
|---------|-------|---------|
| `reserved_qty_diffs` | 794 | **0** |
| `reserved_qty.fixed` | — | **794** |
| `remaining_diffs` | — | 0 |

### Gate final — Paso 4

```
go_live_ready: true
release_decision: go
blocking_reasons: []
variant_sizes_diffs: 0
variant_warehouse_diffs: 0
orphan_rows: 0
reserved_qty_diffs: 0
trigger_84_active: true
trigger_145_active: true
measured_at: 2026-05-04 14:00:35 UTC
```

**FASE 5 completada. El sistema está en estado limpio.**

---

## Plan de corrección (en orden)

### Paso 1 — Identificar las 4 variantes deflated (ANTES de correr reconcile)

```sql
SELECT
  product_id,
  product_name,
  variant_id,
  variant_color,
  variant_sku,
  stored_reserved_qty,
  real_reserved_qty,
  order_sources_qty,
  cart_open_qty,
  delta,
  anomaly_type
FROM vw_stock_audit_reserved_qty_diff
WHERE anomaly_type = 'reserved_qty_deflated'
ORDER BY ABS(delta) DESC;
```

Revisar manualmente si esas 4 variantes tienen pedidos activos y stock suficiente antes de reconciliar.

### Paso 2 — Reconciliar tablas derivadas (no toca reserved_qty)

Corrige los 10 diffs de `variant_sizes` y las 7 filas huérfanas.

```sql
SELECT public.rpc_reconcile_stock(false);
```

**Nota crítica:** Este paso ESCRIBE en `variant_sizes` y `variant_warehouse_stock`. No es un dry-run. Ver [[06-RESERVED-QTY-Y-RECONCILE]].

### Paso 3 — Corregir reserved_qty

```sql
SELECT public.rpc_reconcile_stock(true);
```

Corrige los 782 diffs de `reserved_qty` poniendo `product_variants.reserved_qty = GREATEST(0, real_reserved_qty)`.

**Nota:** Este paso solo puede ejecutarse desde SQL Editor o service_role. No hay botón en `admin/stock-audit.js` que pase `true`. Ver [[06-RESERVED-QTY-Y-RECONCILE]] §Gap de UI.

### Paso 4 — Verificar resultado

```sql
SELECT
  variant_sizes_diffs,
  variant_warehouse_diffs,
  orphan_rows,
  critical_signals,
  reserved_qty_diffs,
  trigger_84_active,
  trigger_145_active,
  go_live_ready,
  release_decision,
  blocking_reasons
FROM vw_stock_audit_release_gate;
```

El resultado esperado post-corrección: `go_live_ready = true`, `release_decision = 'go'`, `blocking_reasons = []`.

### Paso 5 — Las 5884 señales warning

No requieren acción operativa inmediata. Son trazabilidad histórica. Si en el futuro se decide limpiar, requieren revisión manual tabla por tabla.

---

## Conclusión del estado

| Problema | Gravedad | Corrección disponible |
|---------|----------|-----------------------|
| 4 reserved_qty deflated | ALTA | `rpc_reconcile_stock(true)` |
| 10 diffs variant_sizes | MEDIA | `rpc_reconcile_stock(false)` |
| 7 filas huérfanas | MEDIA | `rpc_reconcile_stock(false)` |
| 778 reserved_qty inflated | MEDIA | `rpc_reconcile_stock(true)` |
| 5884 señales warning | BAJA | Sin corrección automática |

El sistema de sincronización (triggers 84/145) está funcionando correctamente. Los problemas detectados son drift acumulado histórico, no fallas del sistema actual.

---

## Inconsistencias de documentación detectadas en esta sesión

Durante la auditoría comparativa (doc vs código) se detectaron y corregieron estas inconsistencias en el vault:

| Inconsistencia | Archivo corregido |
|---------------|-------------------|
| `health_score` no existe como columna en `vw_stock_audit_release_gate` — SQL de runbook fallaba | [[07-RELEASE-GATE-Y-AUDITORIA]], [[09-RUNBOOK-OPERATIVO]], [[99-AUDITORIA-FINAL]] |
| `rpc_reconcile_stock(false)` presentado como dry-run — en realidad siempre escribe tablas derivadas | [[06-RESERVED-QTY-Y-RECONCILE]] |
| `catalog_public_view` no lee `variant_size_warehouse_stock` directamente — depende de trigger 84 vía `variant_sizes` | [[02-MODELO-STOCK-ACTUAL]] |
| `catalog_public_view` no expone `product_id` en su SELECT final — queries de auditoría sobre `cpv.product_id` fallan | [[02-MODELO-STOCK-ACTUAL]] |
| UI `admin/stock-audit.js` nunca pasa `p_fix_reserved_qty=true` → `reserved_qty` no se corrige desde UI | [[06-RESERVED-QTY-Y-RECONCILE]] |

---

## Enlaces

- [[07-RELEASE-GATE-Y-AUDITORIA]] — gate y SQL de verificación
- [[06-RESERVED-QTY-Y-RECONCILE]] — reconcile y corrección de reserved_qty
- [[16-AUDITORIA-MODULO-STOCK]] — auditoría del módulo stock
- [[02-MODELO-STOCK-ACTUAL]] — modelo de tablas canónicas y derivadas
