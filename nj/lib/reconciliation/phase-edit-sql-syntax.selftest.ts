/**
 * Selftest — sintaxis PostgreSQL de 289/290/291 (parser libpg-query wasm).
 * NO aplica migraciones. Requiere pg-query-emscripten en node_modules raíz.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const root = resolve(repoRoot, "supabase/canonical");
const require = createRequire(resolve(repoRoot, "node_modules/pg-query-emscripten/package.json"));

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

function load(name: string): string {
  return readFileSync(resolve(root, name), "utf8");
}

function extractCreates(sql: string): string[] {
  const re = /CREATE OR REPLACE FUNCTION[\s\S]*?\$([A-Za-z_]*)\$[\s\S]*?\$\1\$\s*;/g;
  return [...sql.matchAll(re)].map((m) => m[0]);
}

console.log("\n=== phase-edit-sql-syntax.selftest ===\n");

const sql289 = load("289_cod_remittance_sheet_revisions_schema.sql");
const sql290 = load("290_rpc_cod_replace_unconfirmed_remittance_sheet.sql");
const sql291 = load("291_cod_reconciliation_revision_aware_rpcs.sql");

const expectedFns = [
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
] as const;

for (const fn of expectedFns) {
  const n = (sql291.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\s*\\(`, "g")) || [])
    .length;
  assert(n === 1, `1 def efectiva: ${fn}`);
}

assert(
  !/COMMENT ON FUNCTION public\._cod_normalize_match_name\(text\) IS[\s\S]{0,80}\)\s*THEN/.test(
    sql291
  ),
  "291 sin fragmento huérfano tras save_analysis"
);

assert(
  /row_not_in_current_sheet_revision/.test(sql291) &&
    sql291.includes("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"),
  "save_analysis: UUID regex + rechazo histórico"
);

assert(
  /REVOKE ALL ON FUNCTION public\._cod_remittance_current_revision\(uuid\) FROM authenticated/.test(
    sql291
  ) &&
    !/GRANT EXECUTE ON FUNCTION public\._cod_remittance_current_revision\(uuid\) TO authenticated/.test(
      sql291
    ),
  "helper current_revision sin GRANT authenticated"
);

assert(/row_index_negative/.test(sql290), "290 row_index negativo");
assert(/row_index_gap/.test(sql290), "290 row_index hueco");
assert(/duplicate_row_index/.test(sql290), "290 row_index duplicado");
assert(/row_index_out_of_range/.test(sql290), "290 row_index fuera de rango");
assert(
  !/v_old_row_count\s*<>\s*v_row_count|v_row_count\s*<>\s*v_old_row_count/.test(sql290),
  "290 permite N distinto (93→92/93/94)"
);

// 278/279 rechazo histórico
assert(
  /rpc_cod_save_analysis[\s\S]*?row_not_in_current_sheet_revision[\s\S]*?CREATE OR REPLACE FUNCTION public\._cod_load_order/.test(
    sql291
  ),
  "278 path: rechazo histórico en save_analysis"
);
assert(
  /rpc_cod_assign_row[\s\S]*?row_not_in_current_sheet_revision/.test(sql291),
  "279 path: rechazo histórico en assign_row"
);

// 280 solo revisión actual
assert(
  /rpc_cod_confirm_remittance[\s\S]*?sheet_revision = COALESCE\(v_rem\.sheet_revision, 1\)/.test(
    sql291
  ),
  "280 confirma solo revisión actual"
);

// 288 ignora estados históricos rev1
assert(
  /v_rev := COALESCE\(v_rem\.sheet_revision, 1\)[\s\S]*?AND sheet_revision = v_rev/.test(sql291),
  "288 conteos/mutaciones filtran v_rev (ignora rev1 histórica)"
);

const parserPath = resolve(repoRoot, "node_modules/pg-query-emscripten");
assert(existsSync(parserPath), "pg-query-emscripten disponible para parse real");

async function parseSqlFiles() {
  if (!existsSync(parserPath)) return;
  const factory = require("pg-query-emscripten").default as () => Promise<{
    parse: (s: string) => { error?: { message: string; cursorpos?: number } };
  }>;

  for (const [name, sql] of [
    ["289", sql289],
    ["290", sql290],
  ] as const) {
    const pg = await factory();
    const r = pg.parse(sql);
    assert(!r.error, `${name} whole-file parse`);
  }

  const creates = extractCreates(sql291);
  assert(creates.length === 11, `291 tiene 11 CREATE bodies (got ${creates.length})`);
  for (const body of creates) {
    const pg = await factory();
    const name = (body.match(/FUNCTION public\.(\w+)/) || [])[1] || "?";
    const r = pg.parse(body);
    assert(!r.error, `291 CREATE parse: ${name}`);
  }
}

parseSqlFiles()
  .then(() => {
    console.log(`\n=== resultado: ${ok} ok, ${fail} fail ===\n`);
    if (fail > 0) process.exit(1);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
