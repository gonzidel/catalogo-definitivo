/**
 * Fase 6A — selftest estático de migraciones 284/285 (sin tocar producción).
 *
 * Runtime post-apply (manual / fixture): ver comentarios al final.
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

console.log("\n=== phase6a-irregularities.selftest ===\n");

const sql284 = load("284_cod_irregularity_review_event_type.sql");
const sql285 = load("285_rpc_cod_update_irregularity_status.sql");

// 284 — event_type
assert(/irregularity_review_started/.test(sql284), "284: agrega irregularity_review_started");
assert(/irregularity_resolved/.test(sql284), "284: preserva irregularity_resolved");
assert(/alias_reassigned/.test(sql284), "284: preserva alias_reassigned");
assert(/alias_created/.test(sql284), "284: preserva alias_created");
assert(/DROP CONSTRAINT/.test(sql284), "284: drop+recreate check");
assert(!/DELETE FROM/i.test(sql284), "284: sin DELETE de datos");

// 285 — RPC
assert(/rpc_cod_update_irregularity_status/.test(sql285), "285: función RPC");
assert(/SECURITY DEFINER/.test(sql285), "285: SECURITY DEFINER");
assert(/search_path TO 'public', 'pg_catalog'/.test(sql285), "285: search_path fijo");
assert(/has_permission\(v_uid, 'conciliacion-reembolso', 'edit'\)/.test(sql285), "285: permiso edit");
assert(/REVOKE ALL ON FUNCTION public\.rpc_cod_update_irregularity_status/.test(sql285), "285: REVOKE PUBLIC");
assert(/FROM anon/.test(sql285), "285: REVOKE anon");
assert(/GRANT EXECUTE.*TO authenticated/.test(sql285), "285: GRANT authenticated");
assert(/GRANT EXECUTE.*TO service_role/.test(sql285), "285: GRANT service_role");

// Transiciones
assert(/open' AND v_new = 'in_review'/.test(sql285), "1. open → in_review");
assert(/v_new = 'resolved'/.test(sql285), "2. → resolved path");
assert(/v_prev = 'open' OR v_prev = 'in_review'/.test(sql285), "3. in_review → resolved");
assert(/irregularity_already_resolved/.test(sql285), "4. resolved → * rechaza");
assert(/irregularity_superseded/.test(sql285), "5. superseded → * rechaza");
assert(/resolution_notes_required/.test(sql285), "6. resolved sin notes rechaza");
assert(/forbidden/.test(sql285), "7. sin edit rechaza");
assert(/not_authenticated/.test(sql285), "8. anon/no auth rechaza");

// No muta orders / remittance / row_status
assert(!/UPDATE\s+public\.orders/i.test(sql285), "9. no modifica orders");
assert(!/UPDATE\s+public\.cod_remittances/i.test(sql285), "10. no modifica remittance");
assert(!/UPDATE\s+public\.cod_remittance_rows/i.test(sql285), "11. no cambia row_status");
assert(
  !/SET\s+matched_order_id|matched_order_id\s*=/i.test(sql285),
  "12. no asigna matched_order_id"
);

// Eventos
assert(/irregularity_review_started/.test(sql285), "13a. evento review_started");
assert(/irregularity_resolved/.test(sql285), "13b. evento resolved");
assert(/previous_state/.test(sql285) && /new_state/.test(sql285), "13c. previous/new status en evento");
assert(/FOR UPDATE/.test(sql285), "14. lock FOR UPDATE (rollback ante error implícito)");

assert(/resolution_note/.test(sql285), "usa resolution_note (schema 272)");
assert(/resolved_by = v_uid/.test(sql285), "setea resolved_by");
assert(/resolved_at = now\(\)/.test(sql285), "setea resolved_at");
assert(/superseded_not_allowed_manual|invalid_new_status/.test(sql285), "bloquea superseded manual");
assert(!/p_new_status.*superseded/.test(sql285) || /invalid_new_status/.test(sql285), "no acepta superseded como new");

console.log(`\nResultado: ${ok} ok, ${fail} fail\n`);

console.log(`Casos runtime post-apply (fixture, NO producción ciega):
  · open → in_review OK + evento irregularity_review_started
  · open → resolved + notes OK + evento irregularity_resolved
  · in_review → resolved OK
  · resolved → open RAISE
  · superseded → resolved RAISE
  · resolved sin notes RAISE
  · usuario sin edit RAISE forbidden
  · anon RAISE / sin EXECUTE
  · resolver: orders / remittance / row_status / pending invariantes
  · RAISE en medio → rollback (transacción única)
`);

if (fail > 0) process.exit(1);
