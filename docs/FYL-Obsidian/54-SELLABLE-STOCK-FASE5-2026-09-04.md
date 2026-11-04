# 54 — Sellable stock: Fase 5 frescura del snapshot — 2026-09-04

## Qué cambió

`catalog_public_snapshot` converge solo a `catalog_public_available_view`.

No es una segunda fórmula: el rebuild sigue siendo `TRUNCATE + INSERT SELECT * FROM vista` (213), en una transacción.

Mutaciones relevantes solo marcan dirty + `change_revision++`.
El cron cada 5 minutos llama `rpc_refresh_catalog_snapshot_if_dirty()`.

## Carrera

Worker captura `revision_start`. Si durante el rebuild otra mutación incrementa revision, `dirty` permanece true. El próximo ciclo vuelve a copiar.

## 309

`awaiting_apartado` no toca `variant_size_warehouse_stock` → no dirty.

VSS: un trigger STATEMENT `INSERT OR UPDATE OR DELETE` sin transition tables. Cualquier cambio de físico marca dirty (hoy solo existen `general` y `venta-publico`).
El commit/apartado que sí mueve físico dispara el trigger de VSS.

## Next / ISR

No hay `revalidateTag` (las páginas no usan fetch etiquetado).
ISR `revalidate = 300`. Cliente SWR reconsulta al volver a la pestaña si cambió `rpc_catalog_public_version().revision`.

SLA Home peor caso ≈ 5 min (DB) + 300 s (ISR) ≈ **10 min** para HTML; pestaña abierta converge al focus.

## Observabilidad

```sql
select public.rpc_catalog_snapshot_observability(); -- JWT admin
select * from cron.job where jobname = 'catalog-snapshot-refresh-if-dirty';
```

## Migración

- Apply: `supabase/canonical/332_catalog_snapshot_dirty_refresh.sql`
- Rollback: `332_ROLLBACK_catalog_snapshot_dirty_refresh.sql`
- Tests (ROLLBACK): `332_catalog_snapshot_dirty_refresh_tests.sql`

La migración deja dirty=true y ejecuta un refresh_if_dirty inicial para cerrar el drift (661 vs 665 arts al corte).

## Apply producción 2026-09-04 (corrección VSS)

Nombre: `332_catalog_snapshot_dirty_refresh` (`20260904180708`).

El primer apply falló por `REFERENCING` + I/U/D (0A000). Se corrigió el canónico: un solo trigger STATEMENT VSS sin transition tables. Rollback sigue dropeando `trg_catalog_snap_dirty_vss` y `fn_trg_catalog_snapshot_dirty_vss` (IF EXISTS). Ningún otro trigger 332 usa `REFERENCING`.

| Check | Resultado |
|---|---|
| Rebuild inicial (en el apply) | 642 ms, 1309 filas |
| Cron 18:10 UTC | rebuild 837 ms (dirty=true por mutaciones post-apply) |
| Cron 18:15 UTC | rebuild 994 ms |
| Cron 18:20 UTC | rebuild 854 ms → dirty=false, revision 20 |
| Cron 18:25 UTC | **57 ms, skipped/clean** — no tocó `last_success_at` / `last_duration_ms` |
| dirty | false |
| last_error | null |
| last_success_at | informado |
| Vista vs snapshot | 1309/1309, 661/661 arts, 0 drift de `variant_id` |
| Checkout 331 | `rpc_checkout_cart()` md5_def `9901c2cf…` intacto |
| 309 | no tocado |

Nota: 84 filas pueden diferir solo en `ColorHex` por colores `suela`/`Suela` (join de vista 330). No es drift de stock ni de 332.

No se avanzó a Fase 6.

## No tocado

Sellable, vista 330, PDP, CartTab, checkout, 309, OISS, reserved_qty, vanilla, Fase 6.
