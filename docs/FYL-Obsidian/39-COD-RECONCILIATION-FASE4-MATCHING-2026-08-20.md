# Conciliación COD — Fase 4 Matching (2026-08-20)

**Estado:** migración **278 aplicada en producción** (fyl-core, 2026-08-21). Fase 5 NO empezada.

## 278 en prod

- Firma: `rpc_cod_save_analysis(uuid, jsonb, jsonb) → jsonb`
- SECURITY DEFINER, `search_path=public, pg_catalog`
- GRANT authenticated + service_role; REVOKE anon/PUBLIC
- Snapshots monto/fecha/transporte/order_number desde `orders`
- `matched_name_*` metadata no financiera (validada)
- Reanálisis bloqueado si hay `approved_pending_confirmation` o `confirmed_*`/`void`

## Prueba controlada

Remesa `90564e81-df5f-43c9-a632-b0e01009fd4a` analizada y luego **voided** (sin confirmación financiera). Pendientes COD sin cambio (3027). Irregularidades: 0.


## Qué hace

- Analiza rendición `draft` / `analyzed` → estado `analyzed`.
- Clasifica filas: `auto_matched` | `needs_review` | `unassigned`.
- Motor puro: `nj/lib/reconciliation/matching.ts`.
- Persistencia batch: `rpc_cod_save_analysis` (migración 278).
- UI detalle: resumen + tabs + cards explicativas.
- **Sin** efecto financiero: no confirma, no crea `cod_irregularities`, no muta `orders`.

## Exclusiones del pool

- Excluir: `local_orders` + `confirmed_matched` / `confirmed_with_irregularity`.
- **NO excluir** `approved_pending_confirmation` → warning en `match_breakdown`.

## Snapshots (278)

- **Financieros / pedido (siempre desde DB):** `order_number`, `total_amount`, fecha efectiva, origen, transporte efectivo. JSON del cliente se ignora.
- **Metadata explicativa NO financiera:** `matched_name_snapshot` / `matched_name_source` (validados label/titular/sub_name). **Fase 5 no debe usarlos para cálculos de $.**

## Reanálisis

Rechaza si hay filas `approved_pending_confirmation` o `confirmed_*` / `void`.

## Queries de candidatos

V1 aprobado: 1 fetch de universo COD + Etapa A/B en memoria.
Etapa B nunca produce `auto_matched`.

## No incluye (Fase 5)

Aprobar, asignar manual, confirmar, irregularidades reales, void/correct.


