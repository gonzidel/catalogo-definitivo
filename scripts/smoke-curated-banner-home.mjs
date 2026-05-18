#!/usr/bin/env node
/**
 * Smoke home curated banner (anon, misma query que loadCuratedBannerConfig).
 *   $env:SUPABASE_ANON_KEY="..."
 *   node scripts/smoke-curated-banner-home.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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

async function rest(path, { acceptObject = false } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: ANON,
      authorization: `Bearer ${ANON}`,
      accept: acceptObject ? "application/vnd.pgrst.object+json" : "application/json",
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { _raw: text?.slice(0, 400) };
  }
  return { status: res.status, body, url: `${SUPABASE_URL}/rest/v1/${path}` };
}

async function main() {
  if (!ANON) {
    console.error("Falta SUPABASE_ANON_KEY");
    process.exit(2);
  }

  const cfgPathMaybeSingle =
    "custom_product_banners?select=id,title,slug,enabled,tag_value,sort_order,custom_product_banner_items(product_variant_id,position)&enabled=eq.true&tag_value=eq.__curated__&order=sort_order.asc&limit=1";
  const cfgPathSingle406 =
    "custom_product_banners?select=id&enabled=eq.true&tag_value=eq.__curated__&limit=2";

  const cfg = await rest(cfgPathMaybeSingle, { acceptObject: true });
  evidence.network = {
    maybeSingle: { url: cfg.url, status: cfg.status },
  };

  if (cfg.status === 406) {
    record("loadCuratedBannerConfig_no_406", "FAIL", { status: 406, url: cfg.url });
  } else {
    record("loadCuratedBannerConfig_no_406", "PASS", { status: cfg.status });
  }

  const cfgMultiProbe = await rest(
    "custom_product_banners?select=id,sort_order&enabled=eq.true&tag_value=eq.__curated__&order=sort_order.asc&limit=5"
  );
  const enabledCurated = Array.isArray(cfgMultiProbe.body) ? cfgMultiProbe.body : [];
  evidence.network.enabledCuratedCount = enabledCurated.length;

  if (cfg.status !== 200 && cfg.status !== 204) {
    record("loadCuratedBannerConfig_anon", "FAIL", { status: cfg.status, body: cfg.body });
  } else {
    const row = cfg.body && !Array.isArray(cfg.body) ? cfg.body : null;
    record("loadCuratedBannerConfig_anon", row ? "PASS" : "WARN", {
      count: row ? 1 : 0,
      sort_order: row?.sort_order,
      multiEnabled: enabledCurated.length,
    });
    if (enabledCurated.length > 1 && row) {
      const lowest = enabledCurated[0]?.sort_order ?? 0;
      const picked = row.sort_order ?? 0;
      record(
        "multi_banner_picks_lowest_sort_order",
        picked === lowest ? "PASS" : "WARN",
        { picked, lowest, enabled: enabledCurated.length }
      );
    }
    const first = row;
    if (first) {
      const items = first.custom_product_banner_items || [];
      record("banner_items_embed", items.length ? "PASS" : "FAIL", { count: items.length });
      if (items.length) {
        const ids = items.map((i) => i.product_variant_id).filter(Boolean).slice(0, 12);
        const inList = ids.join(",");
        for (const table of ["catalog_public_snapshot", "catalog_public_available_view"]) {
          const cat = await rest(
            `${table}?select=variant_id,Articulo&variant_id=in.(${inList})&limit=20`
          );
          record(`catalog_${table}_variant_id`, cat.status === 200 ? "PASS" : "FAIL", {
            status: cat.status,
            rows: Array.isArray(cat.body) ? cat.body.length : 0,
            error: cat.status !== 200 ? cat.body : undefined,
          });
        }
        const skus = await rest(`product_variants?select=id,sku&id=in.(${inList})&limit=20`);
        record("product_variants_sku", skus.status === 200 ? "PASS" : "FAIL", {
          rows: Array.isArray(skus.body) ? skus.body.length : 0,
        });
      }
    }
  }

  const single406 = await rest(cfgPathSingle406, { acceptObject: true });
  evidence.network.singleWould406 = { url: single406.url, status: single406.status };
  record(
    "postgrest_single_with_multiple_rows",
    single406.status === 406 ? "PASS" : "WARN",
    { status: single406.status, note: "documenta por qué usamos maybeSingle+limit=1" }
  );

  const zeroRows = await rest(
    "custom_product_banners?select=id&enabled=eq.true&tag_value=eq.__curated___none__&order=sort_order.asc&limit=1"
  );
  evidence.network.zeroBanners = { url: zeroRows.url, status: zeroRows.status, count: Array.isArray(zeroRows.body) ? zeroRows.body.length : null };
  record(
    "zero_banners_no_crash",
    zeroRows.status === 200 && Array.isArray(zeroRows.body) && zeroRows.body.length === 0 ? "PASS" : "FAIL",
    { status: zeroRows.status, rows: Array.isArray(zeroRows.body) ? zeroRows.body.length : null }
  );

  const out = path.join(__dirname, "outputs", "phase3-curated-banner-home-evidence.json");
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
