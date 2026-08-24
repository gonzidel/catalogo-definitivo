# COD — Apply prod 295–300 + post-apply audit (2026-08-22)

**Estado:** APPLIED to prod `fyl-core` (`dtfznewwvsadkorxwzft`) — intervención controlada 295→300.

**Orden apply:** 295 → 296 → 297 → 298 → 299 → 300 (sin uso del módulo entre migraciones).

**Fixtures post-apply:** `cod_transport_differences_runtime_audit.sql` → **42/42 PASS** (BEGIN…ROLLBACK).

**No se registró** MAIRA / A54945 real como adjustment.

Ver también: [[54-COD-RUNTIME-AUDIT-DIFERENCIAS-295-299-2026-08-22]] · [[53-COD-IMPL-DIFERENCIAS-TRANSPORTE-295-299-2026-08-22]]

---

## Schema / grants (live)

| Objeto | Estado |
|---|---|
| `cod_irregularities.remaining_amount` | presente, NOT NULL |
| trigger `trg_cod_irregularity_remaining_sync` | OK |
| `classified_adjustment` en row_status check | OK |
| `cod_transport_adjustments` + RLS SELECT authenticated | OK; anon sin SELECT |
| compensations + lines + vista balances | OK |
| RPCs register / void adj / compensate / list | OK |
| `rpc_cod_void_confirmed_remittance` (299) | bloquea compensados |
| Confirm / save_analysis / void291 (300) | contienen `classified_adjustment` |

## Backfill remaining

3 irregularities existentes:

| status | amount_diff | remaining |
|---|---|---|
| resolved | -16700 | 0 |
| open | -204000 | 204000 |
| open | -52300 | 52300 |

`open_mismatch=0`, `remaining_null=0`, `amount_diff` histórico intacto.

## Fixtures (TX)

register, duplicado, exact/parcial, FIFO, cross-transport, overspend, voids, complementary regression, KPI vista, atomicidad, A54945 untouched — **PASS**.

## Post-rollback fixtures

- adjustments/compensations/lines = **0**
- irregularities = **3** (reales, sin fixtures)
- classified_rows = **0**
- A54945: Pagado / 71900 / sent

## Build / tests

- `next build`: PASS
- `phase-transport-differences.selftest`: **48/48**
- `phase-complementary.selftest`: **46/46**
- `phase5-rpc.selftest`: **40/40**
- `phase6b-unassigned.selftest`: **40/40**
- `save-analysis-rpc.selftest`: **40/40**
- `phase6d-void.selftest`: **51 ok, 1 fail** estático preexistente (`action mapea void count mismatch` — `actions.ts` no contiene string `row_void_count_mismatch`; no bloquea apply/runtime)

Vista live SEDE: claim_open=256300, credit_open=0, net=256300 (204000+52300).

**DETENER** — listo para uso operativo; no registrar crédito MAIRA/A54945 en esta intervención.
