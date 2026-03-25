/**
 * Lee snaider_localidades.xlsx (hoja "Listado Completo") y genera
 * client/data/snaider-localidades.js
 *
 * Columnas esperadas: # | C. Postal | Localidad | Provincia | ...
 *
 * Uso: node scripts/import-snaider-xlsx.mjs [ruta/al/archivo.xlsx]
 */
import XLSX from "xlsx";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT_FILE = path.join(ROOT, "client", "data", "snaider-localidades.js");

const TRANSPORTE_LABEL = "Transporte Snaider";

/** Alineado con client/profile.js ARGENTINA_PROVINCES (mismo mapa que import-viacargo-xlsx) */
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

/** Solo filas de datos reales (evita fila resumen del Excel) */
const PROVINCIAS_VALIDAS = new Set([
  "Buenos Aires",
  "Catamarca",
  "Chaco",
  "Chubut",
  "Córdoba",
  "Corrientes",
  "Entre Ríos",
  "Formosa",
  "Jujuy",
  "La Pampa",
  "La Rioja",
  "Mendoza",
  "Misiones",
  "Neuquén",
  "Río Negro",
  "Salta",
  "San Juan",
  "San Luis",
  "Santa Cruz",
  "Santa Fe",
  "Santiago del Estero",
  "Tierra del Fuego",
  "Tucumán",
  "CABA",
]);

const xlsxPath =
  process.argv[2] ||
  path.join(process.env.USERPROFILE || "", "Downloads", "snaider_localidades.xlsx");

if (!fs.existsSync(xlsxPath)) {
  console.error("No se encontró el archivo:", xlsxPath);
  console.error("Uso: node scripts/import-snaider-xlsx.mjs <ruta.xlsx>");
  process.exit(1);
}

const wb = XLSX.readFile(xlsxPath);
const sheetName = wb.SheetNames.includes("Listado Completo")
  ? "Listado Completo"
  : wb.SheetNames[0];
const sh = wb.Sheets[sheetName];
const rows = XLSX.utils.sheet_to_json(sh, { header: 1, defval: "" });

let headerIdx = -1;
let iLoc = 2;
let iProv = 3;
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  const c0 = String(r[0] ?? "").trim().toLowerCase();
  const c1 = String(r[1] ?? "").trim().toLowerCase();
  const c2 = String(r[2] ?? "").trim().toLowerCase();
  const c3 = String(r[3] ?? "").trim().toLowerCase();
  if (
    (c2 === "localidad" && c3 === "provincia") ||
    (c1.includes("postal") && c2 === "localidad" && c3 === "provincia")
  ) {
    headerIdx = i + 1;
    if (c2 === "localidad") {
      iLoc = 2;
      iProv = 3;
    }
    break;
  }
}

if (headerIdx < 0) {
  console.error("No se encontró la fila de encabezados (Localidad / Provincia).");
  process.exit(1);
}

const seen = new Set();
const out = [];
for (let i = headerIdx; i < rows.length; i++) {
  const r = rows[i];
  const localidad = String(r[iLoc] ?? "").trim();
  const provRaw = String(r[iProv] ?? "").trim();
  if (!localidad || !provRaw) continue;
  if (/total/i.test(localidad) || /provincias/i.test(provRaw)) continue;
  const provincia = canonProvincia(provRaw);
  if (!PROVINCIAS_VALIDAS.has(provincia)) continue;
  const k = normKey(provincia, localidad);
  if (seen.has(k)) continue;
  seen.add(k);
  out.push({ provincia, localidad, transporte: TRANSPORTE_LABEL });
}

out.sort((a, b) => {
  const pa = a.provincia.localeCompare(b.provincia, "es");
  if (pa !== 0) return pa;
  return a.localidad.localeCompare(b.localidad, "es");
});

const banner = `/**
 * Cobertura Transporte Snaider (provincia + localidad).
 * Generado con: node scripts/import-snaider-xlsx.mjs
 * No editar a mano; volver a correr el script si actualizás el Excel.
 */
`;

const body = `${banner}export const snaiderLocalities = ${JSON.stringify(out, null, 2)};
`;

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, body, "utf8");
console.log(`Hoja: ${sheetName}`);
console.log(`Entradas únicas: ${out.length}`);
console.log(`Escrito: ${OUT_FILE}`);
