/**
 * Fase 6D — selftest estático de 288 (sin tocar producción).
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

console.log("\n=== phase6d-void.selftest ===\n");

const sql288 = load("288_rpc_cod_void_confirmed_remittance.sql");
const sql272 = load("272_cod_reconciliation_schema.sql");
const sql287 = load("287_rpc_cod_correct_confirmed_assignment.sql");
const sql286 = load("286_rpc_cod_assign_confirmed_unassigned.sql");
const sql279 = load("279_rpc_cod_approve_and_assign.sql");
const sql280 = load("280_rpc_cod_confirm_remittance.sql");
const actions = loadLib("actions.ts");
const unassignedQs = loadLib("unassigned-queries.ts");
const detailUi = readFileSync(
  resolve(lib, "../../components/admin-reconciliation/RemittanceDetailView.tsx"),
  "utf8"
);

// Schema already has void/voided/event (no duplicate migration needed)
assert(/'void'/.test(sql272) && /'voided'/.test(sql272), "272: row void + remittance voided");
assert(/voided_by/.test(sql272) && /void_reason/.test(sql272), "272: voided_by/at/reason");
assert(/remittance_voided/.test(sql272), "272: event remittance_voided");
assert(/superseded_reason[\s\S]*remittance_voided/.test(sql272), "272: superseded remittance_voided");
assert(
  /uq_cod_rows_matched_order_active[\s\S]*confirmed_matched[\s\S]*confirmed_with_irregularity/.test(
    sql272
  ),
  "272: unique solo confirmed_* (void fuera)"
);

assert(/rpc_cod_void_confirmed_remittance/.test(sql288), "288: RPC");
assert(/SECURITY DEFINER/.test(sql288), "288: SECURITY DEFINER");
assert(/search_path TO 'public', 'pg_catalog'/.test(sql288), "288: search_path");
assert(/has_permission\(v_uid, 'conciliacion-reembolso', 'edit'\)/.test(sql288), "288: permiso edit");
assert(/REVOKE ALL[\s\S]*FROM anon/.test(sql288), "288: REVOKE anon");
assert(/GRANT EXECUTE[\s\S]*TO authenticated/.test(sql288), "288: GRANT authenticated");
assert(/reason_required/.test(sql288), "motivo obligatorio");
assert(/remittance_not_confirmed/.test(sql288), "solo confirmed");
assert(/remittance_already_voided/.test(sql288), "ya voided → rechazo");

assert(/FOR UPDATE/.test(sql288), "locks FOR UPDATE");
assert(
  /unnest\(v_order_ids\)[\s\S]{0,60}ORDER BY 1/.test(sql288),
  "orders lock UUID ASC"
);
assert(/ORDER BY id[\s\S]{0,40}FOR UPDATE/.test(sql288), "rows lock ORDER BY id");

// Hardening 6D
assert(
  /remittance_has_unexpected_row_states/.test(sql288) &&
    /v_cnt_other > 0/.test(sql288),
  "hardening: other row states → rechazo"
);
assert(
  /confirmed_row_missing_order/.test(sql288) &&
    /matched_order_id IS NULL/.test(sql288),
  "hardening: confirmed_* sin order → rechazo"
);
assert(
  /matched_order_missing/.test(sql288) &&
    /IF NOT FOUND/.test(sql288) &&
    /FROM public\.orders[\s\S]{0,80}FOR UPDATE/.test(sql288),
  "hardening: order lock exige FOUND"
);
assert(
  /row_void_count_mismatch/.test(sql288) &&
    /v_rows_voided <> v_expected_voided/.test(sql288) &&
    /v_expected_voided := v_cnt_exact \+ v_cnt_irreg/.test(sql288),
  "hardening: rows_voided = exact + irreg"
);
assert(
  /row_status NOT IN \('confirmed_matched', 'confirmed_with_irregularity'\)/.test(
    sql288
  ) && !/NOT IN \('confirmed_matched', 'confirmed_with_irregularity', 'void'\)/.test(sql288),
  "hardening: revalidación post-lock no acepta void"
);

assert(/row_status = 'void'/.test(sql288), "filas confirmed_* → void");
assert(!/matched_order_id\s*=\s*NULL/.test(sql288), "no limpia matched_order_id");
assert(!/expected_amount_snapshot\s*=\s*NULL/.test(sql288), "no limpia snapshots");
assert(/status = 'voided'/.test(sql288), "cabecera → voided");
assert(/voided_by = v_uid/.test(sql288) && /void_reason = v_reason/.test(sql288), "actor/fecha/reason server-side");

assert(/status IN \('open', 'in_review'\)/.test(sql288), "supersede solo activas");
assert(/superseded_reason = 'remittance_voided'/.test(sql288), "superseded_reason remittance_voided");
assert(/resolved_kept_intact/.test(sql288), "resolved intactas documentadas");
assert(
  !/UPDATE public\.cod_irregularities SET[\s\S]*status = 'superseded'[\s\S]*status = 'resolved'/.test(
    sql288
  ) &&
    /AND status IN \('open', 'in_review'\)/.test(sql288),
  "supersede solo open/in_review (resolved no)"
);

assert(/remittance_voided/.test(sql288), "evento remittance_voided");
assert(/phase', '6d'/.test(sql288), "phase 6d");
assert(/orders_returned_to_pending/.test(sql288), "KPI orders liberados en new_state");
assert(!/UPDATE\s+public\.orders/i.test(sql288), "no muta orders");
assert(!/cod_transport_customer_aliases/.test(sql288), "no toca aliases");
assert(!/DELETE\s+FROM/i.test(sql288), "no DELETE");

assert(!/rpc_cod_void_confirmed_remittance/.test(sql279), "279 intacta");
assert(!/rpc_cod_void_confirmed_remittance/.test(sql280), "280 intacta");
assert(!/rpc_cod_void_confirmed_remittance/.test(sql286), "286 intacta");
assert(!/rpc_cod_void_confirmed_remittance/.test(sql287), "287 intacta");

assert(/voidConfirmedRemittance/.test(actions), "action voidConfirmedRemittance");
assert(/rpc_cod_void_confirmed_remittance/.test(actions), "action llama RPC 288");
assert(
  /\.eq\("cod_remittances\.status", "confirmed"\)/.test(unassignedQs),
  "KPI sin identificar exige remittance confirmed"
);
assert(/Anular rendición/.test(detailUi), "UI: Anular rendición");
assert(/Escribí ANULAR/.test(detailUi), "UI: confirmación explícita ANULAR");
assert(/voidConfirmedRemittance/.test(detailUi), "UI llama action");
assert(/Rendición anulada/.test(detailUi), "UI: banner voided");

assert(
  /remittance_has_unexpected_row_states/.test(actions),
  "action mapea unexpected_row_states"
);
assert(/confirmed_row_missing_order/.test(actions), "action mapea missing_order en fila");
assert(/matched_order_missing/.test(actions), "action mapea order inexistente");
assert(/row_void_count_mismatch/.test(actions), "action mapea void count mismatch");

console.log(`\nResultado: ${ok} ok, ${fail} fail\n`);
console.log(`Runtime post-apply (fixture BEGIN/ROLLBACK) pendiente de autorización:
  · void 3 exactas / irreg open|in_review → superseded / resolved intacta
  · unassigned sale KPI / corrected A→B libera B
  · rejects / concurrencia / KPIs / orders+aliases intactos
  · remittance_has_unexpected_row_states (v_cnt_other>0)
  · confirmed_row_missing_order (confirmed_* sin matched_order_id)
  · matched_order_missing (order no FOUND al FOR UPDATE)
  · row_void_count_mismatch (rows_voided ≠ exact+irreg) / revalidación no acepta void
`);

if (fail > 0) process.exit(1);
