# 58 — Auditoría: puesta a cero total del stock — 2026-09-04

Auditoría **solo lectura**. No se ejecutó UPDATE/DELETE/INSERT ni RPC mutante.
Proyecto: fyl-core (`dtfznewwvsadkorxwzft`).

Objetivo futuro: `stock_qty = 0` en todos los depósitos, sin borrar identidad
ni tocar pedidos/QR/carga.

## Fuente de verdad

Tabla canónica: `variant_size_warehouse_stock.stock_qty`
Clave: `variant_id + size + warehouse_id` (UNIQUE live).

Confirmado contra migraciones 84/145/148/164/330/331/332, triggers live,
`fn_sellable_qty`, NJ (`sellable-stock.ts`, `PdpLoader`) y admin (lectura VSS).

`variant_sizes.stock_qty` y `variant_warehouse_stock.stock_qty` son **derivados**.
Hoy están alineados: 100.388 = 100.388 = 100.388.

No hay stock extra en variantes sin talle (`vws_gt0_without_matching_vss = 0`).

## Warehouses live

Solo 2. `warehouses.code` es UNIQUE. Sin aliases ni inactivos.

| code | nombre | id | filas | >0 | unidades |
|---|---|---|---|---|---|
| general | Almacén General | `bec14f04-8b4a-4c99-97c6-36d6feef6bb0` | 15742 | 3430 | 99919 |
| venta-publico | Venta al Público | `ac16a5b7-b8e3-4f36-8259-7ae1e2a067a0` | 9407 | 274 | 469 |

VSS total: 25149 filas; 21445 ya en 0; 0 negativas; 0 duplicados; 0 filas fuera de esos UUID.

## SQL conceptual (NO ejecutado)

Un UPDATE, 3704 filas, misma transacción, trigger 71 deshabilitado:

```sql
BEGIN;
SET LOCAL statement_timeout = '120s';
ALTER TABLE public.variant_sizes
  DISABLE TRIGGER trigger_update_status_on_variant_sizes;
UPDATE public.variant_size_warehouse_stock
SET stock_qty = 0
WHERE stock_qty <> 0
  AND warehouse_id IN (
    SELECT id FROM public.warehouses
    WHERE code IN ('general', 'venta-publico')
  );
ALTER TABLE public.variant_sizes
  ENABLE TRIGGER trigger_update_status_on_variant_sizes;
COMMIT;
```

`updated_at` lo pone `variant_size_warehouse_stock_set_updated_at`.
`CHECK (stock_qty >= 0)` admite 0.

## Cascada

Se disparan: set_updated_at, 84 (sizes), 145 (VWS), 332 dirty STATEMENT.
Cron `catalog-snapshot-refresh-if-dirty` `*/5` reconstruye snapshot.

**No** se dispara historial: no hay trigger VSS → `stock_history`.
**No** realtime (VSS no está en `pg_publication_tables`).
**No** webhooks.

Peligro: `trigger_update_status_on_variant_sizes` → `update_product_status()`
pone `products.status = 'pending_stock'`. Live confirmado. 662 productos
`active` con VSS > 0 fliparían. PDP fallback filtra `status = 'active'`
(`nj/components/pdp/PdpLoader.tsx`). Por eso el día D hay que deshabilitar 71.

## Veredictos

| Tema | Resultado |
|---|---|
| Pedidos / 309 | PASS directo. 0 awaiting_apartado, 0 waiting. |
| OISS | PASS. 0 triggers. 5268 filas / 5669 qty intactas. |
| reserved_qty | PASS. 8208 legado; no gobierna sellable/331. |
| Catálogo NJ | PASS si 71 off; RIESGO PDP 404 si 71 on. |

Rehidratación posterior (no es el UPDATE): cron `orders-daily-maintenance` `*/15`
devuelve stock al expirar `active`/`closing_soon`. Hoy 23 active; primer
`dismantle_at` 2026-09-07 20:00 UTC; 3 OISS / 6 uds en esos pedidos.

## Backup mínimo

1. `variant_size_warehouse_stock` (`variant_id`, `size`, `warehouse_id`, `stock_qty`)
2. `products.id, status` (cinturón por si 71 corre)

84/145 + cron restauran derivados y snapshot al devolver VSS.

## No tocar

products (salvo el riesgo 71), product_variants, precios, reserved_qty,
variant_sizes como entidad, SKUs, offers, orders, OISS, carts, clientes,
imágenes, tags, snapshot manual, 309, QR.

## Enlaces

- [[02-MODELO-STOCK-ACTUAL]]
- [[51-SELLABLE-STOCK-FASE1-2026-09-04]]
- [[54-SELLABLE-STOCK-FASE5-2026-09-04]]

## Aplicado 2026-09-05

Transacción exacta (71 off → UPDATE VSS → 71 on). Sin DELETE. Sin tocar pedidos.

Huella pre-COMMIT: 3508 filas ≠0 · 99443 uds · fp products `ac91d9fd…` · 638 active.

Post-COMMIT: VSS/sizes/VWS = 0 · filas VSS 25165 intactas · fp products idéntico · reserved 9152 · orders 6440 · OISS 5375/5795.

Cron 13:45 UTC: snapshot 0 filas, vista 0, `last_error` null, 787 ms. `dirty` siguió true (revision 3790); rebuild correcto.

Backup local: `audit-output/stock-zero-2026-09-05/`. PASS.
