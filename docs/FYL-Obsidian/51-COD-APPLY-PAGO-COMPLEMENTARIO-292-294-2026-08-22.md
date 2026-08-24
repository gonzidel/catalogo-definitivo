# COD — Apply pago complementario 292–294 (2026-08-22)

**Estado:** APLICADO en fyl-core (`dtfznewwvsadkorxwzft`) en una sola intervención.

## Apply

1. `292_cod_complementary_payments_schema` — OK
2. `rpc_cod_approve_complementary_payment_293` — OK
3. `cod_complementary_payment_financial_flow_294` — OK

## Baseline → post-rollback

| Métrica | Baseline | Post-fixtures ROLLBACK |
|---|---|---|
| confirmed_rows | 537 | 537 |
| aliases | 19 | 19 |
| A54946 | confirmed_with_irregularity / open -16700 | intacto |
| assignment_role ≠ primary | 0 | 0 |
| complementary events | 0 | 0 |

## Fixtures

39/39 steps PASS en BEGIN/ROLLBACK (exact, partial, third, excess, irreg inconsistente, concurrency, 287, 288, KPI, A54946/aliases).

## Nota

No se aplicó ningún pago complementario real. A54946 real no se tocó.
