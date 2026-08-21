# Conciliación COD — Fase 5 (2026-08-21)

**Estado:** 279/280 **APLICADAS en producción** (`fyl-core` / `dtfznewwvsadkorxwzft`). Runtime controlado OK. Fase 6 NO empezada.

## Alcance

- Aprobar seguras (`auto_matched` → `approved_pending_confirmation`)
- Revisar / asignar / buscar manual / dejar unassigned
- Confirmar rendición atómica (`confirmed_*` + irregularidades reales)

## Migraciones aplicadas

- `279` (partes MCP): helper + `rpc_cod_approve_auto_matched` + `rpc_cod_assign_row` + `rpc_cod_mark_row_unassigned`
- `280_rpc_cod_confirm_remittance`

## Invariantes verificados post-apply

- Snapshots financieros desde DB; `parsed_amount` obligatorio
- Solo `analyzed` en ops 279
- Confirmación atómica + `orders ... FOR UPDATE`
- Tests 279: 21/21; tests 280: 9/9 + simulación concurrencia (rollback)
- Pendientes post-tests: **3027**; irreg open: **0**; sin confirmed de prueba persistidos
- **NO** migración 281; **NO** Fase 6
