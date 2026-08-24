-- cod_transport_differences_fixtures.sql
-- Fixtures lógicos V1 (diseño). Ejecutar solo en BEGIN/ROLLBACK tras apply 295–299.
-- NO tocar A54945/MAIRA reales. Este archivo documenta assertions esperadas.
--
-- Uso previsto (post-apply con aprobación):
--   BEGIN;
--   -- setup sintético transports/remittance/rows/irregs/adjustments
--   -- ejercicios 1–18
--   ROLLBACK;

/*
ASSERT MATRIX (implementación RPC)

1) claim remaining 20000 + credit 20000
   → compensate → both remaining 0; claim status resolved; adj compensated; net 0

2) claim 20000 + credit 15000
   → claim remaining 5000 status open/in_review; adj remaining 0 compensated

3) credit 75495 - compensate 16700
   → credit remaining 58795; status partially_compensated

4) multiple claims/credits FIFO by created_at

5) cross transport → cross_transport_not_allowed

6) concurrent compensate same sources → one wins (FOR UPDATE)

7) amount selection implying apply > remaining → claim_remaining_zero / credits_remaining_zero

8) register paid_other_method with order_id Pagado
   → adjustment created; orders.payment_method unchanged; no confirmed_matched

9) register foreign_client without order/customer
   → ok; raw_name_snapshot set

10) complementary path still separate (no auto adjustment)

11) complementary exact resolve → irreg status resolved → remaining 0 via trigger

12) void adjustment unused → ok; row back to unassigned

13) void adjustment after compensate → adjustment_has_compensations

14) void remittance with unused adjustment → auto void adj

15) void remittance with compensated adj → remittance_has_compensated_adjustments

16) amount_diff never changes on compensate

17) compensation_lines remaining_before/after correct

18) cod_v_transport_difference_balances net = claim_open - credit_open
*/

SELECT 'cod_transport_differences_fixtures: documentation-only placeholder'::text AS note;
