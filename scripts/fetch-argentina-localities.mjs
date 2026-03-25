/**
 * Descarga provincias y localidades de Argentina desde zokeber/argentina-json
 * y genera client/data/argentina-localidades.json con array de { provincia, localidad }.
 *
 * Uso: node scripts/fetch-argentina-localities.mjs
 */

import https from "https";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_JSON = "https://raw.githubusercontent.com/zokeber/argentina-json/master/argentina.json";
const OUT_DIR = path.join(__dirname, "..", "client", "data");
const OUT_FILE = path.join(OUT_DIR, "argentina-localidades.json");

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${url}`));
          return;
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

async function main() {
  console.log("Descargando argentina.json desde zokeber/argentina-json...");
  const text = await fetchUrl(REPO_JSON);
  const data = JSON.parse(text);

  const flat = [];
  for (const item of data) {
    const provincia = item.provincia || item.province || "";
    const localidades = item.localidad || item.localities || [];
    const names = Array.isArray(localidades)
      ? localidades.map((loc) => (typeof loc === "string" ? loc : loc?.name || String(loc)))
      : [];
    for (const name of names) {
      if (name && name.trim()) flat.push({ provincia: provincia.trim(), localidad: name.trim() });
    }
  }

  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }
  fs.writeFileSync(OUT_FILE, JSON.stringify(flat, null, 2), "utf8");
  console.log(`Escrito ${flat.length} entradas en ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
