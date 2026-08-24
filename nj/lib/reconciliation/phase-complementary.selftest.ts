/**
 * Static selftest — COD complementary payments 292/293/294.
 * No conecta a Supabase ni ejecuta migraciones.
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

console.log("\n=== phase-complementary.selftest ===\n");

const sql292 = load("292_cod_complementary_payments_schema.sql");
const sql293 = load("293_rpc_cod_approve_complementary_payment.sql");
const sql294 = load("294_cod_complementary_payment_financial_flow.sql");

assert(/assignment_role text NOT NULL DEFAULT 'primary'/.test(sql292), "292 assignment_role default");
assert(/'primary', 'supplementary'/.test(sql292), "292 roles check");
assert(/DROP INDEX IF EXISTS public\.uq_cod_rows_matched_order_active/.test(sql292), "292 drops old unique");
assert(/uq_cod_rows_matched_order_primary/.test(sql292), "292 primary partial unique");
assert(/idx_cod_rows_matched_order_confirmed/.test(sql292), "292 confirmed lookup index");
assert(/complementary_payment_partial/.test(sql292), "292 superseded reason");
assert(/complementary_payment_approved/.test(sql292), "292 approved event");
assert(/complementary_payment_applied/.test(sql292), "292 applied event");
assert(/complementary_balance_reopened/.test(sql292), "292 reopened event");
assert(/remittance_edited/.test(sql292) && /alias_reassigned/.test(sql292), "292 preserves 289 events");
assert(/misma remesa es imposible/i.test(sql292), "292 documents V1 impossibility");

assert(/_cod_load_order_cod_balance/.test(sql293), "293 balance helper");
assert(/active_reported_total numeric\(12,2\)/.test(sql293), "293 helper return contract");
assert(/rr\.row_status IN \('confirmed_matched', 'confirmed_with_irregularity'\)/.test(sql293), "293 only confirmed payments");
assert(/r\.status <> 'voided'/.test(sql293), "293 excludes voided");
assert(/sheet_revision/.test(sql293), "293 revision-aware balance");
assert(/REVOKE ALL ON FUNCTION public\._cod_load_order_cod_balance\(uuid\) FROM authenticated/.test(sql293), "293 helper internal");
assert(/rpc_cod_approve_complementary_payment/.test(sql293), "293 approve RPC");
assert(/remaining_balance_not_positive/.test(sql293), "293 positive balance guard");
assert(/no_primary_confirmed/.test(sql293), "293 requires primary");
assert(/active_shortage_irregularity_not_found/.test(sql293), "293 requires shortage");
assert(/multiple_active_shortage_irregularities/.test(sql293), "293 rejects duplicate shortage");
assert(/shortage_balance_mismatch/.test(sql293), "293 verifies shortage balance");
assert(/payment_exceeds_remaining_balance/.test(sql293), "293 rejects excess");
assert(/assignment_role = 'supplementary'/.test(sql293), "293 writes supplementary");
assert(/expected_amount_snapshot = v_bal\.remaining_balance/.test(sql293), "293 snapshots live balance");
assert(/financial_effect', 'none_until_confirm'/.test(sql293), "293 no financial effect");
assert(/transport_mismatch = v_transport_mismatch/.test(sql293), "293 allows transport warning");

assert(/rpc_cod_confirm_remittance/.test(sql294), "294 replaces confirm");
assert(/CASE COALESCE\(assignment_role, 'primary'\)[\s\S]*WHEN 'primary' THEN 0/.test(sql294), "294 primary-first ordering");
assert(/= 'supplementary' THEN/.test(sql294), "294 supplementary confirm branch");
assert(/order_confirmed_elsewhere/.test(sql294), "294 primary keeps duplicate guard");
assert(/complementary_balance_changed_since_approval/.test(sql294), "294 stale balance rejection");
assert(/complementary_payment_partial/.test(sql294), "294 partial supersede");
assert(/complementary_payment_applied/.test(sql294), "294 applied event");
assert(/irregularity_resolved/.test(sql294), "294 resolves exact shortage");
assert(/irregularity_created/.test(sql294), "294 creates partial shortage");
assert(/complementary_row_not_correctable/.test(sql294), "294/287 rejects supplementary correction");
assert(/order_has_supplementary_payments/.test(sql294), "294/287 protects primary history");
assert(/row_not_in_current_sheet_revision/.test(sql294), "294/287 revision-aware");
assert(/primary_has_active_supplementary_payments/.test(sql294), "294/288 protects primary void");
assert(/complementary_balance_reopened/.test(sql294), "294/288 reopened event");
assert(/historical_resolved_irregularities_reopened', false/.test(sql294), "294/288 preserves resolved history");
assert(/primary_row_id/.test(sql294), "294/288 anchors reopened shortage to primary");
assert(/misma remesa[\s\S]*imposible/i.test(sql294), "294 documents same-remittance V1 rule");
assert(!/\bA54946\b/.test(sql292 + sql293 + sql294), "migrations never reference real order");

console.log(`\n=== resultado: ${ok} ok, ${fail} fail ===\n`);
if (fail > 0) process.exit(1);
