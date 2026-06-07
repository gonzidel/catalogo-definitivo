import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const __repoRoot = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const out = { mode: "prod", version: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mode" && argv[i + 1]) out.mode = String(argv[++i]);
    else if (a === "--version" && argv[i + 1]) out.version = String(argv[++i]);
    else if (a === "--dry-run") out.dryRun = true;
  }
  return out;
}

function readProdVersionFromFile() {
  const p = path.join(__repoRoot, "app-version.json");
  const raw = fs.readFileSync(p, "utf8");
  const data = JSON.parse(raw);
  if (!data || typeof data.prod !== "string" || !data.prod.trim()) {
    throw new Error("app-version.json debe tener { \"prod\": \"...\" }");
  }
  return data.prod.trim();
}

function getVersion({ mode, versionOverride }) {
  if (versionOverride) return versionOverride;
  if (process.env.APP_VERSION && String(process.env.APP_VERSION).trim()) {
    return String(process.env.APP_VERSION).trim();
  }
  if (mode === "dev") {
    // Un valor único por corrida (ideal si lo ejecutás al levantar el server)
    return `t${Date.now()}`;
  }
  return readProdVersionFromFile();
}

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".cursor",
  ".claude",
  "supabase",
  "cloudinary-optimize",
  "terminals",
  "agent-transcripts",
  "history",
]);

function shouldSkipDir(name) {
  return SKIP_DIR_NAMES.has(name);
}

function relFromRoot(absPath) {
  return path.relative(__repoRoot, absPath).split(path.sep).join("/");
}

function walkHtmlFiles(dir) {
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (shouldSkipDir(ent.name)) continue;
      out.push(...walkHtmlFiles(p));
      continue;
    }
    if (ent.isFile() && ent.name.toLowerCase().endsWith(".html")) out.push(p);
  }
  return out;
}

function patchHtmlContents(html, version) {
  let next = html;

  // Reemplaza cualquier ?v=... por ?v=<version> (tu patrón actual)
  next = next.replace(/\?v=[a-zA-Z0-9._-]+/g, `?v=${version}`);

  // Mantener alineado el meta que ya usás como “app-version” (index.html)
  next = next.replace(
    /(<meta\s+name=["']app-version["']\s+content=["'])[a-zA-Z0-9._-]+(["']\s*\/?>)/i,
    `$1${version}$2`
  );

  next = ensureVendorSupabaseScript(next, version);

  return next;
}

/**
 * Inserta `<script defer src="(...)scripts/vendor/supabase-js.bundle.min.js?v=...">`
 * justo antes del primer `<script type="module" src=".../supabase-client.js?...">`
 * cuando todavía no existe esa línea. El path relativo (scripts/... vs ../scripts/...)
 * se infiere del src del módulo de supabase-client. Idempotente: si ya está, no hace nada.
 */
function ensureVendorSupabaseScript(html, version) {
  if (html.includes("scripts/vendor/supabase-js.bundle.min.js")) {
    return html.replace(
      /(<script[^>]*src=["'])([^"']*scripts\/vendor\/supabase-js\.bundle\.min\.js)(\?[^"']*)?(["'][^>]*>)/g,
      (_m, pre, base, _q, post) => `${pre}${base}?v=${version}${post}`
    );
  }
  const moduleRe = /<script\s+type=["']module["']\s+src=["']([^"']*scripts\/supabase-client\.js[^"']*)["'][^>]*><\/script>/i;
  const match = html.match(moduleRe);
  if (!match) return html;
  const moduleSrc = match[1];
  const prefix = moduleSrc.startsWith("../") ? "../" : "";
  const vendorSrc = `${prefix}scripts/vendor/supabase-js.bundle.min.js?v=${version}`;
  const indent = (() => {
    const idx = html.indexOf(match[0]);
    if (idx < 0) return "";
    const lineStart = html.lastIndexOf("\n", idx - 1);
    return html.slice(lineStart + 1, idx).match(/^[ \t]*/)[0] || "";
  })();
  const inject = `<script defer src="${vendorSrc}"></script>\n${indent}`;
  return html.replace(moduleRe, inject + match[0]);
}

function patchServiceWorker(sw, version) {
  let next = sw;

  // Formato antiguo: const CACHE_NAME = "fyl-catalog-...";
  next = next.replace(
    /const\s+CACHE_NAME\s*=\s*["']fyl-catalog-[a-zA-Z0-9._-]+["']\s*;/,
    `const CACHE_NAME = "fyl-catalog-${version}";`
  );

  // Formato actual: fallback si sw.js se sirve sin ?v=
  next = next.replace(
    /\.get\("v"\)\s*\|\|\s*"[^"]*"/,
    `.get("v") || "${version}"`
  );

  // Tombstone SW: byte-diff garantizado para que Safari detecte update.
  next = next.replace(
    /const\s+SW_BUILD_TAG\s*=\s*"[^"]*"\s*;/,
    `const SW_BUILD_TAG = "${version}";`
  );

  return next;
}

function patchPwaInstall(js, version) {
  return js.replace(
    /const\s+SW_VERSION\s*=\s*["'][^"']*["']\s*;/,
    `const SW_VERSION = "${version}";`
  );
}

function patchQueryVersionsInFile(contents, version) {
  let next = contents.replace(/\?v=[a-zA-Z0-9._-]+/g, `?v=${version}`);
  return next;
}

// Relative ESM import/export specifiers (static, side-effect y dinámicos).
// Garantiza que TODO import relativo lleve ?v=<version> para que un módulo de
// entrada nuevo nunca cargue una dependencia vieja cacheada (version skew) y
// para que cada módulo resuelva siempre a la misma URL (una sola instancia).
// Se ancla en las keywords `from`/`import` para no tocar strings arbitrarios.
// No toca specifiers con backticks (imports dinámicos versionados en runtime),
// rutas no relativas, ni paquetes bare.
const REL_IMPORT_SPEC_RE =
  /(\b(?:from|import)\s*\(?\s*)(["'])(\.\.?\/[^"'?#\s]+\.m?js)(?:[?#][^"']*)?\2/g;

function patchImportSpecifiers(contents, version) {
  return contents.replace(
    REL_IMPORT_SPEC_RE,
    (_m, pre, quote, spec) => `${pre}${quote}${spec}?v=${version}${quote}`
  );
}

function patchFylVersionExport(contents, version) {
  return contents.replace(
    /export const FYL_VERSION = "[^"]*";/,
    `export const FYL_VERSION = "${version}";`
  );
}

const EXTRA_VERSIONED_FILES = [
  "scripts/main-supabase.js",
  "scripts/catalog-cache.js",
  "scripts/catalog-source.js",
  "scripts/fyl-runtime-resilience.js",
  "scripts/fyl-error-classify.js",
  "scripts/fyl-env-tags.js",
  "scripts/fyl-resource-error-diagnostics.js",
  "scripts/config.js",
  "scripts/supabase-client.js",
  "scripts/boot-telemetry.js",
  "scripts/net/fyl-fetch.js",
  "scripts/curated-banner.js",
  "scripts/fyl-originals-banner.js",
  "scripts/fyl-curated-banner-loader.js",
  "scripts/size-filter.js",
  "scripts/utils/size-normalizer.js",
  "admin/stock.js",
];

function walkJsFilesUnder(relDir) {
  const root = path.join(__repoRoot, relDir);
  if (!fs.existsSync(root)) return [];
  const out = [];
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (shouldSkipDir(ent.name)) continue;
        walk(p);
        continue;
      }
      if (ent.isFile() && ent.name.endsWith(".js")) out.push(p);
    }
  }
  walk(root);
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.mode === "dev" ? "dev" : "prod";
  const version = getVersion({ mode, versionOverride: args.version });

  const htmlFiles = walkHtmlFiles(__repoRoot);
  let htmlChanged = 0;
  const changedPaths = [];

  for (const file of htmlFiles) {
    const rel = relFromRoot(file);
    const prev = fs.readFileSync(file, "utf8");
    let next = patchHtmlContents(prev, version);
    // Admin se sirve no-cache (sin skew posible): no tocamos sus imports.
    if (!rel.startsWith("admin/")) {
      next = patchImportSpecifiers(next, version);
    }
    if (next !== prev) {
      htmlChanged++;
      changedPaths.push(rel);
      if (!args.dryRun) fs.writeFileSync(file, next, "utf8");
    }
  }

  const swPath = path.join(__repoRoot, "sw.js");
  let swChanged = false;
  if (fs.existsSync(swPath)) {
    const prevSw = fs.readFileSync(swPath, "utf8");
    const nextSw = patchServiceWorker(prevSw, version);
    if (nextSw !== prevSw) {
      swChanged = true;
      changedPaths.push("sw.js");
      if (!args.dryRun) fs.writeFileSync(swPath, nextSw, "utf8");
    }
  }

  const pwaPath = path.join(__repoRoot, "scripts", "pwa-install.js");
  let pwaChanged = false;
  if (fs.existsSync(pwaPath)) {
    const prevPwa = fs.readFileSync(pwaPath, "utf8");
    const nextPwa = patchPwaInstall(prevPwa, version);
    if (nextPwa !== prevPwa) {
      pwaChanged = true;
      changedPaths.push("scripts/pwa-install.js");
      if (!args.dryRun) fs.writeFileSync(pwaPath, nextPwa, "utf8");
    }
  }

  const fylVersionPath = path.join(__repoRoot, "scripts", "fyl-version.js");
  let fylVersionChanged = false;
  if (fs.existsSync(fylVersionPath)) {
    const prevFv = fs.readFileSync(fylVersionPath, "utf8");
    const nextFv = patchFylVersionExport(prevFv, version);
    if (nextFv !== prevFv) {
      fylVersionChanged = true;
      changedPaths.push("scripts/fyl-version.js");
      if (!args.dryRun) fs.writeFileSync(fylVersionPath, nextFv, "utf8");
    }
  }

  let extraChanged = 0;
  for (const rel of EXTRA_VERSIONED_FILES) {
    const fp = path.join(__repoRoot, rel);
    if (!fs.existsSync(fp)) continue;
    const prev = fs.readFileSync(fp, "utf8");
    const next = patchQueryVersionsInFile(prev, version);
    if (next !== prev) {
      extraChanged++;
      changedPaths.push(rel.replace(/\\/g, "/"));
      if (!args.dryRun) fs.writeFileSync(fp, next, "utf8");
    }
  }

  let adminJsChanged = 0;
  for (const file of walkJsFilesUnder("admin")) {
    const prev = fs.readFileSync(file, "utf8");
    if (!/\?v=[a-zA-Z0-9._-]+/.test(prev)) continue;
    const next = patchQueryVersionsInFile(prev, version);
    if (next !== prev) {
      adminJsChanged++;
      changedPaths.push(relFromRoot(file));
      if (!args.dryRun) fs.writeFileSync(file, next, "utf8");
    }
  }

  // Versionado de imports relativos en TODO el grafo público (scripts/ + client/).
  // Elimina la clase de bug de "version skew": un módulo de entrada nuevo nunca
  // importa una dependencia vieja cacheada, y cada módulo resuelve a una sola URL.
  let importSpecChanged = 0;
  const importSpecRoots = ["scripts", "client"];
  for (const root of importSpecRoots) {
    for (const file of walkJsFilesUnder(root)) {
      const rel = relFromRoot(file);
      // Saltar bundles vendorizados (no son ESM con imports relativos).
      if (rel.includes("/vendor/")) continue;
      const prev = fs.readFileSync(file, "utf8");
      const next = patchImportSpecifiers(prev, version);
      if (next !== prev) {
        importSpecChanged++;
        changedPaths.push(rel);
        if (!args.dryRun) fs.writeFileSync(file, next, "utf8");
      }
    }
  }

  const totalTouched =
    htmlChanged +
    (swChanged ? 1 : 0) +
    (pwaChanged ? 1 : 0) +
    (fylVersionChanged ? 1 : 0) +
    extraChanged +
    adminJsChanged +
    importSpecChanged;
  const suffix = args.dryRun ? " (dry-run, sin escritura)" : "";

  console.log(
    `✅ cache-bust (${mode}) -> v=${version}${suffix}\n` +
      `   HTML escaneados: ${htmlFiles.length} (incluye admin/**; excluye history/**)\n` +
      `   HTML a actualizar: ${htmlChanged}\n` +
      `   sw.js: ${swChanged ? "sí" : "no"} | pwa-install.js: ${pwaChanged ? "sí" : "no"} | fyl-version.js: ${
        fylVersionChanged ? "sí" : "no"
      } | JS extra: ${extraChanged}/${EXTRA_VERSIONED_FILES.length} | admin JS: ${adminJsChanged} | imports versionados: ${importSpecChanged}\n` +
      `   ARCHIVOS FINALES A TOCAR: ${totalTouched}`
  );

  if (args.dryRun && changedPaths.length > 0 && changedPaths.length <= 40) {
    console.log(`   Rutas: ${changedPaths.join(", ")}`);
  } else if (args.dryRun && changedPaths.length > 40) {
    console.log(`   Rutas (primeras 20): ${changedPaths.slice(0, 20).join(", ")} … +${changedPaths.length - 20}`);
  }
}

main();

