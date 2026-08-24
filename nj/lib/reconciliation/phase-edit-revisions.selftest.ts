/**
 * Selftest — editar planilla por REVISIONES + plan deploy.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { rowsToPasteText } from "./paste-rebuild";

const root = resolve(__dirname, "../../../supabase/canonical");
const lib = __dirname;

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

console.log("\n=== phase-edit-revisions.selftest ===\n");

const sql289 = load("289_cod_remittance_sheet_revisions_schema.sql");
const sql290 = load("290_rpc_cod_replace_unconfirmed_remittance_sheet.sql");
const sql291 = load("291_cod_reconciliation_revision_aware_rpcs.sql");
const sql278 = load("278_rpc_cod_save_analysis.sql");
const sql279 = load("279_rpc_cod_approve_and_assign.sql");
const sql280 = load("280_rpc_cod_confirm_remittance.sql");
const sql286 = load("286_rpc_cod_assign_confirmed_unassigned.sql");

assert(/sheet_revision/.test(sql289), "1. schema sheet_revision");
assert(/sheet_edited_by/.test(sql289), "2. sheet_edited_*");
assert(/remittance_edited/.test(sql289), "3. event remittance_edited");
assert(/UNIQUE \(remittance_id, sheet_revision, row_index\)/.test(sql289), "4. UNIQUE compuesto");
assert(/cod_remittance_rows_current/.test(sql289), "5. vista current");
assert(!/corrected_amount_text/.test(sql289), "6. sin corrected_*");

assert(/rpc_cod_replace_unconfirmed_remittance_sheet/.test(sql290), "7. RPC replace");
assert(!/DELETE FROM public\.cod_remittance_rows/.test(sql290), "8. NO DELETE");
assert(!/remittance_row_id\s*=\s*NULL/.test(sql290), "9. NO null events");
assert(/v_new_revision := v_old_revision \+ 1/.test(sql290), "10. incrementa revision");

assert(!/sheet_revision/.test(sql278), "11. 278 histórico inmutable");
assert(!/sheet_revision/.test(sql279), "12. 279 histórico inmutable");
assert(!/sheet_revision/.test(sql280), "13. 280 histórico inmutable");
assert(!/sheet_revision/.test(sql286), "14. 286 histórico inmutable");

assert(/rpc_cod_save_analysis/.test(sql291) && /sheet_revision/.test(sql291), "15. 291 parchea 278");
assert(/rpc_cod_approve_auto_matched/.test(sql291), "16. 291 parchea 279 approve");
assert(/rpc_cod_assign_row/.test(sql291), "17. 291 parchea 279 assign");
assert(/rpc_cod_mark_row_unassigned/.test(sql291), "18. 291 parchea 279 unassigned");
assert(/rpc_cod_confirm_remittance/.test(sql291), "19. 291 parchea 280");
assert(/rpc_cod_assign_confirmed_unassigned_row/.test(sql291), "20. 291 parchea 286");
assert(/rpc_cod_correct_confirmed_assignment/.test(sql291), "21. 291 parchea 287");
assert(/rpc_cod_void_confirmed_remittance/.test(sql291), "22. 291 parchea 288");
assert(/row_not_in_current_sheet_revision/.test(sql291), "23. rechazo histórico");

assert(/replaceUnconfirmedRemittanceSheet/.test(loadLib("actions.ts")), "24. action");
assert(/getCodRemittanceRowsForRevision/.test(loadLib("remittance-queries.ts")), "25. queries");
assert(
  /mode\?: "create" \| "edit"/.test(
    readFileSync(resolve(lib, "../../components/admin-reconciliation/NewRemittanceWizard.tsx"), "utf8")
  ),
  "26. wizard dual"
);
assert(!existsSync(resolve(lib, "sheet-shift.ts")), "27. sin sheet-shift");

const paste = rowsToPasteText([
  { rawLine: "17/07/2026\tJUAN\t200", rawTransportDateText: "a", rawCustomerNameText: "b", rawAmountText: "c" },
]);
assert(paste.includes("JUAN"), "28. rebuild paste");

assert(/289 → 290 → 291/.test(sql289) && /289 → 290 → 291/.test(sql290), "29. secuencia apply");
assert(/HISTÓRICAS|inmutables/i.test(sql291), "30. 291 no reaplicar históricos");

assert(
  (sql291.match(/CREATE OR REPLACE FUNCTION public\.rpc_cod_save_analysis\s*\(/g) || []).length ===
    1,
  "31. una sola def rpc_cod_save_analysis"
);
assert(
  !/COMMENT ON FUNCTION public\._cod_normalize_match_name\(text\) IS[\s\S]{0,80}\)\s*THEN/.test(
    sql291
  ),
  "32. sin fragmento huérfano save_analysis"
);
assert(/row_index_gap/.test(sql290) && /row_index_negative/.test(sql290), "33. 290 row_index 0..N-1");
assert(
  /REVOKE ALL ON FUNCTION public\._cod_remittance_current_revision\(uuid\) FROM authenticated/.test(
    sql291
  ),
  "34. helper interno sin EXECUTE authenticated"
);

console.log(`\n=== resultado: ${ok} ok, ${fail} fail ===\n`);
if (fail > 0) process.exit(1);

function loadLib(name: string): string {
  return readFileSync(resolve(lib, name), "utf8");
}
