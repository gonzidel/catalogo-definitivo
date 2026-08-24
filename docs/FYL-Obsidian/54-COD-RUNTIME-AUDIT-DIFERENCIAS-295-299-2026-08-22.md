# COD — Runtime audit Diferencias transporte 295–299 (2026-08-22)

**Estado:** AUDIT COMPLETE (TX throwaway) — **295–300 NOT applied permanently to prod** (`fyl-core`).

**Ejecución:** `supabase db query --linked -f supabase/canonical/tests/_runtime_tx_bundle.sql`  
Bundle = `BEGIN` + apply 295→300 in-session + `cod_transport_differences_runtime_audit.sql` + `ROLLBACK`.

**Resultado runtime:** **42/42 PASS** (2026-08-22).  
**Post-rollback:** `remaining_amount` ausente, `cod_transport_adjustments` ausente → limpio.

**Hard rules:** Never mutate order **A54945** / customer **MAIRA** real. Verificados untouched en fixture.

Diseño / impl: [[52-COD-DISENO-DIFERENCIAS-TRANSPORTE-2026-08-22]] · [[53-COD-IMPL-DIFERENCIAS-TRANSPORTE-295-299-2026-08-22]]

---

## Runtime matrix (resumen)

| # | Caso | Resultado |
|---|---|---|
| 1 | Trigger remaining open→abs; resolve/supersede→0; amount_diff intacto | PASS |
| 2 | Sim complementary parcial (supersede + nueva irreg) | PASS |
| 3 | Register 75495 → classified_adjustment, sin order mutation | PASS |
| 4 | Duplicado activo → reject | PASS |
| 5 | Exact 20k/20k → claim rem 0 resolved, credit compensated, diff histórico | PASS |
| 6 | Parcial 20k/15k → claim rem 5k open | PASS |
| 7 | Crédito 75495−16700 → rem 58795 partially_compensated | PASS |
| 8 | FIFO 2+2 → applied 18000, claim2 rem 2000, credits a 0 | PASS |
| 9 | Cross transport → `cross_transport_not_allowed` | PASS |
| 10 | Overspend 2º compensate → `credit_adjustment_not_active` / credit rem 0 (proxy; FOR UPDATE en 298) | PASS |
| 11–12 | Void adj unused/used; void remesa unused/compensated | PASS |
| 13 | Complementary regression (approve+confirm path) rem=0, sin adjustment | PASS |
| 14–15 | Positive irreg en vista “A favor”; KPI before/after | PASS |
| 16 | Atomicidad bad id + cross → sin partials | PASS |
| 17–18 | A54945 intacto + ROLLBACK | PASS |

Build NJ: `npm run build` **PASS** (con `NODE_TLS_REJECT_UNAUTHORIZED=0` por TLS Google Fonts en entorno local).

---

## Patches `classified_adjustment`

| Objeto | Estado | Acción |
|---|---|---|
| **Confirm 291/294** | **PATCH → 300** | Whitelist `classified_adjustment` como ready (skip COD) |
| **Save analysis 291** | **PATCH → 300** | Whitelist reanalyzable + payload status |
| **Void `_cod_291_void`** | **PATCH → 300** | classified no cuenta como unexpected |
| **Void remesa 299** | **OK (ajustado)** | classified→`unassigned` antes de 291 (no `void`) |
| KPIs / unassigned queries | OK | no cuentan classified |
| 286 / 287 / 293 / 279 assign | OK | rechazan classified |
| mark_row_unassigned | OK by design | void adjustment vía 297 |

Migración nueva (repo only): `supabase/canonical/300_cod_classified_adjustment_row_status_patches.sql`  
Históricos 278–294 **no** se editan.

---

## Trigger / saldo / complementary

- Trigger `_cod_irregularity_remaining_sync`: open/in_review → remaining=abs(diff); resolved/superseded → 0; **amount_diff nunca muda**.
- Vista `cod_v_transport_difference_balances`: claim_open / credit_open / net_balance sobre **remaining**.
- Complementary 292–294: remaining vía trigger; no crea adjustment/compensation.

---

## Archivos de auditoría

- Fixture: `supabase/canonical/tests/cod_transport_differences_runtime_audit.sql`
- Bundle TX: `supabase/canonical/tests/_runtime_tx_bundle.sql` (generado; no apply permanente)
- Output última corrida: `supabase/canonical/tests/_runtime_tx_bundle.out.json`

---

## Gate

**295–300 siguen sin autorización de apply permanente a producción.**  
Runtime PASS en TX con ROLLBACK. Detener aquí.
