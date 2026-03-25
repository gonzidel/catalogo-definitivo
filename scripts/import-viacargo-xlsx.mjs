/**
 * Lee viacargo_localidades.xlsx (hoja "Listado Completo") y genera
 * client/data/via-cargo-localidades.js para transportes-data.js
 *
 * Uso: node scripts/import-viacargo-xlsx.mjs [ruta/al/archivo.xlsx]
 */
import XLSX from "xlsx";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT_FILE = path.join(ROOT, "client", "data", "via-cargo-localidades.js");

/** Alineado con client/profile.js ARGENTINA_PROVINCES */
const PROVINCIA_CANONICA = {
  "capital federal": "CABA",
  cordoba: "Córdoba",
  "entre rios": "Entre Ríos",
  "rio negro": "Río Negro",
  neuquen: "Neuquén",
  tucuman: "Tucumán",
};

function canonProvincia(nombre) {
  const raw = String(nombre || "").trim();
  if (!raw) return "";
  const key = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  return PROVINCIA_CANONICA[key] || raw;
}

function normKey(p, l) {
  return `${p}|${l}`
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const xlsxPath = process.argv[2] || path.join(process.env.USERPROFILE || "", "Downloads", "viacargo_localidades.xlsx");

if (!fs.existsSync(xlsxPath)) {
  console.error("No se encontró el archivo:", xlsxPath);
  console.error("Uso: node scripts/import-viacargo-xlsx.mjs <ruta.xlsx>");
  process.exit(1);
}

const wb = XLSX.readFile(xlsxPath);
const sheetName = wb.SheetNames.includes("Listado Completo")
  ? "Listado Completo"
  : wb.SheetNames[0];
const sh = wb.Sheets[sheetName];
const rows = XLSX.utils.sheet_to_json(sh, { header: 1, defval: "" });

let start = 0;
for (let i = 0; i < rows.length; i++) {
  const a = String(rows[i][0] || "").trim();
  const b = String(rows[i][1] || "").trim();
  if (a === "Provincia" && b === "Localidad") {
    start = i + 1;
    break;
  }
}

const seen = new Set();
const out = [];
for (let i = start; i < rows.length; i++) {
  const provRaw = String(rows[i][0] || "").trim();
  const loc = String(rows[i][1] || "").trim();
  if (!loc) continue;
  if (!provRaw) continue;
  const provincia = canonProvincia(provRaw);
  const localidad = loc;
  const k = normKey(provincia, localidad);
  if (seen.has(k)) continue;
  seen.add(k);
  out.push({ provincia, localidad, transporte: "Via Cargo" });
}

out.sort((a, b) => {
  const pa = a.provincia.localeCompare(b.provincia, "es");
  if (pa !== 0) return pa;
  return a.localidad.localeCompare(b.localidad, "es");
});

const banner = `/**
 * Cobertura Via Cargo (provincia + localidad).
 * Generado con: node scripts/import-viacargo-xlsx.mjs
 * No editar a mano; volver a correr el script si actualizás el Excel.
 */
`;

const body = `${banner}export const viaCargoLocalities = ${JSON.stringify(out, null, 2)};
`;

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, body, "utf8");
console.log(`Hoja: ${sheetName}`);
console.log(`Entradas únicas: ${out.length}`);
console.log(`Escrito: ${OUT_FILE}`);
