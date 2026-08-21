/**
 * Fase 6C — selftest estático de 287 (sin tocar producción).
 * Incluye hardening: relectura post-lock + UPDATE defensivo FOUND.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../../../supabase/canonical");
const lib = __dirname;

function load(name: string): string {
  return readFileSync(resolve(root, name), "utf8");
}

function loadLib(name: string): string {
  return readFileSync(resolve(lib, name), "utf8");
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

console.log("\n=== phase6c-correct.selftest ===\n");

const sql287 = load("287_rpc_cod_correct_confirmed_assignment.sql");
const sql286 = load("286_rpc_cod_assign_confirmed_unassigned.sql");
const sql279 = load("279_rpc_cod_approve_and_assign.sql");
const sql280 = load("280_rpc_cod_confirm_remittance.sql");
const actions = loadLib("actions.ts");
const detailUi = readFileSync(
  resolve(lib, "../../components/admin-reconciliation/RemittanceDetailView.tsx"),
  "utf8"
);

assert(/rpc_cod_correct_confirmed_assignment/.test(sql287), "287: RPC específica");
assert(/SECURITY DEFINER/.test(sql287), "287: SECURITY DEFINER");
assert(/search_path TO 'public', 'pg_catalog'/.test(sql287), "287: search_path");
assert(/has_permission\(v_uid, 'conciliacion-reembolso', 'edit'\)/.test(sql287), "287: permiso edit");
assert(/REVOKE ALL[\s\S]*FROM anon/.test(sql287), "287: REVOKE anon");
assert(/GRANT EXECUTE[\s\S]*TO authenticated/.test(sql287), "287: GRANT authenticated");
assert(/GRANT EXECUTE[\s\S]*TO service_role/.test(sql287), "287: GRANT service_role");

assert(/reason_required/.test(sql287), "motivo obligatorio");
assert(/v_rem\.status <> 'confirmed'/.test(sql287), "exige remittance confirmed");
assert(/confirmed_matched', 'confirmed_with_irregularity'/.test(sql287), "exige row confirmed_*");
assert(/same_order/.test(sql287), "same_order reject");

assert(
  /unnest\(ARRAY\[v_old_order_id, p_new_order_id\]\)[\s\S]{0,80}ORDER BY 1/.test(sql287),
  "locks A+B orden UUID asc"
);
assert(/FOR UPDATE/.test(sql287), "FOR UPDATE presente");

// Hardening: relectura real post-lock
assert(
  (sql287.match(/SELECT \* INTO v_row\s+FROM public\.cod_remittance_rows/g) || []).length >= 2,
  "relectura real: dos SELECT INTO v_row (inicial + post-lock)"
);
assert(
  /END LOOP;[\s\S]{0,80}-- Releer fila post-lock[\s\S]{0,200}SELECT \* INTO v_row[\s\S]{0,200}FOR UPDATE[\s\S]{0,200}row_assignment_changed_concurrently/.test(
    sql287
  ),
  "relectura post-lock + revalidación matched/status"
);

assert(/order_confirmed_elsewhere/.test(sql287), "B ya conciliado → rechazo");

assert(/status IN \('open', 'in_review'\)/.test(sql287), "open|in_review elegibles supersede");
assert(/superseded_reason = 'assignment_corrected'/.test(sql287), "open/in_review → superseded");
assert(/resolved_kept_intact/.test(sql287), "resolved permanece resolved (auditada)");
assert(
  /AND status = 'resolved'/.test(sql287) && !/UPDATE[\s\S]{0,200}status = 'resolved'[\s\S]{0,80}superseded/.test(sql287),
  "resolved no se reescribe a superseded"
);

assert(/confirmed_matched/.test(sql287) && /confirmed_with_irregularity/.test(sql287), "ramas exact/irreg");
assert(/v_expected_new := v_live_amount/.test(sql287), "expected_new desde orders.total_amount live");
assert(/v_reported - v_expected_new/.test(sql287), "diff = reported - expected_new");
assert(
  /_cod_load_order_financial_snapshots\(p_new_order_id\)/.test(sql287) &&
    /order_number_snapshot = v_snap\.order_number/.test(sql287) &&
    /expected_amount_snapshot = v_expected_new/.test(sql287),
  "snapshots nuevos exclusivamente desde DB"
);

assert(
  /previous_state[\s\S]{0,40}v_prev_state[\s\S]{0,200}'old_order_id'/.test(sql287) ||
    /'old_order_id', v_old_order_id/.test(sql287),
  "assignment_corrected.previous_state conserva A"
);
assert(
  /'new_order_id', p_new_order_id/.test(sql287) && /'new_expected_amount', v_expected_new/.test(sql287),
  "new_state conserva B"
);
assert(/assignment_corrected/.test(sql287), "evento assignment_corrected");
assert(/irregularity_created/.test(sql287), "evento irregularity_created si diff");
assert(/INSERT INTO public\.cod_irregularities/.test(sql287), "crea irreg si A/B diff");

// Hardening: UPDATE defensivo
assert(/row_update_failed_concurrently/.test(sql287), "UPDATE defensivo FOUND → excepción");
assert(
  (sql287.match(/RAISE EXCEPTION 'row_update_failed_concurrently'/g) || []).length >= 2,
  "FOUND check en rama exacta e irregular"
);
assert(
  /matched_order_id = v_old_order_id[\s\S]{0,120}row_status IN \('confirmed_matched', 'confirmed_with_irregularity'\)/.test(
    sql287
  ),
  "UPDATE WHERE defensivo (old match + confirmed_*)"
);

assert(/RAISE EXCEPTION/.test(sql287), "fallo → EXCEPTION → rollback total de la TX");
assert(/updated_at = now\(\) WHERE id = p_remittance_id/.test(sql287), "cabecera solo updated_at");
assert(!/status = 'analyzed'/.test(sql287), "cabecera permanece confirmed (no reabre)");
assert(!/UPDATE\s+public\.orders/i.test(sql287), "orders nunca se modifican");

assert(/phase', '6c'/.test(sql287), "marca phase 6c");
assert(/needs_force/.test(sql287), "warnings → needs_force");
assert(/transport_mismatch/.test(sql287), "warning transporte");
assert(/date_far/.test(sql287), "warning fecha");
assert(/amount_diff/.test(sql287), "warning monto");
assert(/name_weak|name_unverified/.test(sql287), "warning nombre");
assert(/matched_order_not_in_cod_universe/.test(sql287), "universo hard no forceable");
assert(/row_not_confirmed_assignment/.test(sql287), "row no confirmed → rechazo");
assert(/remittance_not_confirmed/.test(sql287), "rem no confirmed → rechazo");
assert(/corrected_by = v_uid/.test(sql287), "marca corrected_by/at");

assert(!/rpc_cod_correct_confirmed_assignment/.test(sql286), "286 no incluye 6C");
assert(!/rpc_cod_correct_confirmed_assignment/.test(sql279), "279 no incluye 6C");
assert(!/rpc_cod_correct_confirmed_assignment/.test(sql280), "280 no incluye 6C");

assert(/correctConfirmedAssignment/.test(actions), "action correctConfirmedAssignment");
assert(/rpc_cod_correct_confirmed_assignment/.test(actions), "action llama RPC 287");
assert(
  /Asignación corregida, pero no se pudo guardar el alias/.test(actions),
  "alias fail no revierte"
);
assert(
  /confirmed_matched[\s\S]{0,120}confirmed_with_irregularity/.test(actions),
  "searchManual permite confirmed_* en rem confirmed"
);
assert(/Corregir asignación/.test(detailUi), "UI: Corregir asignación");
assert(/Corregir pago asignado/.test(detailUi), "UI: modal título");
assert(/Motivo de corrección/.test(detailUi), "UI: motivo obligatorio");
assert(/correctConfirmedAssignment/.test(detailUi), "UI llama action");

console.log(`\nResultado: ${ok} ok, ${fail} fail\n`);
console.log(`Runtime post-apply (fixture BEGIN/ROLLBACK) pendiente de autorización:
  · relectura post-lock / same_order / B ya conciliado
  · open|in_review → superseded; resolved intacta
  · A exact↔B exact/irreg; snapshots DB; events previous/new
  · fallo = rollback; cabecera confirmed; orders intactos
`);

if (fail > 0) process.exit(1);
