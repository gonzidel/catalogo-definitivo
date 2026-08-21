# COD — Fase 6A Irregularidades / Reclamos (2026-08-21)

**Estado:** migraciones **284/285 APLICADAS** en fyl-core (`dtfznewwvsadkorxwzft`). Runtime fixture BEGIN/ROLLBACK OK. **No** 6B/6C/6D.

## Alcance

- Gestionar reclamos ya creados por confirmación (280): `open` / `in_review` / `resolved`
- UI: `/admin/conciliacion-reembolso/irregularidades` (+ detalle)
- RPC: `rpc_cod_update_irregularity_status`
- Eventos: `irregularity_review_started`, `irregularity_resolved` (ya existía)

## Fuera de alcance (6B/6C/6D)

- Unassigned post-confirmación
- Corrección de conciliaciones
- Anulación de rendiciones
- `superseded` manual

## Schema auditado (fyl-core)

`cod_irregularities` ya tiene: `resolved_by`, `resolved_at`, `resolution_note`, statuses CHECK.
No hace falta migración de columnas de resolución.

## Apply producción (2026-08-21)

- `284_cod_irregularity_review_event_type` — OK
- `285_rpc_cod_update_irregularity_status` — OK
- Runtime A–I en `BEGIN…ROLLBACK` — PASS
- Post-rollback: `cod_irregularities=0`, eventos `irregularity_review_started/resolved=0`
- Sin policies UPDATE nuevas (solo SELECT)
- **No** Fase 6B/6C/6D

## Migraciones propuestas (canonical)

1. `284_cod_irregularity_review_event_type.sql` — **aplicada**
2. `285_rpc_cod_update_irregularity_status.sql` — **aplicada**


## Transiciones

| Desde | Hacia | Notes |
|---|---|---|
| open | in_review | opcionales |
| open | resolved | obligatorias |
| in_review | resolved | obligatorias |

Rechaza: resolved→*, superseded→*, *→superseded manual.

## Efecto financiero

Resolver **no** cambia `row_status`, `matched_order_id`, `orders`, ni pendientes.
Dashboard: irreg abiertas ↓; conciliados totales invariantes.

## Tests

`npx tsx lib/reconciliation/phase6a-irregularities.selftest.ts` (estático 284/285).
