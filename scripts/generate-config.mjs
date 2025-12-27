import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const url = process.env.SUPABASE_URL;
const anon = process.env.SUPABASE_ANON_KEY;

if (!url || !anon) {
  console.error("Faltan SUPABASE_URL o SUPABASE_ANON_KEY en el entorno.");
  process.exit(1);
}

const content = `// Generado automáticamente en el deploy
window.SUPABASE_URL = ${JSON.stringify(url)};
window.SUPABASE_ANON_KEY = ${JSON.stringify(anon)};
`;

// Generar en la raíz del proyecto (un nivel arriba de scripts/)
const rootDir = path.join(__dirname, "..");
const outputPath = path.join(rootDir, "config.local.js");
fs.writeFileSync(outputPath, content, "utf8");
console.log("OK: config.local.js generado");

