#!/usr/bin/env node
// gz-agent/scripts/patch-base-icon.js
// pkg-fetch busca primero el binario "fetched-*" en su caché: si existe y su
// hash coincide con la lista fija de pkg, lo usa directo y NUNCA mira el
// binario "built-*" (que es la variante que no valida hash, pensada para
// binarios "compilados localmente"). Para que use nuestra copia con el
// ícono aplicado hay que:
//   1) guardar una copia limpia del binario original (fuera de la caché de
//      pkg, para no tener que volver a descargarlo en el próximo build),
//   2) copiar esa copia limpia a la ruta "built-*" y aplicarle el ícono con
//      rcedit ahí,
//   3) sacar el "fetched-*" de la caché de pkg para que cuando pkg pregunte
//      si existe, la respuesta sea "no" y caiga a usar "built-*".
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");
const { rcedit } = require("rcedit");

const ROOT = path.join(__dirname, "..");
const ICON_PATH = path.join(ROOT, "assets", "icon.ico");
const CLEAN_BACKUP_DIR = path.join(os.tmpdir(), "gz-agent-pkg-base-backup");

function findCachedFile(prefix) {
  const cacheRoot = path.join(os.homedir(), ".pkg-cache");
  if (!fs.existsSync(cacheRoot)) return null;
  const out = execSync(
    `powershell -NoProfile -Command "Get-ChildItem -Path '${cacheRoot}' -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '${prefix}-*win-x64*' } | Select-Object -ExpandProperty FullName"`,
    { encoding: "utf8" }
  ).trim();
  if (!out) return null;
  return out.split(/\r?\n/)[0].trim();
}

async function main() {
  fs.mkdirSync(CLEAN_BACKUP_DIR, { recursive: true });

  const fetchedPath = findCachedFile("fetched");
  let cleanName;
  let cleanBackupPath;

  if (fetchedPath) {
    cleanName = path.basename(fetchedPath);
    cleanBackupPath = path.join(CLEAN_BACKUP_DIR, cleanName);
    if (!fs.existsSync(cleanBackupPath)) {
      fs.copyFileSync(fetchedPath, cleanBackupPath);
      console.log("Backup del binario base limpio:", cleanBackupPath);
    }
  } else {
    const existingBackups = fs.readdirSync(CLEAN_BACKUP_DIR);
    if (existingBackups.length === 0) {
      throw new Error(
        "No se encontró el binario base de pkg (ni en caché ni backup). Corré `npx pkg .` una vez primero para que lo descargue, después volvé a correr este script."
      );
    }
    cleanName = existingBackups[0];
    cleanBackupPath = path.join(CLEAN_BACKUP_DIR, cleanName);
  }

  const cacheDir = path.dirname(fetchedPath || findCachedFile("built") || "");
  const builtName = cleanName.replace(/^fetched-/, "built-");
  const builtPath = path.join(cacheDir, builtName);

  fs.copyFileSync(cleanBackupPath, builtPath);
  await rcedit(builtPath, { icon: ICON_PATH });
  console.log("✓ Ícono aplicado en binario base local:", builtPath);

  if (fetchedPath && fs.existsSync(fetchedPath)) {
    fs.unlinkSync(fetchedPath);
    console.log("  'fetched-*' removido de la caché para forzar el uso de 'built-*'.");
  }
}

main().catch((err) => {
  console.error("Error parcheando ícono del binario base:", err.message);
  process.exit(1);
});
