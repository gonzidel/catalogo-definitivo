#!/usr/bin/env node
/**
 * Smoke: validación slug único en admin curated.
 *   node scripts/smoke-curated-banner-admin-slug.mjs
 *   node scripts/smoke-curated-banner-admin-slug.mjs --staging
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WITH_STAGING = process.argv.includes("--staging");
const SUPABASE_URL = (process.env.SUPABASE_URL || "https://dtfznewwvsadkorxwzft.supabase.co").replace(
  /\/$/,
  ""
);
const ANON = process.env.SUPABASE_ANON_KEY || "";

const evidence = {
  generatedAt: new Date().toISOString(),
  checks: [],
  summary: { pass: 0, fail: 0, warn: 0 },
};

function record(name, status, detail = null) {
  evidence.checks.push({ name, status, detail });
  if (status === "PASS") evidence.summary.pass += 1;
  else if (status === "FAIL") evidence.summary.fail += 1;
  else evidence.summary.warn += 1;
  console.log(`[${status === "PASS" ? "OK" : status === "FAIL" ? "FAIL" : "WARN"}] ${name}`, detail || "");
}

function checkSource() {
  const src = fs.readFileSync(path.join(__dirname, "../admin/curated-banner-admin.js"), "utf8");
  const required = [
    "isSlugTaken",
    "resolveAvailableSlug",
    "validateSlugState",
    "cba-slug-error",
    "cba-editor-submit",
    "Este slug ya existe",
    '.eq("slug"',
    '.neq("id"',
  ];
  for (const token of required) {
    record(`source_${token.replace(/[^a-z0-9]+/gi, "_")}`, src.includes(token) ? "PASS" : "FAIL");
  }
  record("source_syncSubmitButton", src.includes("syncSubmitButton") ? "PASS" : "FAIL");
}

async function checkStaging() {
  if (!ANON) {
    record("staging_slugs", "WARN", { message: "SUPABASE_ANON_KEY missing" });
    return;
  }
  const headers = { apikey: ANON, authorization: `Bearer ${ANON}`, accept: "application/json" };
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/custom_product_banners?select=id,slug&slug=not.is.null&order=slug.asc&limit=20`,
    { headers }
  );
  const body = await res.json();
  if (!res.ok) {
    record("staging_slug_list", "WARN", { status: res.status, body });
    return;
  }
  const rows = Array.isArray(body) ? body : [];
  const slugs = rows.map((r) => r.slug).filter(Boolean);
  const dupes = slugs.filter((s, i) => slugs.indexOf(s) !== i);
  record("staging_slug_list", "PASS", { count: rows.length, sample: slugs.slice(0, 5) });
  record("staging_no_duplicate_slugs_in_sample", dupes.length ? "FAIL" : "PASS", { dupes });
}

async function main() {
  checkSource();
  if (WITH_STAGING) await checkStaging();
  const out = path.join(__dirname, "outputs", "phase2-curated-admin-slug-evidence.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(evidence, null, 2));
  console.log("\nResumen:", evidence.summary);
  console.log("Evidence:", out);
  process.exit(evidence.summary.fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
