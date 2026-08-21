/**
 * Auditoría estática 279 + 280 (Fase 5). Sin aplicar en prod.
 * Desde nj/: npx --yes tsx lib/reconciliation/phase5-rpc.selftest.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string) {
  if (cond) {
    passed += 1;
    console.log(`  OK  ${msg}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${msg}`);
  }
}

function load(name: string) {
  return readFileSync(resolve(process.cwd(), "..", "supabase", "canonical", name), "utf8");
}

const sql279 = load("279_rpc_cod_approve_and_assign.sql");
const sql280 = load("280_rpc_cod_confirm_remittance.sql");

console.log("\n=== phase5-rpc.selftest ===\n");

// 279
assert(/rpc_cod_approve_auto_matched/.test(sql279), "279: approve auto");
assert(/rpc_cod_assign_row/.test(sql279), "279: assign row");
assert(/rpc_cod_mark_row_unassigned/.test(sql279), "279: mark unassigned");
assert(/approved_pending_confirmation/.test(sql279), "279: status approved_pending");
assert(/_cod_load_order_financial_snapshots/.test(sql279), "279: snapshots desde DB");
assert(/needs_force/.test(sql279), "279: needs_force warnings");
assert(/candidate_approved/.test(sql279), "279: evento candidate_approved");
assert(/manual_assignment/.test(sql279), "279: evento manual_assignment");
assert(!/INSERT INTO public\.cod_irregularities/i.test(sql279), "279: no crea irregularidades");
assert(!/UPDATE public\.orders/i.test(sql279), "279: no muta orders");
assert(/SECURITY DEFINER/i.test(sql279), "279: SECURITY DEFINER");
assert(/REVOKE ALL[\s\S]*FROM anon/i.test(sql279), "279: REVOKE anon");
assert(/has_permission\(v_uid,\s*'conciliacion-reembolso',\s*'edit'\)/.test(sql279), "279: edit");

assert(/row_missing_parsed_amount/.test(sql279), "279: hard fail sin parsed_amount");
assert(
  (sql279.match(/row_missing_parsed_amount/g) || []).length >= 2,
  "279: parsed_amount en approve + assign"
);
assert(/remittance_not_analyzed/.test(sql279), "279: exige analyzed");
assert(
  (sql279.match(/remittance_not_analyzed/g) || []).length >= 3,
  "279: analyzed en las 3 RPCs"
);
assert(!/draft',\s*'analyzed'/.test(sql279) && !/NOT IN \('draft'/.test(sql279), "279: no permite draft");
assert(!/SET status = 'analyzed'/.test(sql279), "279: no transición draft→analyzed");
assert(!/amount_missing/.test(sql279), "279: missing amount no es warning forceable");

// 280
assert(/rpc_cod_confirm_remittance/.test(sql280), "280: confirm function");
assert(/status = 'analyzed'/.test(sql280) || /v_rem\.status <> 'analyzed'/.test(sql280), "280: solo analyzed");
assert(/approved_pending_confirmation/.test(sql280) && /unassigned/.test(sql280), "280: filas listas");
assert(/rows_not_ready_for_confirm/.test(sql280), "280: rechaza filas sin decisión");
assert(/order_amount_changed_since_approval/.test(sql280), "280: monto cambiado falla");
assert(/order_confirmed_elsewhere/.test(sql280), "280: carrera otra rendición");
assert(/FOR UPDATE/.test(sql280), "280: usa FOR UPDATE");
assert(
  /WHERE o\.id = v_row\.matched_order_id\s+FOR UPDATE/s.test(sql280),
  "280: lock orders antes de validar"
);
assert(/matched_order_not_in_cod_universe/.test(sql280), "280: valida universo post-lock");
assert(/confirmed_matched/.test(sql280) && /confirmed_with_irregularity/.test(sql280), "280: estados finales");
assert(/INSERT INTO public\.cod_irregularities/i.test(sql280), "280: crea irregularidades");
assert(/irregularity_created/.test(sql280), "280: evento irregularity");
assert(/remittance_confirmed/.test(sql280), "280: evento confirmed");
assert(/confirmed_by = v_uid/.test(sql280), "280: confirmed_by = auth");
assert(!/UPDATE public\.orders/i.test(sql280), "280: no muta orders");
assert(/SECURITY DEFINER/i.test(sql280), "280: SECURITY DEFINER");
assert(/REVOKE ALL[\s\S]*FROM anon/i.test(sql280), "280: REVOKE anon");
assert(/remittance_already_confirmed/.test(sql280), "280: no re-confirma");
assert(/remittance_voided/.test(sql280), "280: no confirma voided");
assert(/amount_diff = reported_amount - expected_amount|v_diff := round\(\(v_reported - v_expected\)/.test(sql280), "280: amount_diff = reported - expected");

console.log(`\nCasos documentados (runtime post-apply):`);
console.log("  · auto→approved no baja pendiente / no irregularidad");
console.log("  · confirm exacto / +/- diff / unassigned");
console.log("  · fila sin decisión → fail total");
console.log("  · carrera confirmed_elsewhere → rollback 70 filas");
console.log("  · total_amount cambió → fail");
console.log("  · concurrente: FOR UPDATE orders → una gana, otra order_confirmed_elsewhere");
console.log("  · parsed_amount NULL → row_missing_parsed_amount (p_force no salta)");
console.log("  · draft → remittance_not_analyzed");

console.log(`\nResultado: ${passed} ok, ${failed} fail\n`);
if (failed > 0) process.exit(1);
