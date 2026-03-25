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
