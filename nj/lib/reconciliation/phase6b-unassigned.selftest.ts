/**
 * Fase 6B — selftest estático de 286 (sin tocar producción).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../../../supabase/canonical");

function load(name: string): string {
  return readFileSync(resolve(root, name), "utf8");
}

let ok = 0;
let fail = 0;

function assert(cond: boolean, label: string) {
  if (cond) {
    ok += 1;
    console.log(`  OK  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}`);
  }
}

console.log("\n=== phase6b-unassigned.selftest ===\n");

const sql286 = load("286_rpc_cod_assign_confirmed_unassigned.sql");
const sql279 = load("279_rpc_cod_approve_and_assign.sql");
const sql280 = load("280_rpc_cod_confirm_remittance.sql");

assert(/rpc_cod_assign_confirmed_unassigned_row/.test(sql286), "286: RPC específica");
assert(/SECURITY DEFINER/.test(sql286), "286: SECURITY DEFINER");
assert(/search_path TO 'public', 'pg_catalog'/.test(sql286), "286: search_path");
assert(/has_permission\(v_uid, 'conciliacion-reembolso', 'edit'\)/.test(sql286), "286: permiso edit");
assert(/REVOKE ALL[\s\S]*FROM anon/.test(sql286), "286: REVOKE anon");
assert(/GRANT EXECUTE[\s\S]*TO authenticated/.test(sql286), "286: GRANT authenticated");
assert(/GRANT EXECUTE[\s\S]*TO service_role/.test(sql286), "286: GRANT service_role");

assert(/v_rem\.status <> 'confirmed'/.test(sql286), "exige remittance confirmed");
assert(/row_status <> 'unassigned'/.test(sql286), "exige row unassigned");
assert(/row_missing_parsed_amount/.test(sql286), "parsed_amount obligatorio");
assert(/FOR UPDATE/.test(sql286) && /FROM public\.orders o/.test(sql286), "lock orders FOR UPDATE");
assert(/needs_force/.test(sql286), "warnings → needs_force");
assert(/p_force/.test(sql286), "soporta p_force");

assert(/confirmed_matched/.test(sql286), "1. exact → confirmed_matched");
assert(/confirmed_with_irregularity/.test(sql286), "2/3. diff → confirmed_with_irregularity");
assert(/INSERT INTO public\.cod_irregularities/.test(sql286), "crea irregularidad open");
assert(/amount_diff/.test(sql286) && /v_reported - v_expected/.test(sql286), "diff = reported - expected");
assert(/irregularity_created/.test(sql286), "12. evento irregularity_created");
assert(/manual_assignment/.test(sql286), "13. evento manual_assignment");
assert(/financial_effect/.test(sql286), "marca efecto financiero en evento");

assert(/row_not_unassigned/.test(sql286), "4. no unassigned → rechazo");
assert(/remittance_not_confirmed/.test(sql286), "5. no confirmed → rechazo");
assert(/order_confirmed_elsewhere/.test(sql286), "6. pedido ya conciliado → rechazo");
assert(/matched_order_not_in_cod_universe/.test(sql286), "7. fuera universo → rechazo");

assert(!/UPDATE\s+public\.orders/i.test(sql286), "15. no muta orders");
assert(!/status = 'analyzed'/.test(sql286), "no reabre a analyzed");
assert(/updated_at = now\(\) WHERE id = p_remittance_id/.test(sql286), "cabecera solo updated_at");
assert(/uq_cod_rows_matched_order_active|confirmed_matched', 'confirmed_with_irregularity/.test(sql286), "respeta confirmed_*");

// 279/280 intactos (no reescritos por 286)
assert(/rpc_cod_assign_row/.test(sql279), "279 intacta: assign_row existe");
assert(/remittance_not_analyzed/.test(sql279) || /status <> 'analyzed'/.test(sql279), "279 sigue exigiendo analyzed");
assert(/rpc_cod_confirm_remittance/.test(sql280), "280 intacta");
assert(!/rpc_cod_assign_confirmed_unassigned/.test(sql279), "279 no incluye 6B");
assert(!/rpc_cod_assign_confirmed_unassigned/.test(sql280), "280 no incluye 6B");

assert(/transport_mismatch/.test(sql286), "warning transporte");
assert(/date_far/.test(sql286), "warning fecha");
assert(/amount_diff/.test(sql286), "warning monto");
assert(/name_weak|name_unverified/.test(sql286), "warning nombre");

// KPI dashboard: misma definición que /sin-identificar (solo confirmed)
const unassignedQs = readFileSync(
  resolve(__dirname, "unassigned-queries.ts"),
  "utf8"
);
const dashboardQs = readFileSync(resolve(__dirname, "queries.ts"), "utf8");
assert(
  /countUnassignedConfirmedPayments/.test(unassignedQs) &&
    /\.eq\("cod_remittances\.status", "confirmed"\)/.test(unassignedQs),
  "KPI helper: solo remittances confirmed"
);
assert(
  /countUnassignedConfirmedPayments/.test(dashboardQs),
  "dashboard KPI reutiliza countUnassignedConfirmedPayments"
);
assert(
  !/\.eq\("row_status", "unassigned"\)\s*\.range\(/.test(
    dashboardQs.replace(/\s+/g, " ")
  ),
  "dashboard ya no cuenta unassigned sin filtrar remittance"
);

console.log(`\nResultado: ${ok} ok, ${fail} fail\n`);
console.log(`Runtime post-apply (fixture BEGIN/ROLLBACK):
  · exact / diff± / reject paths / force / concurrency / alias fail no-revert
`);

if (fail > 0) process.exit(1);
