import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

const migration = read("supabase/canonical/378_size_charts.sql");
const shared = read("admin/size-charts-shared.js");
const control = read("admin/product-size-chart.js");
const products = read("admin/products.js");
const productsHtml = read("admin/products.html");
const indexHtml = read("admin/index.html");

/** Parámetros declarados por cada función public.<nombre>(...) de la 378. */
function sqlFunctionParams() {
  const out = new Map();
  for (const m of migration.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(([^)]*)\)/g)) {
    const params = m[2]
      .split(",")
      .map((p) => p.trim().split(/\s+/)[0])
      .filter(Boolean);
    out.set(m[1], params);
  }
  return out;
}

test("el admin llama solo RPC de la 378 con los parámetros exactos", () => {
  const defined = sqlFunctionParams();
  const calls = [...shared.matchAll(/supabase\.rpc\("(\w+)"(?:,\s*\{([^}]*)\})?\)/g)];
  assert.equal(calls.length, 5);
  for (const [, name, args = ""] of calls) {
    assert.ok(defined.has(name), `${name} no está en la 378`);
    const sent = [...args.matchAll(/\b(p_\w+)\s*:/g)].map((m) => m[1]).sort();
    assert.deepEqual(sent, [...defined.get(name)].sort(), `${name}: parámetros distintos a la 378`);
  }
});

test("las tablas de talles no se leen ni escriben por PostgREST desde el admin", () => {
  for (const file of fs.readdirSync(path.join(repoRoot, "admin")).filter((f) => f.endsWith(".js"))) {
    const source = read(`admin/${file}`);
    assert.doesNotMatch(source, /from\(\s*["'](size_charts|size_chart_rows)["']/, file);
  }
});

test("size_chart_id solo viaja si el selector cargó", () => {
  assert.match(control, /payloadField\(\)\s*\{\s*if \(!state\.loaded \|\| !select\) return \{\};/);
  assert.match(control, /return \{ size_chart_id: select\.value \|\| null \};/);
});

test("products.js integra el selector en altas, update, carga, categoría y clon", () => {
  assert.equal(products.match(/\.\.\.sizeChartControl\.payloadField\(\)/g)?.length, 2);
  const quickCreate = products.slice(products.indexOf("const payloadProduct = {"));
  assert.ok(quickCreate.indexOf("sizeChartControl.payloadField()") < quickCreate.indexOf(".insert([payloadProduct])"));
  assert.match(products, /sizeChartControl\.setProduct\(prod\.size_chart_id \?\? null\)/);
  assert.match(products, /sizeChartControl\.refreshVisibility\(\)/);
  assert.match(products, /const sizeChartCloneWarning = sizeChartControl\.prepareClone\(\)/);
  assert.match(products, /sizeChartControl\.init\(\)/);
  assert.equal(products.match(/productSaveErrorMessage\((prodErr|upErr)\)/g)?.length, 3);
});

test("el formulario y el panel tienen los elementos que usa el control", () => {
  for (const id of [
    "size-chart-field",
    "size-chart",
    "size-chart-hint",
    "size-chart-new-btn",
    "size-chart-edit-btn",
    "size-chart-duplicate-btn",
    "size-chart-retry-btn",
  ]) {
    assert.match(productsHtml, new RegExp(`id="${id}"`), id);
    assert.match(control, new RegExp(`getElementById\\("${id}"\\)`), id);
  }
  assert.match(indexHtml, /href="\.\/size-charts\.html" class="dashboard-card" data-module="products"/);
});
