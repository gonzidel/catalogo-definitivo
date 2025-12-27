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
export const SUPABASE_URL = ${JSON.stringify(url)};
export const SUPABASE_ANON_KEY = ${JSON.stringify(anon)};
`;

// Generar en scripts/config.local.js (mismo directorio que este script)
const outputPath = path.join(__dirname, "config.local.js");
fs.writeFileSync(outputPath, content, "utf8");
console.log(`OK: config.local.js generado en ${outputPath}`);

