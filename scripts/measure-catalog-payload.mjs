#!/usr/bin/env node
/**
 * Medición real de payload del catálogo — antes/después DetallesSimilitud.
 * Solo lectura (PostgREST).
 *
 * Uso:
 *   $env:SUPABASE_ANON_KEY="..."
 *   $env:FYL_AUDIT_INSECURE_TLS="1"   # si hace falta en Windows
 *   node scripts/measure-catalog-payload.mjs
 *   node scripts/measure-catalog-payload.mjs --full
 *   node scripts/measure-catalog-payload.mjs --report
 *
 * Env:
 *   FYL_PAYLOAD_MAX_ROWS=0     → todas las filas (paginado 1000)
 *   FYL_PAYLOAD_MAX_ROWS=2000  → tope de filas por tabla (default 3000)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import zlib from "zlib";
import { promisify } from "util";

const gzipAsync = promisify(zlib.gzip);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WRITE_REPORT = process.argv.includes("--report");
const FETCH_ALL = process.argv.includes("--full");
const PAGE_SIZE = 1000;
const MAX_ROWS = FETCH_ALL
  ? 0
  : Number(process.env.FYL_PAYLOAD_MAX_ROWS || "3000");

const SUPABASE_URL = (process.env.SUPABASE_URL || "https://dtfznewwvsadkorxwzft.supabase.co").replace(
  /\/$/,
  ""
);
const ANON = process.env.SUPABASE_ANON_KEY || "";

if (process.env.FYL_AUDIT_INSECURE_TLS === "1") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

/** Mismo set que main-supabase.js CATALOG_PUBLIC_SELECT */
const SELECT_WITH_DETALLES = [
  "Categoria",
  "Articulo",
  "Descripcion",
  "Color",
  "Numeracion",
  "FechaIngreso",
  "Mostrar",
  "Oferta",
  "Precio",
  "Imagen Principal",
  "Imagen 1",
  "Imagen 2",
  "Imagen 3",
  "Filtro1",
  "Filtro2",
  "Filtro3",
  "DetallesSimilitud",
  "OfertaActiva",
  "PrecioOferta",
  "PromoActiva",
  "OfferCampaignId",
  "OfferImageUrl",
  "OfferTitle",
  "ColorHex",
  "ColorDisplayNumber",
  "SupplierCode",
].join(",");

const SELECT_WITHOUT_DETALLES = SELECT_WITH_DETALLES.split(",")
  .filter((c) => c !== "DetallesSimilitud")
  .join(",");

const SOURCES = [
  { key: "catalog_public_view", table: "catalog_public_view" },
  { key: "catalog_public_available_view", table: "catalog_public_available_view" },
  { key: "catalog_public_snapshot", table: "catalog_public_snapshot" },
];

const report = {
  generatedAt: new Date().toISOString(),
  supabaseUrl: SUPABASE_URL,
  config: { fetchAll: FETCH_ALL, maxRows: MAX_ROWS, pageSize: PAGE_SIZE },
  sources: {},
  simulatedDetalles: null,
  recommendations: [],
};

function kb(bytes) {
  return Math.round((bytes / 1024) * 100) / 100;
}

function headers(extra = {}) {
  return {
    apikey: ANON,
    authorization: `Bearer ${ANON}`,
    accept: "application/json",
    ...extra,
  };
}

async function fetchPage(table, select, from, to) {
  const q =
    `/${table}?select=${encodeURIComponent(select)}` +
    `&Mostrar=eq.true&order=Articulo.asc`;
  const url = `${SUPABASE_URL}/rest/v1${q}`;
  const res = await fetch(url, {
    headers: headers({ Range: `${from}-${to}`, Prefer: "count=exact" }),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const contentRange = res.headers.get("content-range") || "";
  const totalMatch = contentRange.match(/\/(\d+|\*)$/);
  const total = totalMatch && totalMatch[1] !== "*" ? Number(totalMatch[1]) : null;

  let rows = [];
  let parseError = null;
  if (res.status >= 200 && res.status < 300) {
    try {
      rows = JSON.parse(buf.toString("utf8"));
      if (!Array.isArray(rows)) rows = [];
    } catch (e) {
      parseError = e.message;
    }
  }

  return {
    status: res.status,
    buf,
    rows,
    total,
    contentRange,
    parseError,
    contentLength: Number(res.headers.get("content-length")) || buf.length,
  };
}

async function fetchAllRows(table, select) {
  const allRows = [];
  let transferBytes = 0;
  let from = 0;
  let total = null;
  let lastStatus = 0;

  while (true) {
    const to = from + PAGE_SIZE - 1;
    const page = await fetchPage(table, select, from, to);
    lastStatus = page.status;

    if (page.status === 400 && /DetallesSimilitud/i.test(page.buf.toString("utf8"))) {
      return { ok: false, missingDetalles: true, rows: [], transferBytes: 0, total: null };
    }
    if (page.status !== 200 && page.status !== 206) {
      return {
        ok: false,
        missingDetalles: false,
        error: { status: page.status, body: page.buf.toString("utf8").slice(0, 400) },
        rows: [],
        transferBytes,
        total,
      };
    }

    transferBytes += page.contentLength;
    allRows.push(...page.rows);
    if (page.total != null) total = page.total;

    if (page.rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
    if (MAX_ROWS > 0 && allRows.length >= MAX_ROWS) {
      allRows.splice(MAX_ROWS);
      break;
    }
  }

  return { ok: true, rows: allRows, transferBytes, total, lastStatus };
}

async function measurePayload(label, rows, wireTransferBytes) {
  const jsonString = JSON.stringify(rows);
  const jsonBytes = Buffer.byteLength(jsonString, "utf8");
  const gzipBuf = await gzipAsync(jsonString);
  const gzipBytes = gzipBuf.length;
  const n = rows.length || 1;

  return {
    label,
    rows: rows.length,
    kb_json: kb(jsonBytes),
    kb_gzip: kb(gzipBytes),
    kb_transfer: kb(wireTransferBytes),
    bytes_per_row_json: Math.round(jsonBytes / n),
    bytes_per_row_gzip: Math.round(gzipBytes / n),
    bytes_per_row_transfer: Math.round(wireTransferBytes / n),
    jsonBytes,
    gzipBytes,
    transferBytes: wireTransferBytes,
  };
}

function analyzeDetallesField(rows) {
  const detallesLengths = [];
  const detallesValues = new Map();
  const filtro3Values = new Map();
  let withDetalles = 0;
  let withFiltro3 = 0;
  let detallesEqualsFiltro3 = 0;
  let detallesContainsFiltro3Only = 0;
  let looksLikeSerialized = 0;
  let emptyDetalles = 0;
  const heavy = [];

  for (const r of rows) {
    const d = String(r.DetallesSimilitud ?? "");
    const f3 = String(r.Filtro3 ?? "");
    const dTrim = d.trim();
    const f3Trim = f3.trim();

    if (dTrim) {
      withDetalles += 1;
      detallesLengths.push(dTrim.length);
      detallesValues.set(dTrim, (detallesValues.get(dTrim) || 0) + 1);
      if (/^\[|\{/.test(dTrim) || /"\w+"\s*:/.test(dTrim)) looksLikeSerialized += 1;
    } else {
      emptyDetalles += 1;
    }

    if (f3Trim) {
      withFiltro3 += 1;
      filtro3Values.set(f3Trim, (filtro3Values.get(f3Trim) || 0) + 1);
    }

    if (dTrim && f3Trim && dTrim === f3Trim) detallesEqualsFiltro3 += 1;
    if (dTrim && f3Trim && dTrim !== f3Trim) {
      const f3Parts = f3Trim.split(/[,;]+/).map((s) => s.trim().toLowerCase());
      const dParts = dTrim.split(/[,;]+/).map((s) => s.trim().toLowerCase());
      if (f3Parts.every((p) => dParts.includes(p))) detallesContainsFiltro3Only += 1;
    }

    const rowBytes = Buffer.byteLength(JSON.stringify(r), "utf8");
    if (rowBytes > 2500 || dTrim.length > 120) {
      heavy.push({
        Articulo: r.Articulo,
        Categoria: r.Categoria,
        row_kb: kb(rowBytes),
        detalles_len: dTrim.length,
        filtro3_len: f3Trim.length,
        detalles_preview: dTrim.slice(0, 100),
      });
    }
  }

  const sortedAsc = [...detallesLengths].sort((a, b) => a - b);
  heavy.sort((a, b) => b.row_kb - a.row_kb);

  const uniqueDetalles = detallesValues.size;
  const duplicateDetallesRows =
    [...detallesValues.values()].filter((c) => c > 1).reduce((s, c) => s + c, 0) - uniqueDetalles;

  const topDetallesStrings = [...detallesValues.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([value, count]) => ({
      count,
      len: value.length,
      preview: value.slice(0, 80),
    }));

  const topHeavyDetalles = rows
    .filter((r) => String(r.DetallesSimilitud ?? "").trim())
    .map((r) => ({
      Articulo: r.Articulo,
      len: String(r.DetallesSimilitud).length,
      tag_count: String(r.DetallesSimilitud).split(/[,;]+/).filter(Boolean).length,
      preview: String(r.DetallesSimilitud).slice(0, 120),
    }))
    .sort((a, b) => b.len - a.len)
    .slice(0, 10);

  return {
    withDetalles,
    emptyDetalles,
    withFiltro3,
    detallesEqualsFiltro3,
    detallesContainsFiltro3Only,
    looksLikeSerialized,
    uniqueDetallesStrings: uniqueDetalles,
    duplicateDetallesRows,
    p50_detalles_len: sortedAsc[Math.floor(sortedAsc.length * 0.5)] || 0,
    p95_detalles_len: sortedAsc[Math.floor(sortedAsc.length * 0.95)] || 0,
    max_detalles_len: sortedAsc[sortedAsc.length - 1] || 0,
    top_shared_detalles: topDetallesStrings,
    top_heavy_by_detalles: topHeavyDetalles,
    top_heavy_rows: heavy.slice(0, 10),
    filtro3_unique: filtro3Values.size,
  };
}

function compareBeforeAfter(before, after) {
  if (!before || !after) return null;
  return {
    delta_kb_json: Math.round((after.kb_json - before.kb_json) * 100) / 100,
    delta_kb_gzip: Math.round((after.kb_gzip - before.kb_gzip) * 100) / 100,
    delta_kb_transfer: Math.round((after.kb_transfer - before.kb_transfer) * 100) / 100,
    pct_json:
      before.jsonBytes > 0
        ? Math.round(((after.jsonBytes - before.jsonBytes) / before.jsonBytes) * 1000) / 10
        : null,
    pct_gzip:
      before.gzipBytes > 0
        ? Math.round(((after.gzipBytes - before.gzipBytes) / before.gzipBytes) * 1000) / 10
        : null,
    delta_bytes_per_row: after.bytes_per_row_json - before.bytes_per_row_json,
  };
}

/** Estima bytes extra si la columna aún no existe en la vista. */
async function buildSimulatedDetallesMap() {
  const byProduct = new Map();
  let from = 0;
  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/product_tag_details?select=product_id,tags(name)`;
    const res = await fetch(url, {
      headers: headers({ Range: `${from}-${from + PAGE_SIZE - 1}` }),
    });
    if (!res.ok) break;
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) break;
    for (const row of rows) {
      const name = row?.tags?.name;
      if (!row.product_id || !name) continue;
      const list = byProduct.get(row.product_id) || [];
      list.push(name);
      byProduct.set(row.product_id, list);
    }
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  const productIds = [...byProduct.keys()];
  const idToArticulo = new Map();
  for (let i = 0; i < productIds.length; i += 200) {
    const chunk = productIds.slice(i, i + 200);
    const url =
      `${SUPABASE_URL}/rest/v1/products?select=id,name` +
      `&id=in.(${chunk.join(",")})&status=eq.active`;
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) continue;
    const products = await res.json();
    for (const p of products || []) {
      if (p?.id && p?.name) idToArticulo.set(p.id, p.name.trim());
    }
  }

  const byArticulo = new Map();
  for (const [pid, names] of byProduct) {
    const art = idToArticulo.get(pid);
    if (!art) continue;
    const seen = new Set();
    const merged = [];
    for (const n of names) {
      const k = n.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      merged.push(n);
    }
    merged.sort((a, b) => a.localeCompare(b, "es", { sensitivity: "base" }));
    byArticulo.set(art, merged.join(", "));
  }
  return byArticulo;
}

function applySimulatedDetalles(rows, byArticulo) {
  return rows.map((r) => {
    const art = String(r.Articulo ?? "").trim();
    const sim = byArticulo.get(art) || "";
    return { ...r, DetallesSimilitud: sim };
  });
}

function printTable(title, obj) {
  console.log(`\n=== ${title} ===`);
  console.log(
    `filas: ${obj.rows} | JSON: ${obj.kb_json} KB | gzip: ${obj.kb_gzip} KB | transfer: ${obj.kb_transfer} KB`
  );
  console.log(
    `bytes/fila → json: ${obj.bytes_per_row_json} | gzip: ${obj.bytes_per_row_gzip} | transfer: ${obj.bytes_per_row_transfer}`
  );
}

function addRecommendations(sourceKey, delta, analysis) {
  if (!delta) return;
  if (delta.pct_gzip != null && delta.pct_gzip > 15) {
    report.recommendations.push({
      source: sourceKey,
      level: "high",
      message: `Crecimiento gzip +${delta.pct_gzip}% — evaluar deduplicar strings repetidos en cliente o vista materializada de tags.`,
    });
  } else if (delta.pct_gzip != null && delta.pct_gzip > 8) {
    report.recommendations.push({
      source: sourceKey,
      level: "medium",
      message: `Crecimiento gzip +${delta.pct_gzip}% — monitorear en 4G; compresión HTTP ya activa.`,
    });
  }
  if (analysis?.looksLikeSerialized > 0) {
    report.recommendations.push({
      source: sourceKey,
      level: "warn",
      message: `${analysis.looksLikeSerialized} filas con DetallesSimilitud que parecen JSON serializado — revisar origen.`,
    });
  }
  if (analysis?.duplicateDetallesRows > analysis?.uniqueDetallesStrings * 5) {
    report.recommendations.push({
      source: sourceKey,
      level: "medium",
      message: "Muchas filas repiten el mismo string DetallesSimilitud (variantes) — normal; gzip lo comprime bien.",
    });
  }
  if (analysis?.max_detalles_len > 200) {
    report.recommendations.push({
      source: sourceKey,
      level: "low",
      message: `Detalles largos (max ${analysis.max_detalles_len} chars) — considerar tope soft en admin si crece.`,
    });
  }
}

async function measureSource({ key, table }) {
  console.log(`\n--- ${key} ---`);

  const without = await fetchAllRows(table, SELECT_WITHOUT_DETALLES);
  if (!without.ok) {
    console.log(`  baseline FAIL: ${without.error?.status || "DetallesSimilitud missing?"}`);
    report.sources[key] = { error: without.error || "baseline_failed" };
    return;
  }

  const withCol = await fetchAllRows(table, SELECT_WITH_DETALLES);
  let afterRows = withCol.rows;
  let simulated = false;

  if (!withCol.ok && withCol.missingDetalles) {
    console.log("  columna DetallesSimilitud ausente → simulación desde product_tag_details");
    const map = await buildSimulatedDetallesMap();
    report.simulatedDetalles = { articulos: map.size };
    afterRows = applySimulatedDetalles(without.rows, map);
    simulated = true;
  } else if (!withCol.ok) {
    console.log(`  with-column FAIL: ${JSON.stringify(withCol.error)}`);
    report.sources[key] = { error: withCol.error };
    return;
  }

  const beforeMetrics = await measurePayload("sin_DetallesSimilitud", without.rows, without.transferBytes);
  const afterMetrics = simulated
    ? await measurePayload("con_DetallesSimilitud_simulado", afterRows, without.transferBytes)
    : await measurePayload("con_DetallesSimilitud", afterRows, withCol.transferBytes);

  const delta = compareBeforeAfter(beforeMetrics, afterMetrics);
  const analysis = analyzeDetallesField(afterRows);

  printTable(`${key} — ANTES`, beforeMetrics);
  printTable(`${key} — DESPUÉS${simulated ? " (simulado)" : ""}`, afterMetrics);
  if (delta) {
    console.log(
      `  Δ JSON: +${delta.delta_kb_json} KB (${delta.pct_json}%) | Δ gzip: +${delta.delta_kb_gzip} KB (${delta.pct_gzip}%) | Δ transfer: +${delta.delta_kb_transfer} KB`
    );
    console.log(`  Δ bytes/fila json: +${delta.delta_bytes_per_row}`);
  }

  console.log("\n  Análisis DetallesSimilitud:");
  console.log(
    `    con valor: ${analysis.withDetalles} | vacío: ${analysis.emptyDetalles} | strings únicos: ${analysis.uniqueDetallesStrings}`
  );
  console.log(
    `    = Filtro3: ${analysis.detallesEqualsFiltro3} | parece JSON: ${analysis.looksLikeSerialized} | p95 len: ${analysis.p95_detalles_len}`
  );
  if (analysis.top_heavy_by_detalles[0]) {
    console.log("    Top detalle largo:", analysis.top_heavy_by_detalles[0]);
  }

  report.sources[key] = {
    simulated,
    estimatedTotalRows: without.total,
    before: beforeMetrics,
    after: afterMetrics,
    delta,
    analysis,
  };

  addRecommendations(key, delta, analysis);
}

async function main() {
  if (!ANON) {
    console.error("Falta SUPABASE_ANON_KEY");
    process.exit(1);
  }

  console.log(`Medición payload catálogo → ${SUPABASE_URL}`);
  console.log(
    FETCH_ALL ? "Modo: TODAS las filas" : `Modo: muestra hasta ${MAX_ROWS || "∞"} filas`
  );

  for (const src of SOURCES) {
    await measureSource(src);
  }

  if (report.recommendations.length) {
    console.log("\n=== Recomendaciones ===");
    for (const r of report.recommendations) {
      console.log(`  [${r.level}] ${r.source}: ${r.message}`);
    }
  }

  if (WRITE_REPORT) {
    const out = path.join(__dirname, "outputs", "catalog-payload-measurement.json");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(`\nReporte: ${out}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
