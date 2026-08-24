/**
 * Selftest — plan de despliegue revisiones (289/290/291).
 * 278–288 históricas inmutables; 291 contiene CREATE OR REPLACE.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

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

console.log("\n=== phase-edit-deploy-plan.selftest ===\n");

assert(
  existsSync(resolve(root, "289_cod_remittance_sheet_revisions_schema.sql")),
  "1. 289 revisions schema filename"
);
assert(
  !existsSync(resolve(root, "289_cod_remittance_sheet_edit_schema.sql")),
  "2. sin 289 edit_schema legacy"
);
assert(
  existsSync(resolve(root, "291_cod_reconciliation_revision_aware_rpcs.sql")),
  "3. 291 revision-aware rpcs"
);
assert(
  !existsSync(resolve(root, "291_cod_remittance_revision_operational_filters.sql")),
  "4. sin 291 thin legacy"
);

const sql289 = load("289_cod_remittance_sheet_revisions_schema.sql");
const sql290 = load("290_rpc_cod_replace_unconfirmed_remittance_sheet.sql");
const sql291 = load("291_cod_reconciliation_revision_aware_rpcs.sql");
const sql278 = load("278_rpc_cod_save_analysis.sql");
const sql279 = load("279_rpc_cod_approve_and_assign.sql");
const sql280 = load("280_rpc_cod_confirm_remittance.sql");
const sql286 = load("286_rpc_cod_assign_confirmed_unassigned.sql");
const sql287 = load("287_rpc_cod_correct_confirmed_assignment.sql");
const sql288 = load("288_rpc_cod_void_confirmed_remittance.sql");
const sql276 = load("276_rpc_cod_create_remittance_security_fix.sql");

// Históricas inmutables (sin sheet_revision)
assert(!/sheet_revision/.test(sql278), "5. 278 histórico sin sheet_revision");
assert(!/sheet_revision/.test(sql279), "6. 279 histórico sin sheet_revision");
assert(!/sheet_revision/.test(sql280), "7. 280 histórico sin sheet_revision");
assert(!/sheet_revision/.test(sql286), "8. 286 histórico sin sheet_revision");
assert(!/sheet_revision/.test(sql287), "9. 287 histórico sin sheet_revision");
assert(!/sheet_revision/.test(sql288), "10. 288 histórico sin sheet_revision");

// 289
assert(/sheet_revision integer NOT NULL DEFAULT 1/.test(sql289), "11. DEFAULT revision=1");
assert(/UNIQUE \(remittance_id, sheet_revision, row_index\)/.test(sql289), "12. UNIQUE compuesto");
assert(/remittance_edited/.test(sql289), "13. event remittance_edited");
assert(/cod_remittance_rows_current/.test(sql289), "14. vista current");
assert(/289 → 290 → 291/.test(sql289), "15. secuencia documentada en 289");

// 290
assert(/rpc_cod_replace_unconfirmed_remittance_sheet/.test(sql290), "16. RPC replace");
assert(!/DELETE FROM public\.cod_remittance_rows/.test(sql290), "17. 290 no DELETE");
assert(/v_new_revision := v_old_revision \+ 1/.test(sql290), "18. increment revision");
assert(/_cod_parse_remittance_date/.test(sql290), "19. reparse antes de insert");
assert(/INSERT INTO public\.cod_remittance_rows/.test(sql290), "20. INSERT rev nueva");
assert(/289 → 290 → 291/.test(sql290), "21. secuencia en 290");

// 291 funciones
const fns = [
  "_cod_remittance_current_revision",
  "_cod_normalize_match_name",
  "rpc_cod_save_analysis",
  "_cod_load_order_financial_snapshots",
  "rpc_cod_approve_auto_matched",
  "rpc_cod_assign_row",
  "rpc_cod_mark_row_unassigned",
  "rpc_cod_confirm_remittance",
  "rpc_cod_assign_confirmed_unassigned_row",
  "rpc_cod_correct_confirmed_assignment",
  "rpc_cod_void_confirmed_remittance",
];
for (const fn of fns) {
  assert(
    new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn.replace(/[()]/g, "")}`).test(sql291) ||
      sql291.includes(`CREATE OR REPLACE FUNCTION public.${fn}`),
    `22+. 291 tiene ${fn}`
  );
}

assert(/row_not_in_current_sheet_revision/.test(sql291), "33. rechazo fila histórica");
assert(
  (sql291.match(/sheet_revision = v_sheet_revision/g) || []).length >= 3,
  "34. 278/279 predicado revision"
);
assert(/sheet_revision = COALESCE\(v_rem\.sheet_revision/.test(sql291), "35. 280/286 COALESCE rev");
assert(/sheet_revision = v_rev/.test(sql291), "36. 288 filtra v_rev");
assert(/NO re-aplicar|HISTÓRICAS|inmutables/i.test(sql291), "37. 291 documenta no reaplicar 278-288");

// Unique index financial
assert(
  /uq_cod_rows_matched_order_active[\s\S]*confirmed_matched[\s\S]*confirmed_with_irregularity/.test(
    load("272_cod_reconciliation_schema.sql")
  ),
  "38. unique solo confirmed_* (approved histórico OK)"
);

// Create: DEFAULT 1 (no need change 276)
assert(/INSERT INTO public\.cod_remittance_rows \(/.test(sql276), "39. create insert exists");
assert(/DEFAULT 1/.test(sql289), "40. create recibe revision=1 por default");

// App
const actions = readFileSync(resolve(lib, "actions.ts"), "utf8");
const wizard = readFileSync(
  resolve(lib, "../../components/admin-reconciliation/NewRemittanceWizard.tsx"),
  "utf8"
);
assert(/replaceUnconfirmedRemittanceSheet/.test(actions), "41. action replace");
assert(/mode\?: "create" \| "edit"/.test(wizard), "42. wizard edit mode");
assert(/sheet_revision/.test(readFileSync(resolve(lib, "remittance-queries.ts"), "utf8")), "43. queries revision");

assert(
  (sql291.match(/CREATE OR REPLACE FUNCTION public\.rpc_cod_save_analysis\s*\(/g) || []).length ===
    1,
  "44. una sola save_analysis"
);
assert(/row_index_gap/.test(sql290) && /duplicate_row_index/.test(sql290), "45. 290 row_index hardening");
assert(
  !/GRANT EXECUTE ON FUNCTION public\._cod_remittance_current_revision\(uuid\) TO authenticated/.test(
    sql291
  ),
  "46. helper sin GRANT authenticated"
);
assert(
  /rpc_cod_void_confirmed_remittance[\s\S]*?sheet_revision = v_rev/.test(sql291),
  "47. 288 ignora filas históricas (filtra v_rev)"
);

console.log(`\n=== resultado: ${ok} ok, ${fail} fail ===\n`);
if (fail > 0) process.exit(1);
