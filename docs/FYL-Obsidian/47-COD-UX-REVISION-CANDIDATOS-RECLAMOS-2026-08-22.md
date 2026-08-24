# COD — UX revisión / candidatos / reclamos (auditoría 2026-08-22)

**Estado:** auditoría + UX segura implementada en app. **Sin** migración/RPC. **Sin** apply.

## Implementado (app)

- Cards TOP candidatos con nombre / fecha / monto / transporte / diff
- Bloque “informado → vinculación” con señales humanas ✓/~ /✕ /⚠
- Modal confirmar: 3 preguntas + consecuencia de reclamo
- Irregularidades: Nº cliente, tipo Faltante/Sobrante, copy operativo
- Preview pegado: montos con `formatPriceAr`
- Matching TS: rescate `strong_identity_weak_amount` → `needs_review` (nunca auto)
- Selftests matching: 69 ok
- **Titular en TOP candidatos** (2026-08-22): `customerDisplayName` / `customerNumber` / `labelCustomerName` en `CandidateScore`; UI usa titular ≠ `matchedNameSnapshot`; fallback read-only al cargar filas viejas (`enrich-match-candidates.ts`)

## Causa «Sin nombre» (ORTEGA MAIRA / A55083…)

`candidatePrimaryName` usaba solo `matchedNameSnapshot`. Con score de nombre 0 ese campo es `null` → «Sin nombre», aunque `customers.full_name` exista (ej. A55083 → BARRETO ROMINA). El JSON de `match_candidates` ya tenía `customerId` / `orderNumber` pero **no** el titular.

Preferencia visual: titular → label → matchedNameSnapshot → «Cliente sin nombre».

## Causa BENTANCURT / A54946 (demostrada)

Planilla en remesa `c5129c83…` (SEDE, rev 2): `BENTANCURT MARIELA` / 13/07/2026 / $16.700 → `unassigned`, TOP score 45.

A54946 ya está **confirmado** en remesa `4af7f6b6…` (`confirmed_with_irregularity`, irreg abierta −$16.700). El pool excluye `confirmedIds` → no entra.

Si estuviera en pool: score **75** → `needs_review`. El monto grande no lo ocultaría; la exclusión financiera sí.

## Irregularidades / sub-nombres

Reutilizar `cod_irregularities`. Sub-nombres = `customers.additional_names` ≠ aliases COD.

## Nota ORTEGA MAIRA / A54945 (2026-08-22)

Planilla $75.495 SEDE. Pedido «correcto» **A54945** ($71.900, titular ORTEGA MAIRA) **no entra al pool** porque `payment_method = 'Pagado'`, no `Contra Reembolso`.

Hipótesis si fuera COD: name 40 + date 30 + amount 8 + transport 5 = **83** (diff +$3.595).

TOP 35/27 son COD del mismo día/transporte con name 0. La UI no puede depender solo del TOP.

**Fix UX:** búsqueda unificada «Buscar / asignar pedido» con lookup **exacto** por `order_number`. Si el pedido no es COD, se muestra bloqueado (no oculto). RPC 279 también exige Contra Reembolso.

Ver también enrichment de titular en TOP (`customerDisplayName`).
