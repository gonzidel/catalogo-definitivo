# COD — Fase 6C Corregir asignación confirmada (2026-08-21)

**Estado:** migración **287 aplicada** en fyl-core (2026-08-21). Runtime fixtures `BEGIN…ROLLBACK` PASS. Hardening relectura/FOUND incluido. Sin 6D. Sin 288.

## Alcance

- Corregir fila `confirmed_matched` | `confirmed_with_irregularity` de rendición `confirmed`
- Pedido A → Pedido B (atómico, auditado)
- Evento `assignment_corrected` con previous/new snapshots
- Irregularidad previa `open`/`in_review` → `superseded` (`assignment_corrected`)
- Irregularidad `resolved` → **intacta** (solo auditada en `previous_state`)
- Diff con B → nueva irregularidad `open`
- UI: “Corregir asignación” en detalle de rendición confirmed
- Alias opcional **después** de corrección exitosa (no revierte si falla)

## Fuera de alcance

- Fase 6D anulación completa de rendición
- DELETE / corrección masiva
- Reabrir cabecera / reconfirmar planilla
- Mutar `orders`

## RPC

`rpc_cod_correct_confirmed_assignment` en `287_rpc_cod_correct_confirmed_assignment.sql`

Firma: `(p_remittance_id, p_row_id, p_new_order_id, p_reason, p_force, p_matched_name_snapshot, p_matched_name_source)`

Motivo (`p_reason`) obligatorio.

## Concurrencia

Locks de pedidos A y B con `FOR UPDATE` en **orden UUID ascendente** (anti-deadlock).
Defensa final: `uq_cod_rows_matched_order_active`.

## KPIs

Cantidad pendientes / conciliados: **neta estable** (A sale de conciliados, B entra).
Monto pendiente puede cambiar si `total_amount(A) ≠ total_amount(B)`.

Invariante: `TOTAL UNIVERSO = PENDIENTES + CONCILIADOS`.

## Aplicar

Requiere autorización explícita. No hay 6D.
