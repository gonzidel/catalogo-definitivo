# COD — Fase 6B Asignar unassigned post-confirmación (2026-08-21)

**Estado:** migración **286 aplicada** en fyl-core (2026-08-21). Runtime fixtures `BEGIN…ROLLBACK` PASS. Sin 6D. Sin apply de 287.

**KPI “Sin identificar”:** solo `unassigned` de rendiciones `status='confirmed'` (excluye draft/analyzed/voided). Misma definición en dashboard y `/sin-identificar`.

**Siguiente (preparada, no aplicada):** Fase 6D → ver `45-COD-FASE6D-VOID-REMITTANCE-2026-08-21.md` / migración `288`.

**Estado 6C:** migración **287 aplicada** en fyl-core (2026-08-21).

## Alcance

- Asignar `row_status=unassigned` de rendición `confirmed` → `confirmed_matched` | `confirmed_with_irregularity`
- Crear irregularidad open si hay diff (paridad 280)
- UI: `/admin/conciliacion-reembolso/sin-identificar`
- Alias opcional post-asignación (no revierte si falla)

## Fuera de alcance

- 6C corrección A→B
- 6D anulación rendición
- Reabrir cabecera / reconfirmar

## Decisión RPC

**No** reutilizar `rpc_cod_assign_row` (279): exige `analyzed` y solo llega a `approved_pending_confirmation`.

Nueva: `rpc_cod_assign_confirmed_unassigned_row` en `286_rpc_cod_assign_confirmed_unassigned.sql`.

## Eventos

Reutiliza `manual_assignment` + `irregularity_created` (sin ampliar CHECK).

## Aplicar

Requiere autorización explícita. No hay 287.
