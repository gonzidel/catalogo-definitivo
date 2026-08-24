/**
 * Static selftest — COD transport differences 295–299.
 * No conecta a Supabase ni aplica migraciones.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const canonical = resolve(__dirname, "../../../supabase/canonical");

function load(name: string): string {
  return readFileSync(resolve(canonical, name), "utf8");
}

let ok = 0;
let fail = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    ok += 1;
    console.log(`  OK  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}`);
  }
}

console.log("\n=== phase-transport-differences.selftest ===\n");

const sql295 = load("295_cod_transport_differences_schema.sql");
const sql296 = load("296_cod_transport_compensations_schema.sql");
const sql297 = load("297_rpc_cod_register_void_transport_adjustment.sql");
const sql298 = load("298_rpc_cod_compensate_transport_differences.sql");
const sql299 = load("299_cod_void_remittance_transport_adjustments.sql");
const sql294 = load("294_cod_complementary_payment_financial_flow.sql");

assert(/remaining_amount numeric\(12,2\)/.test(sql295), "295 remaining_amount column");
assert(/cod_irregularities_resolved_remaining_zero/.test(sql295), "295 resolved⇒remaining 0 check");
assert(/_cod_irregularity_remaining_sync/.test(sql295), "295 remaining sync trigger");
assert(/classified_adjustment/.test(sql295), "295 row_status classified_adjustment");
assert(/cod_transport_adjustments/.test(sql295), "295 adjustments table");
assert(/transport_credit/.test(sql295) && /transport_debt/.test(sql295), "295 direction enum future-ready");
assert(/uq_cod_transport_adjustments_row_active/.test(sql295), "295 one active adj per row");
assert(/paid_other_method/.test(sql295), "295 kind paid_other_method");
assert(/NO se duplican en cod_transport_adjustments/.test(sql295), "295 sobrantes COD no duplicar");
assert(/No se modifica 294 aquí/.test(sql295), "295 does not rewrite 294 file");

assert(/cod_transport_compensations/.test(sql296), "296 compensations table");
assert(/cod_transport_compensation_lines/.test(sql296), "296 lines table");
assert(/irregularity_compensated/.test(sql296), "296 irregularity_compensated event");
assert(/transport_adjustment_registered/.test(sql296), "296 adjustment registered event");
assert(/transport_compensation_applied/.test(sql296), "296 compensation applied event");
assert(/cod_v_transport_difference_balances/.test(sql296), "296 balance view");
assert(/claim_open/.test(sql296) && /credit_open/.test(sql296) && /net_balance/.test(sql296), "296 balance metrics");
assert(/complementary_balance_reopened/.test(sql296), "296 preserves 292 events");

assert(/rpc_cod_register_transport_adjustment/.test(sql297), "297 register RPC");
assert(/'transport_credit'/.test(sql297), "297 forces transport_credit");
assert(/parsed_amount/.test(sql297), "297 amount from DB parsed_amount");
assert(/row_already_confirmed_cod/.test(sql297), "297 rejects confirmed COD");
assert(/row_is_supplementary/.test(sql297), "297 rejects supplementary");
assert(/adjustment_already_active_for_row/.test(sql297), "297 rejects duplicate adj");
assert(/classified_adjustment/.test(sql297), "297 sets classified_adjustment");
assert(/order_untouched/.test(sql297), "297 does not mutate order");
assert(/rpc_cod_void_transport_adjustment/.test(sql297), "297 void adj RPC");
assert(/adjustment_has_compensations/.test(sql297), "297 rejects void if used");
assert(/REVOKE ALL ON FUNCTION public\.rpc_cod_register_transport_adjustment/.test(sql297), "297 revoke register");
assert(/FROM anon/.test(sql297), "297 revoke anon");

assert(/rpc_cod_compensate_transport_differences/.test(sql298), "298 compensate RPC");
assert(/LEAST\(v_claim_total, v_credit_total\)/.test(sql298), "298 auto min apply");
assert(/ORDER BY i\.created_at ASC/.test(sql298), "298 FIFO claims");
assert(/cross_transport_not_allowed/.test(sql298), "298 cross transport reject");
assert(/Compensado con crédito del transporte/.test(sql298), "298 resolve note");
assert(/irregularity_compensated/.test(sql298), "298 compensated event");
assert(/partially_compensated/.test(sql298), "298 partial credit status");
assert(/rpc_cod_list_transport_differences/.test(sql298), "298 list RPC");
assert(/cod_surplus/.test(sql298), "298 includes surplus irreg as credit");

assert(/remittance_has_compensated_adjustments/.test(sql299), "299 blocks void remesa if adj used");
assert(/transport_adjustments_voided/.test(sql299), "299 auto-voids unused adj");
assert(/_cod_291_void_confirmed_remittance/.test(sql299), "299 still calls 291 body");
assert(/remaining irreg coherente vía trigger 295/.test(sql299), "299 documents trigger vs 294");
assert(/rpc_cod_void_confirmed_remittance/.test(sql299), "299 replaces void RPC");

// 294 histórico intacto en su archivo
assert(/Saldo completado por pago complementario/.test(sql294), "294 file still has complementary resolve");
assert(!/remaining_amount/.test(sql294), "294 historical file untouched (no remaining_amount)");
assert(!/\bA54945\b/.test(sql295 + sql296 + sql297 + sql298 + sql299), "migrations never reference A54945");
assert(!/\bMAIRA\b/i.test(sql295 + sql296 + sql297 + sql298 + sql299), "migrations never reference MAIRA");

console.log(`\n=== resultado: ${ok} ok, ${fail} fail ===\n`);
if (fail > 0) process.exit(1);
