# 71 — Quitar ítem con opción de reingreso de stock (2026-09-24)

## Contexto

Tras auditar CONY14 talle 38: un reingreso por cancelación confirmada dejó 1 unidad en sistema que no se encontraba físicamente. Además, el admin puede agregar con stock 0 (`rpc_admin_manual_inject_and_deduct`), lo que crea fuentes; al quitar, el sistema reingresaba +1 fantasma.

## Decisión

**Clasificación: NEGOCIO CONFIRMADO + TÉCNICA VERIFICADA (código local).**

- No preguntar al agregar (no dificultar el flujo).
- Al quitar un ítem con fuentes: preguntar **¿vuelve al stock físico?**
- Default: No si `admin_confirmed_missing`; Sí si hubo descuento real.

## Cambios

- Migración `361_rpc_remove_order_item_optional_restore.sql`: `p_restore_stock boolean DEFAULT true`
- Kanban nj (`OrderCardItems`, `OrderEditModal`) + PAU / orders / sent-orders
- Docs: `docs/06_PEDIDOS.md`

## Riesgo / rollback

- Riesgo medio (RPC de producción). Callers de 1 arg siguen reingresando por DEFAULT.
- Rollback: `361_ROLLBACK_...` + reaplicar `356_order_item_missing_total_trigger.sql`

## Despliegue

Requiere aplicar 361 en `fyl-core` con aprobación explícita antes de usar la UI nueva en producción.
