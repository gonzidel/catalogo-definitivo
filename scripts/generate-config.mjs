import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const __repoRoot = path.resolve(__dirname, "..");

/** Misma convención que deploy.ps1: líneas KEY=valor, # comentarios. No pisa variables ya definidas en el entorno. */
function loadEnvLocalFile() {
  const envPath = path.join(__repoRoot, ".env.local");
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    val = val.replace(/^["']|["']$/g, "");
    if (key && val !== "" && process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

loadEnvLocalFile();

// Limpiar las variables de entorno: remover comillas y espacios
let url = process.env.SUPABASE_URL;
let anon = process.env.SUPABASE_ANON_KEY;

// Remover comillas dobles o simples del inicio y final si existen
if (url) {
  url = url.trim().replace(/^["']|["']$/g, '');
}
if (anon) {
  anon = anon.trim().replace(/^["']|["']$/g, '');
}

// Validación mejorada de variables de entorno
if (!url || !anon) {
  console.error("❌ ERROR: Faltan variables de entorno requeridas.");
  console.error("");
  console.error("Las siguientes variables deben estar configuradas:");
  if (!url) {
    console.error("  - SUPABASE_URL (no configurada)");
  } else {
    console.error("  - SUPABASE_URL ✅");
  }
  if (!anon) {
    console.error("  - SUPABASE_ANON_KEY (no configurada)");
  } else {
    console.error("  - SUPABASE_ANON_KEY ✅");
  }
  console.error("");
  console.error("Configúralas antes de ejecutar el build:");
  console.error(`  - Creá .env.local en la raíz del repo (${__repoRoot}) con SUPABASE_URL y SUPABASE_ANON_KEY`);
  console.error("  - O en PowerShell: $env:SUPABASE_URL=\"tu_url\"; $env:SUPABASE_ANON_KEY=\"tu_clave\"");
  console.error("  - O en CMD: set SUPABASE_URL=tu_url");
  process.exit(1);
}

// Validar formato de URL
if (!url.startsWith("https://") || !url.includes(".supabase.co")) {
  console.warn("⚠️  ADVERTENCIA: SUPABASE_URL no parece tener el formato correcto.");
  console.warn("   Formato esperado: https://xxxxx.supabase.co");
}

// Validar longitud de la clave (las claves anónimas de Supabase suelen ser JWT largos)
if (anon.length < 100) {
  console.warn("⚠️  ADVERTENCIA: SUPABASE_ANON_KEY parece muy corta.");
  console.warn("   Verifica que sea la clave 'anon public' correcta de Supabase.");
}

try {
  // SOLUCIÓN CORRECTA: Generar config.prod.js que expone las variables en window
  // Este archivo se carga directamente en index.html ANTES de los demás scripts
  const prodConfigPath = path.join(__dirname, "..", "config.prod.js");
  const prodConfigContent = `// Generado automáticamente en el deploy
// ⚠️ NO EDITAR MANUALMENTE - Este archivo se genera desde variables de entorno
// Este archivo expone las credenciales de Supabase en window para uso en producción
window.SUPABASE_URL = ${JSON.stringify(url)};
window.SUPABASE_ANON_KEY = ${JSON.stringify(anon)};
window.USE_SUPABASE = true;
window.USE_OPEN_SHEET_FALLBACK = false;
window.__FYL_CONFIG_PROD_LOADED__ = true;
window.__FYL_CONFIG_PROD_AT__ = ${JSON.stringify(new Date().toISOString())};
`;

  fs.writeFileSync(prodConfigPath, prodConfigContent, "utf8");
  console.log(`✅ OK: config.prod.js generado en ${prodConfigPath}`);

  // También generar config.local.js (para desarrollo local)
  const localContent = `// Generado automáticamente en el deploy
// ⚠️ NO EDITAR MANUALMENTE - Este archivo se genera desde variables de entorno
export const SUPABASE_URL = ${JSON.stringify(url)};
export const SUPABASE_ANON_KEY = ${JSON.stringify(anon)};
export const USE_SUPABASE = true;
export const USE_OPEN_SHEET_FALLBACK = false;
`;

  const localOutputPath = path.join(__dirname, "config.local.js");
  fs.writeFileSync(localOutputPath, localContent, "utf8");
  console.log(`✅ OK: config.local.js generado en ${localOutputPath}`);
} catch (error) {
  console.error("❌ ERROR al escribir los archivos de configuración:");
  console.error(error.message);
  process.exit(1);
}

