#!/usr/bin/env node
/**
 * Smoke estático: separación física curated vs legacy (sin coexistencia runtime).
 * node scripts/smoke-curated-banner-legacy-guard.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const customBanner = readFileSync(join(root, "scripts/custom-banner.js"), "utf8");
const curatedBanner = readFileSync(join(root, "scripts/curated-banner.js"), "utf8");
const loader = readFileSync(join(root, "scripts/fyl-legacy-banner-loader.js"), "utf8");
const curatedLoader = readFileSync(join(root, "scripts/fyl-curated-banner-loader.js"), "utf8");
const indexHtml = readFileSync(join(root, "index.html"), "utf8");
const catalogoHtml = readFileSync(join(root, "catalogo.html"), "utf8");
const mainSupabase = readFileSync(join(root, "scripts/main-supabase.js"), "utf8");

const checks = [
  {
    name: "index.html: sin script directo custom-banner.js",
    ok: !/src="scripts\/custom-banner\.js/.test(indexHtml),
  },
  {
    name: "index.html: usa fyl-legacy-banner-loader.js",
    ok: /fyl-legacy-banner-loader\.js/.test(indexHtml),
  },
  {
    name: "catalogo.html: sin script directo custom-banner.js",
    ok: !/src="scripts\/custom-banner\.js/.test(catalogoHtml),
  },
  {
    name: "catalogo.html: usa fyl-legacy-banner-loader.js",
    ok: /fyl-legacy-banner-loader\.js/.test(catalogoHtml),
  },
  {
    name: "loader: import condicional si flag OFF",
    ok:
      /FYL_CURATED_BANNER_V1 !== true/.test(loader) &&
      /import\(/.test(loader) &&
      /custom-banner\.js/.test(loader),
  },
  {
    name: "index.html: sin script directo curated-banner.js",
    ok: !/src="scripts\/curated-banner\.js/.test(indexHtml),
  },
  {
    name: "index.html: usa fyl-curated-banner-loader.js",
    ok: /fyl-curated-banner-loader\.js/.test(indexHtml),
  },
  {
    name: "catalogo.html: sin script directo curated-banner.js",
    ok: !/src="scripts\/curated-banner\.js/.test(catalogoHtml),
  },
  {
    name: "catalogo.html: usa fyl-curated-banner-loader.js",
    ok: /fyl-curated-banner-loader\.js/.test(catalogoHtml),
  },
  {
    name: "curated-loader: import dinámico solo si flag ON",
    ok:
      /FYL_CURATED_BANNER_V1 === true/.test(curatedLoader) &&
      /import\(/.test(curatedLoader) &&
      /curated-banner\.js/.test(curatedLoader),
  },
  {
    name: "custom-banner: sin guards runtime curated",
    ok:
      !/isLegacyCustomBannerDisabled/.test(customBanner) &&
      !/applyLegacyCustomBannerWindowStubs/.test(customBanner) &&
      !/legacyBannerNoop/.test(customBanner),
  },
  {
    name: "curated-banner: no importa custom-banner.js",
    ok: !/from\s+["']\.\/custom-banner\.js["']/.test(curatedBanner),
  },
  {
    name: "curated-banner: sin stubs legacy",
    ok: !/applyLegacyCustomBannerWindowStubs/.test(curatedBanner),
  },
  {
    name: "main-supabase: sin __FYL_LEGACY_CUSTOM_BANNER_DISABLED",
    ok: !/__FYL_LEGACY_CUSTOM_BANNER_DISABLED/.test(mainSupabase),
  },
  {
    name: "main-supabase: sin LEGACY_FALLBACK en fylLoadHomeProductBanner",
    ok: !/FYL_CURATED_BANNER_LEGACY_FALLBACK/.test(
      mainSupabase.slice(
        mainSupabase.indexOf("async function fylLoadHomeProductBanner"),
        mainSupabase.indexOf("function fylHideProductBanner")
      )
    ),
  },
  {
    name: "custom-banner: excluye filas __curated__ en config legacy",
    ok: /\.neq\("tag_value", CURATED_TAG_PLACEHOLDER\)/.test(customBanner),
  },
  {
    name: "custom-banner: maybeSingle en loadCustomBannerConfig (sin 406)",
    ok: /loadCustomBannerConfig[\s\S]*?\.maybeSingle\(\)/.test(customBanner),
  },
  {
    name: "curated-banner: maybeSingle en loadCuratedBannerConfig",
    ok: /\.limit\(1\)\s*\n\s*\.maybeSingle\(\)/.test(curatedBanner),
  },
];

let failed = 0;
for (const c of checks) {
  const status = c.ok ? "OK" : "FAIL";
  console.log(`[${status}] ${c.name}`);
  if (!c.ok) failed += 1;
}

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll physical-separation checks passed.");
