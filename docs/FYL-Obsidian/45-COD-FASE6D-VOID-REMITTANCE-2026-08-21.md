# COD — Fase 6D Anular rendición confirmada (2026-08-21)

**Estado:** migración **288 aplicada** en fyl-core (2026-08-21). Runtime tests `BEGIN…ROLLBACK` OK. Sin anulación operativa real.

## Auditoría schema (sin columnas nuevas)

Ya existían en `272`:

| Objeto | Estado |
|--------|--------|
| `cod_remittances.status` incluye `voided` | OK |
| `voided_by` / `voided_at` / `void_reason` | OK |
| `row_status` incluye `void` | OK |
| `uq_cod_rows_matched_order_active` solo `confirmed_*` | OK (`void` fuera) |
| `event_type` `remittance_voided` | OK |
| `superseded_reason` `remittance_voided` | OK |

No se creó migración de schema adicional.

## RPC

`rpc_cod_void_confirmed_remittance(p_remittance_id, p_reason)` en `288_rpc_cod_void_confirmed_remittance.sql`

- Solo `status=confirmed`; motivo obligatorio
- Filas `confirmed_*` → `void` (conserva matched_order_id + snapshots)
- `unassigned` sin cambio de status (salen del KPI por cabecera voided)
- Irreg `open`/`in_review` → `superseded` (`remittance_voided`)
- `resolved` / `superseded` previas intactas
- Cabecera → `voided` + actor/fecha/reason server-side
- Evento `remittance_voided` con resumen KPI (sin PII masiva)
- No DELETE, no muta `orders`, no toca aliases

## Locks

1. remittance `FOR UPDATE`
2. filas `ORDER BY id FOR UPDATE`
3. orders asociados `confirmed_*` en UUID ASC
4. Revalidación post-lock

## UX

Detalle confirmed → acción secundaria “Anular rendición” + modal con motivo + escribir `ANULAR`.
Voided → banner solo lectura (sin analizar/corregir/asignar).

## Fuera de alcance

- unvoid / restore
- hard delete
- modificar 279/280/286/287

## Hardening (pre-apply)

- `v_cnt_other > 0` → `remittance_has_unexpected_row_states`
- `confirmed_*` con `matched_order_id IS NULL` → `confirmed_row_missing_order`
- Lock order: `SELECT … FOR UPDATE` + `IF NOT FOUND` → `matched_order_missing`
- Post-update: `v_rows_voided = v_cnt_exact + v_cnt_irreg` o `row_void_count_mismatch`
- Revalidación post-lock: solo `confirmed_matched` / `confirmed_with_irregularity` (void no aceptable)

## Apply + verificación (2026-08-21)

- Apply: `rpc_cod_void_confirmed_remittance` OK
- Grants: anon/PUBLIC false · authenticated/service_role true · SECURITY DEFINER · search_path fijo
- Runtime BEGIN/ROLLBACK: exact→void, open/in_review→superseded, resolved/superseded intactas, unassigned KPI, corrected B, hardening×4, precondiciones, atom70, concurrencia secuencial, KPI TOTAL estable
- Post-rollback: 93 confirmed reales, 0 events phase=6d, sin fixtures
- 279/280/286/287 intactas · sin 289 · sin anulación operativa real
