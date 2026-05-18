#!/usr/bin/env node
/**
 * Smoke read-only: columna DetallesSimilitud en vistas/snapshot (pre-rollout prod).
 *
 * Uso (tras aplicar 04+193+219 en STAGING/local):
 *   $env:SUPABASE_ANON_KEY="..."
 *   node scripts/smoke-detalles-similitud-postgrest.mjs
 *   node scripts/smoke-detalles-similitud-postgrest.mjs --report
 *
 * Navegador (Home contra vistas, no snapshot):
 *   localStorage.setItem('FYL_USE_CATALOG_SNAPSHOT','0')
 *   location.reload()
 *
 * TLS local: FYL_AUDIT_INSECURE_TLS=1
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WRITE_REPORT = process.argv.includes("--report");
const SAMPLE_LIMIT = Number(process.env.FYL_SMOKE_SAMPLE_LIMIT || "200");

const SUPABASE_URL = (process.env.SUPABASE_URL || "https://dtfznewwvsadkorxwzft.supabase.co").replace(
  /\/$/,
  ""
);
const ANON = process.env.SUPABASE_ANON_KEY || "";

if (process.env.FYL_AUDIT_INSECURE_TLS === "1") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const CATALOG_SELECT =
  "Articulo,Filtro1,Filtro2,Filtro3,DetallesSimilitud,Categoria,Mostrar";

const SOURCES = [
  { key: "catalog_public_view", table: "catalog_public_view" },
  { key: "catalog_public_available_view", table: "catalog_public_available_view" },
  { key: "catalog_public_snapshot", table: "catalog_public_snapshot" },
];

const evidence = {
  generatedAt: new Date().toISOString(),
  supabaseUrl: SUPABASE_URL,
  checks: [],
  summary: { pass: 0, fail: 0, warn: 0 },
};

function headers() {
  return {
    apikey: ANON,
    authorization: `Bearer ${ANON}`,
    accept: "application/json",
    prefer: "count=exact",
  };
}

async function restGet(relativePath) {
  const url = `${SUPABASE_URL}/rest/v1${relativePath}`;
  const res = await fetch(url, { headers: headers() });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { _raw: text?.slice(0, 500) };
  }
  const contentRange = res.headers.get("content-range") || "";
  const totalMatch = contentRange.match(/\/(\d+)$/);
  const total = totalMatch ? Number(totalMatch[1]) : null;
  return { status: res.status, body, total, contentRange };
}

function record(name, status, detail) {
  const entry = { name, status, detail };
  evidence.checks.push(entry);
  if (status === "PASS") evidence.summary.pass += 1;
  else if (status === "FAIL") evidence.summary.fail += 1;
  else evidence.summary.warn += 1;
  const icon = status === "PASS" ? "✓" : status === "FAIL" ? "✗" : "⚠";
  console.log(`${icon} [${status}] ${name}`);
  if (detail) console.log("   ", JSON.stringify(detail, null, 0).slice(0, 800));
}

function analyzeRows(rows) {
  let withDetalles = 0;
  let emptyDetalles = 0;
  let onlyFiltro3 = 0;
  let neither = 0;
  let undefinedDetalles = 0;
  const samples = { detallesOnly: [], legacyOnly: [], both: [], neither: [] };

  for (const r of rows) {
    const hasProp = Object.prototype.hasOwnProperty.call(r, "DetallesSimilitud");
    if (!hasProp) undefinedDetalles += 1;
    const d = String(r.DetallesSimilitud ?? "").trim();
    const f3 = String(r.Filtro3 ?? "").trim();
    if (d) withDetalles += 1;
    else if (hasProp) emptyDetalles += 1;
    if (d && !f3 && samples.detallesOnly.length < 3) samples.detallesOnly.push(r.Articulo);
    if (!d && f3 && samples.legacyOnly.length < 3) samples.legacyOnly.push(r.Articulo);
    if (d && f3 && samples.both.length < 3) samples.both.push(r.Articulo);
    if (!d && !f3) {
      neither += 1;
      if (samples.neither.length < 3) samples.neither.push(r.Articulo);
    }
    if (!d && f3) onlyFiltro3 += 1;
    if (!d && !f3) neither += 0;
  }

  return {
    rowCount: rows.length,
    withDetalles,
    emptyDetalles,
    undefinedDetalles,
    onlyFiltro3,
    neither,
    samples,
  };
}

async function probeSource({ key, table }) {
  const path =
    `/${table}?select=${encodeURIComponent(CATALOG_SELECT)}` +
    `&Mostrar=eq.true&limit=${SAMPLE_LIMIT}`;

  const { status, body, total } = await restGet(path);

  if (status === 400 || status === 404) {
    const msg = body?.message || body?.hint || body?.code || String(body);
    const missingCol =
      /DetallesSimilitud/i.test(String(msg)) ||
      /column/i.test(String(msg));
    record(
      `${key}:columna_DetallesSimilitud`,
      "FAIL",
      { status, hint: missingCol ? "columna_ausente_o_vista_sin_migrar" : msg }
    );
    return;
  }

  if (status !== 200 || !Array.isArray(body)) {
    record(`${key}:http`, "FAIL", { status, body });
    return;
  }

  const stats = analyzeRows(body);
  record(`${key}:columna_DetallesSimilitud`, stats.undefinedDetalles === 0 ? "PASS" : "FAIL", {
    status,
    sampleRows: body.length,
    estimatedTotal: total,
    ...stats,
  });

  if (stats.onlyFiltro3 > 0) {
    record(
      `${key}:legacy_fallback_candidatos`,
      "WARN",
      {
        count: stats.onlyFiltro3,
        note: "Filtro3 sin DetallesSimilitud — matcher comercial usa fallback Filtro1-3",
        articulos: stats.samples.legacyOnly,
      }
    );
  }
}

async function probeProductTagDetailsNotRequired() {
  const { status, body } = await restGet(
    "/product_tag_details?select=product_id&limit=1"
  );
  record("product_tag_details:readable", status === 200 ? "PASS" : "WARN", {
    status,
    note: "Solo lectura; en Home NO debe llamarse tras migración",
    sample: body,
  });
}

function printBrowserChecklist() {
  console.log("\n--- Checklist navegador (tras SQL en staging) ---\n");
  console.log("1. localStorage.setItem('FYL_USE_CATALOG_SNAPSHOT','0'); location.reload();");
  console.log("2. Consola: filtrar [FYL Perf]");
  console.log("   Esperado: catalog_requests (1 tanda), commercial_early_return, banner_catalog_reuse");
  console.log("   NO esperado: commercial_requests bridge:true, segundo catalog_requests del banner");
  console.log("3. HOME: banner, OR multi-tag, Ver todo, sin doble flash");
  console.log("4. Filtros: #/tag/x, #/tags/a|b, chips, limpiar");
  console.log("5. Edge: sin detalles, solo legacy, banner sin tags, acentos/espacios");
  console.log("6. Red 4G: Performance → Slow 4G, cold reload\n");
  console.log("--- Hook consola (pegar en index tras cargar) ---\n");
  console.log(`(function(){
  const o=window.fetch;let c=0,b=0;
  window.__FYL_SMOKE_FETCH={catalog:0,commercial:0,other:0};
  window.fetch=function(...a){
    const u=String(a[0]||'');
    if(u.includes('/rest/v1/')){
      c++;
      if(/product_tag_details|\\/products\\?/.test(u)) b++;
      if(/catalog_public|catalog_public_snapshot/.test(u)) window.__FYL_SMOKE_FETCH.catalog++;
      if(/product_tag_details/.test(u)) window.__FYL_SMOKE_FETCH.commercial++;
    }
    return o.apply(this,a);
  };
  console.warn('[FYL Smoke] fetch hook ON — recargá y revisá __FYL_SMOKE_FETCH');
})();`);
}

async function main() {
  if (!ANON) {
    console.error("Falta SUPABASE_ANON_KEY en el entorno.");
    process.exit(1);
  }

  console.log(`Smoke DetallesSimilitud (read-only) → ${SUPABASE_URL}\n`);

  for (const src of SOURCES) {
    await probeSource(src);
  }

  await probeProductTagDetailsNotRequired();

  printBrowserChecklist();

  if (WRITE_REPORT) {
    const out = path.join(__dirname, "outputs", "smoke-detalles-similitud-evidence.json");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(evidence, null, 2));
    console.log(`\nReporte: ${out}`);
  }

  console.log(
    `\nResumen: ${evidence.summary.pass} pass, ${evidence.summary.warn} warn, ${evidence.summary.fail} fail`
  );
  process.exit(evidence.summary.fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
