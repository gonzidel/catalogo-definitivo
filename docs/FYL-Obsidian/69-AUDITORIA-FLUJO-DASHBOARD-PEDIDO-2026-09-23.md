# 69 — Auditoría total: flujo dashboard cliente / pedido (2026-09-23)

Ver también: [[65-AUDITORIA-PEDIDOS-EXPIRED-INVISIBLES-Y-STOCK-FANTASMA-2026-09-15]], [[48-AUDITORIA-ESTADOS-PEDIDOS-Y-FIXES-2026-08-01]], canvas `auditoria-flujo-dashboard-pedido-2026-09-23`.

## Alcance

Flujo completo pre-lanzamiento: carrito → checkout → Mi pedido (NJ `ActiveOrderTab`) → apartado / espera / missing / cancel parcial / replace / pedir cierre / close / cancel pedido / vencimiento soft. Cruzado con RPCs en prod (`fyl-core`) y legacy `client/dashboard-instant.js`.

## Veredicto

**Hay al menos un P0 vivo que ya dañó totales en producción.** Mark→missing (354/356) y cierre NJ están bien. El agujero es **cancelar un ítem que ya está `missing`**: `rpc_cancel_order_item` / `_units` siempre restan `price * qty` del total, pero 356 ya lo sacó al pasar a missing.

No lanzar cobros masivos hasta parche + reparación de pedidos afectados.

## Hallazgos

### P0 — Doble resta al cancelar desde missing

- **Código:** `rpc_cancel_order_item` (prod, cuerpo post-312/269) actualiza `total_amount` sin mirar si el ítem venía de `missing`.
- **UI:** `ActiveOrderTab.handleCancelItem` / quitar unidades llaman esas RPCs.
- **Evidencia prod (cancelled_from_status=missing + total &lt; suma operativa):**
  - **A57356:** −$35.500 (AT-325 $14.000 + BS-505 $21.500)
  - **A57180:** −$13.000 (RO-890-RS; el otro missing-cancel parece era pre-356)
  - **A57219:** −$6.000 (KIT-VA)
- **Fix propuesto:** si `status`/`cancelled_from_status` = missing, no modificar `total_amount` (misma idea que 345 para writeoff). Tests + backfill de los tres pedidos (+ A56761 abajo).

### P0 — Datos abiertos inconsistentes

| Pedido | Problema |
|--------|----------|
| A57356, A57180, A57219 | Undercharge por cancel-from-missing |
| A56761 | Solo missing; total $30.000 (marca 2026-09-14, pre-356) |

Pedidos con missing y total **correcto** post-356: A57251, A57304 (excl = total).

### P1 — `rpc_customer_replace_missing_item` recalc

Recalcula con `status != 'cancelled'`, reincorpora otras líneas missing. Hoy lo corrige `trg_orders_total_exclude_missing` (354). Endurecer el SUM a `NOT IN ('cancelled','missing')`.

### P1 — Legacy `dashboard-instant.js` truncado

Working tree: SyntaxError ~L6292; archivo más corto que HEAD. `client/dashboard.html` redirige a `/catalogo` (NJ), así que el path vivo es NJ; igual no redeployar `client/` hasta restaurar.

### P1 — Dualidad legacy vs NJ en cierre

NJ: retiro local → `rpc_customer_request_close`; envío → `rpc_close_order`. No reactivar close legacy con reserved.

### P2 — Residuales

A57177 (+$11.500 vs suma picked), A56703 closed aún con missing y total raro: revisar aparte tras el fix P0.

## Lo que está sano (no reabrir)

- 354 close/checkout excluyen missing; trigger BEFORE UPDATE total.
- 356 trigger al pasar a missing; mark ya no resta a mano.
- 344/345 fuentes y writeoff.
- Soft vencido ≤1 día cede a Activos/Espera si hay reserved/waiting (`classification.ts`).
- Cancel pedido completo post-346 (contrato terminal).
- Waiting factory vs local facing en NJ.

## Plan mínimo pre-lanzamiento

1. Migración cancel item/units: skip total si origen missing.
2. Reparar totales A57356, A57180, A57219, A56761 (aprobación explícita SQL).
3. Endurecer recalc replace_missing.
4. No publicar legacy truncado.
5. Smoke: mark→cancel; mark→replace (2 missing); close con missing; request_close retiro local.

## Implementación (2026-09-23) — APLICADO en fyl-core

| Archivo | Contenido |
|---------|-----------|
| `359_cancel_missing_skip_total.sql` | cancel item/units skip total si missing; replace excluye missing |
| `359_ROLLBACK_cancel_missing_skip_total.sql` | restaura cuerpos pre-359 |
| `359_cancel_missing_skip_total_tests.sql` | fingerprints + deltas pedidos |
| `359_BACKFILL_order_totals_cancel_missing.sql` | A57356→451000, A57180→67900, A57219→75600, A56761→0 |

### Evidencia post-apply

- Comentarios `canonical:359` en las 3 RPCs; `cancel_skips` / `units_skips` / `replace_excludes` = true; units sin deferred.
- Backfill: A57356, A57180, A57219, A56761 con **delta = 0**.

## Rollback / riesgo

Parche cancel: bajo (solo evita resta). Backfill datos: medio (validar suma excluyendo cancelled+missing antes de UPDATE).
