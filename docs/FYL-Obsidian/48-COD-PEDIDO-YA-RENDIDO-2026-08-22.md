# COD — Pedido ya rendido / ya usado (2026-08-22)

**Estado:** implementado en app (TS/UI). Sin migración/RPC. Sin apply.

## Problema

Pedidos `confirmed_*` salen del pool → UI decía solo «Sin candidato principal» aunque existía match fuerte (caso BENTANCURT / A54946).

## Causa del "Bad Request" (2026-08-22)

`lookupAlreadyUsedForRow` / enrichment llamaban PostgREST con:

- `.in("order_id", ~648 UUIDs)` sobre `cod_irregularities`
- `.in("id", ~648 UUIDs)` sobre `orders`

Eso genera URL GET demasiado larga → HTTP **400 Bad Request** (mensaje genérico).
Confirmado: chunk de 100 UUIDs OK; 648 UUIDs falla.

**Fix:** `already-used-loader.ts` batea `.in()` en chunks de 80. Remesas/transportes se cargan aparte (sin nest `transports` dentro de `cod_remittances`).

## Solución UX

1. Detector conservador (`already-used-match.ts`): nombre ≥25 + fecha ≤3 + mismo transporte (o nombre ≥35 + fecha ≤7).
2. Carga ocupación + enrichment en `analyzeRemittance` → `match_breakdown.alreadyUsedOrder`.
3. Lookup on-demand al expandir fila.
4. Banner: **Pedido encontrado — ya vinculado**, distingue **esta misma planilla** vs **otra planilla**; fila #N si es misma; esperado/rendido/diferencia/reclamo.
5. `approved_pending`: texto pendiente de confirmar + misma/otra.
6. Error inesperado: mensaje discreto (nunca "Bad Request" crudo) + `console.error`.

## Caso BENTANCURT

- Fila actual: remesa `c5129c83-…` fila 82, $16.700, unassigned.
- A54946: remesa **otra** `4af7f6b6-…` fila 3, confirmed_with_irregularity, informado $144.000, irreg open amount_diff -16700.
- Esperado UI: bloque ya vinculado en **otra planilla**; A54946 **no** seleccionable en TOP.

Selftest: `already-used-match.selftest.ts`.
