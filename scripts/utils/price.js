/**
 * Normaliza precios ARS desde string/number a número utilizable.
 * Acepta formatos como:
 * - "$18.000"
 * - "18,000"
 * - "18000"
 * - "16.5" (legacy abreviado => 16500)
 */
export function parseARSNumber(value, options = {}) {
  const { legacyDecimalThousands = true } = options;

  if (value == null || value === "") return 0;

  if (typeof value === "number") {
    return normalizeLegacyPrice(value, legacyDecimalThousands);
  }

  const raw = String(value).trim();
  if (!raw) return 0;

  const cleaned = raw
    .replace(/\s+/g, "")
    .replace(/[^\d.,-]/g, "");

  if (!cleaned) return 0;

  const hasDot = cleaned.includes(".");
  const hasComma = cleaned.includes(",");
  let normalized = cleaned;

  if (hasDot && hasComma) {
    // Si existen ambos separadores, el último define decimal.
    const lastDot = cleaned.lastIndexOf(".");
    const lastComma = cleaned.lastIndexOf(",");
    const decimalSep = lastDot > lastComma ? "." : ",";
    const thousandsSep = decimalSep === "." ? "," : ".";
    normalized = cleaned.split(thousandsSep).join("");
    if (decimalSep === ",") normalized = normalized.replace(",", ".");
  } else if (hasDot || hasComma) {
    const sep = hasDot ? "." : ",";
    const parts = cleaned.split(sep);

    if (parts.length > 2) {
      // Múltiples separadores iguales: miles.
      normalized = parts.join("");
    } else if (parts.length === 2) {
      const [intPart, fracPart] = parts;
      // Caso típico ARS miles: 18.000 / 18,000
      if (/^\d{3}$/.test(fracPart)) {
        normalized = `${intPart}${fracPart}`;
      } else if (sep === ",") {
        normalized = `${intPart}.${fracPart}`;
      } else {
        normalized = `${intPart}.${fracPart}`;
      }
    }
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return 0;
  return normalizeLegacyPrice(parsed, legacyDecimalThousands);
}

export function formatARS(value) {
  const num = parseARSNumber(value);
  return (
    "$" +
    new Intl.NumberFormat("es-AR", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(Math.round(num))
  );
}

function normalizeLegacyPrice(num, enableLegacyFix) {
  const n = Number(num) || 0;
  if (!enableLegacyFix) return n;
  if (n > 0 && n < 1000 && n % 1 !== 0) return n * 1000;
  return n;
}

/**
 * Precio unitario para mostrar en líneas de pedido cuando `price_snapshot` quedó corrupto
 * (típico: parseFloat sobre "$18.000" / "18.000" guardó 18 en lugar de 18000).
 * Si existe precio de variante en catálogo y el snapshot es claramente inconsistente, usa la variante.
 */
/** Variante con precio de catálogo cargado (mayor a 0). */
export function hasCatalogPrice(price) {
  return parseARSNumber(price) > 0;
}

/** Mensaje estándar al bloquear carga sin precio. */
export function catalogPriceGuardMessage(productName) {
  const name = String(productName || "El producto").trim() || "El producto";
  return `${name} no tiene precio cargado. Actualizá el precio en catálogo antes de agregarlo.`;
}

export function resolveOrderItemUnitPrice(priceSnapshot, variantPrice) {
  const snap = parseARSNumber(priceSnapshot);
  const pv = parseARSNumber(variantPrice);
  if (pv <= 0) return snap;
  if (snap === 0) return pv;
  // Signo negativo = línea de devolución. Se preserva: solo se corrige la
  // magnitud si el snapshot está corrupto (ej. 18 en vez de 18000), nunca el signo.
  const sign = snap < 0 ? -1 : 1;
  const absSnap = Math.abs(snap);
  if (absSnap >= 1000) return snap;
  const MIN_VARIANT_TO_TRUST = 1500;
  const MIN_RATIO = 75;
  if (pv >= MIN_VARIANT_TO_TRUST && absSnap < 1000 && pv >= absSnap * MIN_RATIO) return sign * pv;
  return snap;
}
