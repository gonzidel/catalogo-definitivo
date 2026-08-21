/**
 * Auditoría estática de 278_rpc_cod_save_analysis.sql (sin aplicar en prod).
 * Ejecutar desde nj/:
 *   npx --yes tsx lib/reconciliation/save-analysis-rpc.selftest.ts
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

const sqlPath = resolve(
  process.cwd(),
  "..",
  "supabase",
  "canonical",
  "278_rpc_cod_save_analysis.sql"
);
const sql = readFileSync(sqlPath, "utf8");

console.log("\n=== save-analysis-rpc.selftest (auditoría SQL 278) ===\n");
console.log(`Archivo: ${sqlPath}\n`);

assert(/SECURITY DEFINER/i.test(sql), "SECURITY DEFINER");
assert(/SET search_path TO 'public', 'pg_catalog'/i.test(sql), "search_path seguro");
assert(/auth\.uid\(\)/.test(sql), "auth.uid() obligatorio");
assert(
  /has_permission\(v_uid,\s*'conciliacion-reembolso',\s*'edit'\)/.test(sql),
  "has_permission edit"
);
assert(/REVOKE ALL[\s\S]*FROM anon/i.test(sql), "REVOKE EXECUTE FROM anon");
assert(/GRANT EXECUTE[\s\S]*TO authenticated/i.test(sql), "GRANT authenticated");
assert(!/CREATE POLICY/i.test(sql), "sin nuevas policies UPDATE");

assert(/duplicate_row_id_in_payload/.test(sql), "rechazo row_id duplicado");
assert(/row_count_mismatch/.test(sql), "cobertura: count payload = count filas");
assert(/incomplete_row_coverage|row_not_in_remittance/.test(sql), "cobertura 1:1 / row otra remesa");
assert(/remittance_not_analyzable/.test(sql), "confirmed|voided cabecera rechazados");
assert(/v_status NOT IN \('draft', 'analyzed'\)/.test(sql), "solo draft|analyzed");

assert(
  /NOT IN \('auto_matched', 'needs_review', 'unassigned'\)/.test(sql),
  "solo estados de análisis en payload"
);
assert(/remittance_has_approved_rows/.test(sql), "rechazo si hay approved_pending_confirmation");
assert(/remittance_has_non_analyzable_rows/.test(sql), "rechazo confirmed_*/void en filas");
assert(
  /pending_analysis',\s*'auto_matched',\s*'needs_review',\s*'unassigned'/.test(sql),
  "reanálisis solo con filas en estados de análisis"
);

assert(
  /v_row_status = 'unassigned'[\s\S]{0,200}v_matched_order_id := NULL/.test(sql),
  "unassigned ⇒ matched_order_id NULL"
);
assert(/matched_order_not_in_cod_universe/.test(sql), "valida universo COD del order_id");
assert(/matched_order_already_confirmed/.test(sql), "rechaza order ya confirmed_*");

// Snapshots financieros desde DB
assert(/v_db_expected_amount/.test(sql), "variable expected_amount desde DB");
assert(/round\(COALESCE\(o\.total_amount/.test(sql), "expected_amount = orders.total_amount");
assert(
  /expected_amount_snapshot = CASE[\s\S]*ELSE v_db_expected_amount/.test(sql),
  "persiste expected_amount_snapshot desde v_db_* (no JSON)"
);
assert(
  /order_number_snapshot = CASE[\s\S]*ELSE v_db_order_number/.test(sql),
  "order_number_snapshot desde DB"
);
assert(
  /order_sent_date_snapshot = CASE[\s\S]*ELSE v_db_sent_date/.test(sql),
  "order_sent_date_snapshot desde DB"
);
assert(
  /transport_name_snapshot = CASE[\s\S]*ELSE v_db_transport_name/.test(sql),
  "transport_name_snapshot desde DB"
);
assert(
  /COALESCE\(o\.transport_id,\s*c\.transport_id\)/.test(sql),
  "transporte efectivo COALESCE(order, customer)"
);
assert(
  !/expected_amount_snapshot[\s\S]{0,80}\(v_row->>'expected_amount_snapshot'\)/.test(
    sql.replace(/--[^\n]*/g, "")
  ),
  "no asigna expected_amount desde JSON del cliente"
);
assert(/snapshots_source',\s*'server_orders'/.test(sql), "evento documenta snapshots_source=server_orders");
assert(
  /IGNORAN|ignoran|server-side|fuente de verdad = DB/i.test(sql),
  "documenta que snapshots JSON del cliente se ignoran"
);

// matched_name metadata + validación
assert(/_cod_normalize_match_name/.test(sql), "helper normalización nombre");
assert(/matched_name_not_in_order_identities/.test(sql), "valida label/titular/sub_name");
assert(
  /Metadata explicativa|NO financiera|no financiera/i.test(sql),
  "documenta matched_name_* como no financiera"
);

assert(/immutable_or_forbidden_field/.test(sql), "rechazo claves raw_*/parsed_*/confirmación");
assert(/'raw_line'/.test(sql) && /'raw_customer_name_text'/.test(sql), "lista raw_* prohibidos");
assert(
  /UPDATE public\.cod_remittance_rows SET[\s\S]*?WHERE id = v_row_id/.test(sql) &&
    !/UPDATE public\.cod_remittance_rows SET[\s\S]*raw_line\s*=/.test(sql),
  "UPDATE no escribe raw_*"
);
assert(!/UPDATE public\.orders/i.test(sql), "no muta orders");
assert(!/INSERT INTO public\.cod_irregularities/i.test(sql), "no crea irregularidades");

assert(/client_summary_meta/.test(sql), "p_summary solo metadata de evento");
assert(/remittance_analyzed/.test(sql), "evento remittance_analyzed");
assert(/RAISE EXCEPTION/.test(sql), "fallos vía RAISE ⇒ rollback transaccional");

const runtimeCases = [
  "expected_amount_snapshot JSON=95000 + order 150000 → DB guarda 150000 (ignora JSON)",
  "order_sent_date_snapshot manipulado → ignorado; persiste fecha DB",
  "order_number_snapshot manipulado → ignorado; persiste order_number DB",
  "transport_name_snapshot manipulado → ignorado; persiste transporte DB",
  "matched_name_source=label con nombre distinto al label → matched_name_not_in_order_identities",
  "rendición con approved_pending_confirmation → remittance_has_approved_rows (0 filas tocadas)",
  "fallo fila N → RAISE ⇒ rollback de todas (función = 1 tx)",
];

console.log("\nCasos runtime (requieren 278 aplicada; no ejecutados aquí):");
for (const c of runtimeCases) console.log(`  · ${c}`);

console.log(`\nResultado auditoría estática: ${passed} ok, ${failed} fail\n`);
if (failed > 0) process.exit(1);
