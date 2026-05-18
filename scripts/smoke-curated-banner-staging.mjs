#!/usr/bin/env node
/**
 * Smoke read-only: curated banner (staging).
 *   $env:SUPABASE_ANON_KEY="..."
 *   node scripts/smoke-curated-banner-staging.mjs
 *   node scripts/smoke-curated-banner-staging.mjs --report
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WRITE_REPORT = process.argv.includes("--report");

const SUPABASE_URL = (process.env.SUPABASE_URL || "https://dtfznewwvsadkorxwzft.supabase.co").replace(
  /\/$/,
  ""
);
const ANON = process.env.SUPABASE_ANON_KEY || "";

if (process.env.FYL_AUDIT_INSECURE_TLS === "1") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

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
  return { status: res.status, body };
}

function record(name, status, detail) {
  evidence.checks.push({ name, status, detail });
  if (status === "PASS") evidence.summary.pass += 1;
  else if (status === "FAIL") evidence.summary.fail += 1;
  else evidence.summary.warn += 1;
  const icon = status === "PASS" ? "OK" : status === "FAIL" ? "FAIL" : "WARN";
  console.log(`[${icon}] ${name}`, detail ? JSON.stringify(detail) : "");
}

async function main() {
  if (!ANON) {
    console.error("Falta SUPABASE_ANON_KEY");
    process.exit(2);
  }

  const banners = await restGet(
    "/custom_product_banners?select=id,title,slug,enabled,tag_value,sort_order,custom_product_banner_items(product_variant_id,position)&enabled=eq.true&tag_value=eq.__curated__&order=sort_order.asc&limit=5"
  );
  if (banners.status !== 200) {
    record("curated_banners_list", "FAIL", { status: banners.status, body: banners.body });
  } else {
    const rows = Array.isArray(banners.body) ? banners.body : [];
    record("curated_banners_list", rows.length ? "PASS" : "WARN", { count: rows.length });
    const first = rows[0];
    if (first?.custom_product_banner_items?.length) {
      const variantIds = first.custom_product_banner_items
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        .map((i) => i.product_variant_id)
        .filter(Boolean);
      const inList = variantIds.slice(0, 12).join(",");
      const cat = await restGet(
        `/catalog_public_available_view?select=variant_id,Articulo,Mostrar&variant_id=in.(${inList})&limit=20`
      );
      record("catalog_available_variant_id", cat.status === 200 ? "PASS" : "FAIL", {
        status: cat.status,
        rows: Array.isArray(cat.body) ? cat.body.length : 0,
      });
      const snap = await restGet(
        `/catalog_public_snapshot?select=variant_id,Articulo&variant_id=in.(${inList})&limit=20`
      );
      record("catalog_snapshot_variant_id", snap.status === 200 ? "PASS" : "FAIL", {
        status: snap.status,
        rows: Array.isArray(snap.body) ? snap.body.length : 0,
      });
      const skus = await restGet(`/product_variants?select=id,sku&id=in.(${inList})&limit=20`);
      record("product_variants_sku", skus.status === 200 ? "PASS" : "FAIL", {
        status: skus.status,
        withSku: (skus.body || []).filter((r) => r.sku).length,
      });
      if (first.slug) {
        const slugRow = await restGet(
          `/custom_product_banners?select=id,slug&slug=eq.${encodeURIComponent(first.slug)}&enabled=eq.true&limit=1`
        );
        record("banner_slug_lookup", slugRow.status === 200 && slugRow.body?.[0] ? "PASS" : "FAIL", {
          slug: first.slug,
        });
      }
    } else {
      record("curated_items", "WARN", { message: "sin items en primer banner curated" });
    }
  }

  const outPath = path.join(__dirname, "outputs", "phase4-curated-banner-staging-evidence.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(evidence, null, 2));
  console.log("\nResumen:", evidence.summary);
  console.log("Evidence:", outPath);
  if (WRITE_REPORT) {
    console.log(JSON.stringify(evidence, null, 2));
  }
  process.exit(evidence.summary.fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
