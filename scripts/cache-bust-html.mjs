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

function shouldSkipDir(name) {
  return (
    name === "node_modules" ||
    name === ".git" ||
    name === ".cursor" ||
    name === "supabase" ||
    name === "cloudinary-optimize" ||
    name === "terminals" ||
    name === "agent-transcripts"
  );
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

  return next;
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

const EXTRA_VERSIONED_FILES = [
  "scripts/main-supabase.js",
];

function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.mode === "dev" ? "dev" : "prod";
  const version = getVersion({ mode, versionOverride: args.version });

  const htmlFiles = walkHtmlFiles(__repoRoot);
  let changed = 0;

  for (const file of htmlFiles) {
    const prev = fs.readFileSync(file, "utf8");
    const next = patchHtmlContents(prev, version);
    if (next !== prev) {
      changed++;
      if (!args.dryRun) fs.writeFileSync(file, next, "utf8");
    }
  }

  // También actualizar sw.js para que el SW rote el cache por versión
  const swPath = path.join(__repoRoot, "sw.js");
  let swChanged = false;
  if (fs.existsSync(swPath)) {
    const prevSw = fs.readFileSync(swPath, "utf8");
    const nextSw = patchServiceWorker(prevSw, version);
    if (nextSw !== prevSw) {
      swChanged = true;
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
      if (!args.dryRun) fs.writeFileSync(pwaPath, nextPwa, "utf8");
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
      if (!args.dryRun) fs.writeFileSync(fp, next, "utf8");
    }
  }

  console.log(
    `✅ cache-bust (${mode}) -> v=${version} | HTML: ${changed}/${htmlFiles.length} | sw.js: ${
      swChanged ? "sí" : "no"
    } | pwa-install.js: ${pwaChanged ? "sí" : "no"} | JS extra: ${extraChanged}`
  );
}

main();

