/**
 * scripts/utils/size-normalizer.js
 * 
 * Función centralizada para normalizar tamaños de productos.
 * Esta función DEBE usarse en TODOS los módulos que trabajan con talles/sizes.
 * 
 * IMPORTANTE: Los talles ahora se almacenan en variant_sizes (NO en product_variants.size que está deprecado).
 * 
 * @param {string|number|null|undefined} size - El tamaño a normalizar
 * @returns {string} - El tamaño normalizado como string, o "" si es null/undefined
 * 
 * Ejemplos:
 * - normalizeSize("38") → "38"
 * - normalizeSize("38.0") → "38"
 * - normalizeSize(38) → "38"
 * - normalizeSize(38.5) → "38"
 * - normalizeSize(" 38 ") → "38"
 * - normalizeSize(null) → ""
 * - normalizeSize(undefined) → ""
 */
export function normalizeSize(size) {
  if (size === null || size === undefined) return "";
  let normalized = String(size).trim();
  const numValue = Number(normalized);
  if (!isNaN(numValue) && isFinite(numValue)) {
    normalized = String(Math.floor(numValue)); // "38.0" → "38", 38.5 → "38"
  }
  return normalized;
}

/** Solo cadenas que son enteramente un número (talles 34, 38, etc.) */
function isNumericSizeString(value) {
  return /^-?\d+(\.\d+)?$/.test(String(value ?? "").trim());
}

/**
 * Orden canónico para talles alfabéticos de ropa (evita que localeCompare numeric
 * ponga "2XL" antes que "XL").
 */
const APPAREL_SIZE_ORDER = [
  "xxs",
  "xs",
  "s",
  "m",
  "ml",
  "l",
  "xl",
  "xxl",
  "2xl",
  "3xl",
  "4xl",
  "5xl",
  "6xl",
  "7xl",
  "8xl",
  "9xl",
  "10xl",
  "11xl",
  "12xl"
];

const APPAREL_SYNONYMS = {
  xxxl: "3xl",
  xxxxl: "4xl",
  xxxxxl: "5xl",
  xxxxxxl: "6xl",
  xxxxxxxl: "7xl",
  xxxxxxxxl: "8xl"
};

const APPAREL_RANK = Object.fromEntries(
  APPAREL_SIZE_ORDER.map((s, i) => [s, i])
);

function apparelSizeRank(size) {
  const raw = String(size ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
  const key = APPAREL_SYNONYMS[raw] ?? raw;
  return Object.prototype.hasOwnProperty.call(APPAREL_RANK, key)
    ? APPAREL_RANK[key]
    : null;
}

/**
 * Comparador para listar talles en catálogo / publicaciones / stock.
 * - Numéricos primero (orden numérico).
 * - Luego talles de ropa conocidos (S, M, L, XL, 2XL, 3XL…).
 * - Resto: localeCompare sin opción numeric (evita mezclar letras y prefijos).
 */
export function compareCatalogSizes(a, b) {
  const aNum = isNumericSizeString(a);
  const bNum = isNumericSizeString(b);
  if (aNum && bNum) return Number(a) - Number(b);
  if (aNum && !bNum) return -1;
  if (!aNum && bNum) return 1;

  const ar = apparelSizeRank(a);
  const br = apparelSizeRank(b);
  if (ar !== null && br !== null) return ar - br;
  if (ar !== null && br === null) return -1;
  if (ar === null && br !== null) return 1;

  return String(a).localeCompare(String(b), "es", { sensitivity: "base" });
}
