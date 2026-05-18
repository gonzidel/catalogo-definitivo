#!/usr/bin/env node
/**
 * Smoke: admin curated debe persistir tag_filter = '__curated__' (NOT NULL en BD).
 *
 *   node scripts/smoke-curated-banner-admin-tag-filter.mjs
 *   node scripts/smoke-curated-banner-admin-tag-filter.mjs --report
 *
 * Con evidencia staging (readonly):
 *   $env:SUPABASE_ANON_KEY="..."
 *   node scripts/smoke-curated-banner-admin-tag-filter.mjs --staging
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WRITE_REPORT = process.argv.includes("--report");
const WITH_STAGING = process.argv.includes("--staging");

const SUPABASE_URL = (process.env.SUPABASE_URL || "https://dtfznewwvsadkorxwzft.supabase.co").replace(
  /\/$/,
  ""
);
const ANON = process.env.SUPABASE_ANON_KEY || "";

const evidence = {
  generatedAt: new Date().toISOString(),
  fix: "curated admin tag_filter = __curated__",
  checks: [],
  summary: { pass: 0, fail: 0, warn: 0 },
};

function record(name, status, detail) {
  evidence.checks.push({ name, status, detail });
  if (status === "PASS") evidence.summary.pass += 1;
  else if (status === "FAIL") evidence.summary.fail += 1;
  else evidence.summary.warn += 1;
  console.log(`[${status === "PASS" ? "OK" : status === "FAIL" ? "FAIL" : "WARN"}] ${name}`, detail || "");
}

function readAdminSource() {
  return fs.readFileSync(path.join(__dirname, "../admin/curated-banner-admin.js"), "utf8");
}

function checkSourcePayload() {
  const src = readAdminSource();
  if (!src.includes("CURATED_LEGACY_TAG_FIELDS")) {
    record("source_CURATED_LEGACY_TAG_FIELDS", "FAIL", { message: "constante ausente" });
    return;
  }
  record("source_CURATED_LEGACY_TAG_FIELDS", "PASS", null);

  if (/tag_filter:\s*null/.test(src)) {
    record("source_no_tag_filter_null", "FAIL", { message: "aún persiste tag_filter: null" });
  } else {
    record("source_no_tag_filter_null", "PASS", null);
  }

  const blockMatch = src.match(/CURATED_LEGACY_TAG_FIELDS\s*=\s*\{([^}]+)\}/);
  if (!blockMatch) {
    record("source_tag_fields_block", "FAIL", null);
    return;
  }
  const block = blockMatch[1];
  const hasValue = /tag_value:\s*LEGACY_TAG_PLACEHOLDER/.test(block);
  const hasFilter = /tag_filter:\s*LEGACY_TAG_PLACEHOLDER/.test(block);
  record(
    "source_tag_value_placeholder",
    hasValue ? "PASS" : "FAIL",
    hasValue ? null : { block: block.trim() }
  );
  record(
    "source_tag_filter_placeholder",
    hasFilter ? "PASS" : "FAIL",
    hasFilter ? null : { block: block.trim() }
  );

  if (src.includes("...CURATED_LEGACY_TAG_FIELDS")) {
    record("source_bannerPayload_spread", "PASS", null);
  } else {
    record("source_bannerPayload_spread", "FAIL", { message: "bannerPayload no usa spread" });
  }
}

async function checkStagingReadonly() {
  if (!ANON) {
    record("staging_schema", "WARN", { message: "SUPABASE_ANON_KEY no definida" });
    return;
  }
  const headers = {
    apikey: ANON,
    authorization: `Bearer ${ANON}`,
    accept: "application/json",
  };
  const legacy = await fetch(
    `${SUPABASE_URL}/rest/v1/custom_product_banners?select=id,name,tag_value,tag_filter,enabled&tag_value=neq.__curated__&limit=3`,
    { headers }
  );
  const legacyBody = await legacy.json();
  if (!legacy.ok) {
    record("staging_legacy_banners_read", "WARN", { status: legacy.status, body: legacyBody });
  } else {
    const rows = Array.isArray(legacyBody) ? legacyBody : [];
    record("staging_legacy_banners_read", "PASS", { count: rows.length, sample: rows[0] || null });
    const badLegacy = rows.filter((r) => r.tag_filter == null);
    if (badLegacy.length) {
      record("staging_legacy_tag_filter_populated", "WARN", { nullTagFilter: badLegacy.length });
    } else if (rows.length) {
      record("staging_legacy_tag_filter_populated", "PASS", { note: "legacy con tag_filter presente" });
    }
  }

  const curated = await fetch(
    `${SUPABASE_URL}/rest/v1/custom_product_banners?select=id,tag_value,tag_filter&tag_value=eq.__curated__&limit=5`,
    { headers }
  );
  const curatedBody = await curated.json();
  if (!curated.ok) {
    record("staging_curated_banners_read", "WARN", { status: curated.status });
  } else {
    const rows = Array.isArray(curatedBody) ? curatedBody : [];
    record("staging_curated_banners_read", "PASS", { count: rows.length });
    const bad = rows.filter((r) => r.tag_filter !== "__curated__");
    record(
      "staging_curated_tag_filter_eq_placeholder",
      rows.length === 0 ? "WARN" : bad.length === 0 ? "PASS" : "FAIL",
      { total: rows.length, bad: bad.map((r) => ({ id: r.id, tag_filter: r.tag_filter })) }
    );
  }
}

async function main() {
  checkSourcePayload();
  if (WITH_STAGING) await checkStagingReadonly();

  const outPath = path.join(__dirname, "outputs", "phase2-curated-admin-tag-filter-evidence.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(evidence, null, 2));
  console.log("\nResumen:", evidence.summary);
  console.log("Evidence:", outPath);
  if (WRITE_REPORT) console.log(JSON.stringify(evidence, null, 2));
  process.exit(evidence.summary.fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
