# COD — Implementación Differencias transporte 295–299 (2026-08-22)

**Estado:** REPO ONLY. **NO APPLY. NO tocar MAIRA/A54945 real.**

**Diseño base:** [[52-COD-DISENO-DIFERENCIAS-TRANSPORTE-2026-08-22]]

## Resumen entrega

| # | Contenido |
|---|---|
| Schema | remaining_amount + trigger; classified_adjustment; adjustments; compensations; vista saldo |
| row_status | classified_adjustment (no confirmed_matched) |
| remaining | amount_diff intacto; resolved/supersede → 0 vía trigger |
| Complementary | 294 histórico sin editar; coherencia vía trigger 295 |
| Adjustments | solo transport_credit; monto parsed_amount DB |
| Compensations | FIFO min(claims,credits); evento irregularity_compensated |
| Void | unused OK; used → reject; remesa bloqueda si compensado |
| Saldo | claim_open − credit_open (remaining) |
| UX | /irregularidades = Diferencias; ?legacy=1 reclamos; CTA registrar en remesa |
| SQL | 295–299 en supabase/canonical/ |
| Tests | phase-transport-differences.selftest.ts 48/48 OK |
| MAIRA/A54945 | no referenciados; intactos |

## Archivos

- supabase/canonical/295_cod_transport_differences_schema.sql
- supabase/canonical/296_cod_transport_compensations_schema.sql
- supabase/canonical/297_rpc_cod_register_void_transport_adjustment.sql
- supabase/canonical/298_rpc_cod_compensate_transport_differences.sql
- supabase/canonical/299_cod_void_remittance_transport_adjustments.sql
- supabase/canonical/tests/cod_transport_differences_fixtures.sql
- nj/lib/reconciliation/phase-transport-differences.selftest.ts
- nj/lib/reconciliation/difference-queries.ts
- nj/lib/reconciliation/actions.ts (register/void/compensate)
- nj/components/admin-reconciliation/TransportDifferencesPanel.tsx
- nj/components/admin-reconciliation/RemittanceDetailView.tsx
- nj/app/admin/conciliacion-reembolso/irregularidades/page.tsx

**DETENER — sin apply.**
