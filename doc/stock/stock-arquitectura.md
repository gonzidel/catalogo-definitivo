# FYL Stock: Arquitectura Fuente de Verdad

## Resumen

En FYL, la fuente de verdad de stock para decisiones criticas de disponibilidad es:

- `public.variant_size_warehouse_stock`

Esta tabla modela stock fisico por:

- variante (`variant_id`)
- talle (`size`)
- deposito (`warehouse_id`)

## Tablas principales

- `variant_size_warehouse_stock`: stock fisico canonico por talle y deposito.
- `variant_sizes`: stock derivado por talle (sin deposito), sincronizado por trigger.
- `variant_warehouse_stock`: stock derivado por variante y deposito, sincronizado por trigger.
- `product_variants.reserved_qty`: reserva agregada historica a nivel variante.
- `order_item_stock_sources`: trazabilidad de stock **ya descontado** al comprometer (checkout/commit). Sirve para restaurar en cancel/expire. No es un segundo hold.
- `cart_items`: persistencia de carrito. `status = 'reserved'` **no** gobierna disponibilidad pública desde 330.

## Stock vendible público (330)

Fuente canónica para catálogo / PDP futuro:

- `sellable_qty = greatest(sum(stock_qty), 0)` en `variant_size_warehouse_stock` para warehouses `general` + `venta-publico`

Funciones: `fn_norm_size`, `fn_sellable_qty`, `fn_sellable_stock_batch`.

`catalog_public_available_view` usa esa semántica. **No** resta OISS, `cart_items`, `reserved_qty` ni `awaiting_apartado`.

`rpc_checkout_cart` (rama normal, 331) valida el físico web del talle **después** de `FOR UPDATE` de `variant_size_warehouse_stock` (`general` + `venta-publico`). `reserved_qty` se escribe pero **no** gobierna el accept/reject. La rama 309 no usa este gate.

Listados NJ (Fase 4): `hasStock` sale del snapshot/vista sellable. El enrich no vuelve a leer `variant_sizes`.

Fase 5: `fn_mark_catalog_snapshot_dirty` + `rpc_refresh_catalog_snapshot_if_dirty` (pg_cron cada 5 min). El snapshot no es una segunda lógica: copia la vista.

## Por que NO usar `variant_sizes` para decisiones criticas

`variant_sizes.stock_qty` es una tabla derivada. Aunque se sincroniza por trigger, puede quedar temporalmente desalineada por:

- errores operativos
- procesos incompletos
- drift historico previo

Por ese motivo:

- usar `variant_sizes` para UI auxiliar puede ser aceptable
- usar `variant_sizes` para publicar/ocultar productos NO es robusto

## Triggers de sincronizacion relevantes

- `84_sync_variant_sizes_on_warehouse_stock.sql`
  - sincroniza `variant_sizes.stock_qty` desde `variant_size_warehouse_stock`
- `145_sync_variant_warehouse_stock.sql`
  - sincroniza `variant_warehouse_stock.stock_qty` desde `variant_size_warehouse_stock`

## Riesgo principal conocido

Si un modulo toma decisiones de disponibilidad sobre una tabla derivada, puede mostrar:

- productos sin stock real como visibles
- productos con stock real como ocultos

La regla recomendada es: decisiones de visibilidad/publicacion solo con stock canonico.

## Queries utiles de debug

### 1) Diferencias entre stock derivado y canonico (por talle)

```sql
select
  coalesce(vs.variant_id, vss.variant_id) as variant_id,
  coalesce(vs.size, vss.size) as size,
  coalesce(vs.stock_qty, 0) as variant_sizes_qty,
  coalesce(vss.sum_stock, 0) as variant_size_warehouse_sum
from public.variant_sizes vs
full join (
  select variant_id, size, sum(stock_qty)::int as sum_stock
  from public.variant_size_warehouse_stock
  group by variant_id, size
) vss
  on vss.variant_id = vs.variant_id
 and vss.size = vs.size
where coalesce(vs.stock_qty, 0) <> coalesce(vss.sum_stock, 0)
order by 1, 2;
```

### 2) Drift de reservas

```sql
select *
from public.vw_stock_audit_reserved_qty_diff
order by abs(delta) desc;
```
