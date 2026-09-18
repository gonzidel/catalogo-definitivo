# 60 — Cierre atómico pedido local → venta (FYLA10223)

Fecha: 2026-09-04  
Estado: **Paso A en repo. Branch `fyl-334-staging` creado (2026-09-04) pero `MIGRATIONS_FAILED`. 334 NO aplicada en fyl-core ni en el branch. Botones no conectados. Paso B no ejecutado.**

Incidente: ticket `#fylA10223` / pedido `LOC00769`. El modal mostró un carrito JS distinto del persistido; F3 cobró en 4 round-trips y el ticket QZ usó `finalTotal` JS.

## Qué se hizo en esta entrega

Solo Paso A en el repositorio. Cero cambios en `admin/public-sales.js`, Caja 2/3, Retiro, `local-order-edit`, `rpc_create_public_sale`, pending, daily_sales o Facturante.

## Archivos

### Paso A (escritos, no desplegados)

| Archivo | Rol |
|---|---|
| `supabase/canonical/334_finalize_local_order_to_public_sale.sql` | Columna, backfill metadata, UNIQUE, RPC |
| `supabase/canonical/334_ROLLBACK_finalize_local_order_to_public_sale.sql` | Rollback exacto |
| `supabase/canonical/334_finalize_local_order_to_public_sale_tests.sql` | Aserciones solo lectura post-apply |

### Pasos C/E/F4 (aún no tocar)

| Archivo | Cambio previsto |
|---|---|
| `admin/public-sales.js` | F3: una sola RPC; ticket con `sale.total_amount`; bloquear finalize en Caja 2/3 |
| `nj/lib/orders/retiro-finalize-sale.ts` | Solo espejos: resolver `local_order_id` y llamar la misma RPC |
| `admin/local-order-edit.js` | Deshabilitar «Finalizar» (menor riesgo) |

## Auditoría live previa al UNIQUE (CONFIRMADO)

Query sobre `public_sales.notes ILIKE '%Pedido local%'` en fyl-core (2026-09-04):

- 632 ventas ligadas a un `local_orders` (0 notes sin match)
- 624 activas (`voided_at IS NULL`)
- 624 `local_order_id` distintos
- **0 duplicados** activos o con void

UNIQUE `public_sales(local_order_id) WHERE local_order_id IS NOT NULL AND voided_at IS NULL` es seguro.

Backfill propuesto: solo escribe `public_sales.local_order_id`. No cambia montos, ítems ni status. Incluye `#fylA10223` → `LOC00769` como metadata. **No recobra el incidente.**

## SQL propuesto (resumen)

1. `ALTER TABLE public_sales ADD COLUMN local_order_id uuid REFERENCES local_orders(id)`
2. Backfill por notes `Pedido local LOC…` / UUID
3. Guard: si hay duplicados activos → EXCEPTION, no se crea UNIQUE
4. UNIQUE parcial activo
5. `rpc_finalize_local_order_to_public_sale(p_local_order_id, p_items, p_notes default null, p_payment_method default 'Efectivo')`

Transacción única:

1. Admin + `FOR UPDATE` del `local_order`
2. Replay si `completed` y ya hay venta activa
3. Rechazo si `completed` sin venta, `cancelled`, o venta activa
4. Persistir `p_notes` si viene
5. `rpc_update_local_order` (stock delta + ítems + total F3)
6. Armar `public_sale_items` desde **filas persistidas** + extras de notes (no desde un total JS)
7. `rpc_create_public_sale` 5 args con `from_local_order`, `p_apply_credit=true`, `p_total_amount` = total SQL
8. Set `public_sales.local_order_id`
9. `local_orders.status = completed`
10. `rpc_close_mirrored_retiro_from_local_order` (si falla, rollback de todo)

El frontend **no** manda total autoritativo.

## Comportamiento anterior vs nuevo

| Flujo | Antes | Paso A (si se aplica SQL) | Paso C/E (aún no) |
|---|---|---|---|
| **F1 Caja 1 mostrador** | `rpc_create_public_sale` 7 args, 2x1, crédito, extras, sin stock | **Igual.** No pasa por la nueva RPC. | Igual |
| **F2 Caja 2/3 pending** | `rpc_create_pending_sale`; Caja 1 cobra | **Igual.** | Igual. Finalize de Pedidos se bloquea en 2/3 |
| **F3 Pedidos modal** | update + create + completed JS + close espejo | RPC existe pero **el botón sigue en el camino viejo** | Una llamada; ticket = persistido |
| **F5 Retiro espejo** | Cobra `order_items` | **Igual** (no conectar aún) | Misma RPC del local; no cobra espejo |
| **F5 Retiro común** | Sin cambio previsto | Sin cambio | Sin cambio |
| **F4 local-order-edit** | Tercer contrato | Sin cambio | Deshabilitar Finalizar |

## Regla Caja 2/3 (decisión propuesta)

**CONFIRMADO** en código: el modal de Pedidos se monta en caja2/caja3 porque comparten `public-sales.js`. F3 no mira `PUBLIC_SALES_CAJA` y puede crear `public_sales` directo.

**Recomendación (menor riesgo, alineada a pending):** Caja 2/3 pueden listar / editar / guardar pedidos (`rpc_update_local_order`). Solo Caja 1 finaliza. No caer a `rpc_create_pending_sale` desde F3.

Si operativamente Caja 2/3 deben cobrar pedidos, usarán la misma RPC (no pending). Eso se decide antes de Paso C.

## Crédito (issue separado, no se “mejora”)

F3 histórico: `p_apply_credit: true` + total = líneas + notes **sin restar crédito**. La RPC de 5 args solo infiere `credit_used` si `subtotal_items > p_total_amount`. Resultado: crédito no baja el total del pedido. Se conserva. No mezclar con el crédito de Caja 1 (que sí resta antes de extras %).

## Riesgos

| Riesgo | Nivel | Mitigación |
|---|---|---|
| Aplicar SQL sin conectar botones deja F3 viejo | Bajo | Intencional. Paso C después de Paso B |
| Inner `rpc_create_public_sale` cambia si alguien la reescribe | Medio | Paso A no la modifica; tests cuentan 3 overloads |
| Cerrar espejo ahora es duro (rollback de la venta) | Medio | Más estricto que F3 actual (warn). Correcto para atomicidad |
| Backfill toca la fila de FYLA10223 | Bajo | Solo `local_order_id`. Se puede omitir el UPDATE si se pide |
| Void + UNIQUE parcial | Bajo | Venta anulada no bloquea otra; `completed` sí. No se cambia void |
| Paso B en producción | Alto | Prohibido. Fixtures solo en branch/staging |

## Rollback exacto

```sql
-- 334_ROLLBACK_finalize_local_order_to_public_sale.sql
drop function if exists public.rpc_finalize_local_order_to_public_sale(uuid, jsonb, jsonb, text);
drop index if exists public.public_sales_local_order_id_active_uk;
drop index if exists public.idx_public_sales_local_order_id;
alter table public.public_sales drop column if exists local_order_id;
```

Tras rollback, F3/F1/F2/F5 siguen como hoy (botones nunca se conectaron en Paso A).

## Pruebas

### Ya corridas (solo lectura, producción)

- Duplicados notes→local_order: **0**
- Overloads `rpc_create_public_sale`: **3** (intacto)
- Trigger `trigger_register_local_sale` presente

### Paso B (después de apply, en entorno de prueba, no fyl-core prod)

1. Pedido simple
2. Agregar productos
3. Quitar productos
4. Notes (envío / dto / extra $ / %)
5. Doble cierre → replay
6. Dos sesiones → una venta
7. Error a mitad → 0 cambios parciales
8. Anulación posterior → stock de `public_sale_items`

### Paso D (regression Caja, sin datos reales de cobro de un pedido)

Caja 1 normal / 2x1 / crédito / extras / sin stock; Caja 2 pending; Caja 3 pending; Caja 1 cobra pending; reimpresión; anulación. Deben coincidir con el comportamiento actual.

## Caminos de Caja que quedaron sin modificar

**CONFIRMADO — ningún archivo de Caja tocado en esta entrega:**

- `calculateTotals` / `computeSalePromoGrouping`
- 2x1
- `rpc_create_pending_sale` y flujo Caja 2/3 → Caja 1
- `sell_without_stock`
- stock de venta mostrador
- `rpc_create_public_sale` (solo se **llama** desde la RPC nueva)
- `rpc_void_public_sale`
- Facturante
- triggers `daily_sales`
- pedidos web / envíos
- retiro común no espejo

## Intento de staging (2026-09-04 noche)

- Branch `fyl-334-staging` **eliminado** 2026-09-04 (no quedaba schema usable).
- `with_data: false`. Replay de migraciones de fyl-core falló en `20260513170456_catalog_public_snapshot.sql`: `catalog_public_available_view` no existe.
- Rebase: sigue `MIGRATIONS_FAILED`. Schema `public` vacío (sin `warehouses` / `public_sales`).
- `supabase db dump` desde prod: `LegacyDbConfigLoginRoleNetworkError`.
- fyl-core prod verificado: **no** tiene `local_order_id` ni `rpc_finalize_local_order_to_public_sale`.
- Frontend Caja/Pedidos/Retiro: **sin diff**.

Issue crédito (independiente, no se implementa): F3 no resta crédito del total. No mezclar con esta reparación.

### Problema B — historial de migraciones (deuda, no se repara ahora)

`213` (`catalog_public_snapshot`, version `20260513170456`) hace `CREATE TABLE LIKE catalog_public_available_view`. En live la vista existe, pero `193_catalog_public_available_view` **no está** en `schema_migrations` (`has_193 = 0`). El replay de branch falla porque aplica 213 antes de que exista la vista. Producción se construyó con applies MCP / SQL fuera de una cadena reproducible. No se corrige en esta reparación.

### Riesgo de stock preexistente (no corregir ahora)

`rpc_update_local_order` al quitar/reducir (precio ≥ 0) reingresa **siempre** a venta-publico, aunque la reserva original haya usado General. Paso B, cuando haya staging, debe medir VP-only / General-only / mixto + finalize + void. Si hay desalineación: bug preexistente; no conectar F3 hasta decidir si se corrige junto.

## GO/NO-GO de esta fase

**NO-GO aplicar 334 a producción.**  
**NO-GO conectar F3/F5.**  
Paso B: bloqueado hasta tener un clon de schema fyl-core usable.
