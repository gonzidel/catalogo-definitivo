# 35 — RFC `rpc_create_admin_order_atomic` (borrador)

**Fecha:** 2026-05-15  
**Tipo:** diseño técnico — **sin implementación** acordada en este documento.

## Fuente de verdad (repo)

- **`doc/rfc-rpc-create-admin-order-atomic-2026-05-15.md`**
- **Estrés concurrencia / simulación fallos (sin implementación):** `doc/rfc-create-admin-order-atomic-concurrency-stress-2026-05-15.md`
- **Idempotencia v1 congelada (contrato definitivo):** `doc/rfc-create-admin-order-atomic-idempotency-contract-v1-2026-05-15.md`  
**Plan implementación staging (SQL + flag + checklists):** `doc/plan-implementacion-rpc-create-admin-order-atomic-staging-2026-05-15.md`

## Contexto

- Diagnóstico previo: [[34-ADMIN-WRITES-STOCK-ORDERS-AUDIT-2026-05-15]]
- Descuento transaccional existente (referencia interna): migración canónica `166_rpc_apply_order_stock_deduction.sql`

## Resumen

Una sola RPC PostgREST que envuelva `INSERT orders` + `order_items` + lógica equivalente a inyección manual + `rpc_apply_order_stock_deduction`, con idempotencia y sin rollback manual desde el cliente.
