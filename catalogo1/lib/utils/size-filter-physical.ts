import { normalizeSize } from "@/lib/utils/size-normalizer";
import { ROPA_PAIR_LABELS } from "@/lib/utils/size-filter-ropa";
import type { SizeAvailability } from "@/lib/utils/size-filter-stock";

function normSizeKey(size: string): string {
  const n = normalizeSize(size);
  return (n || String(size).trim()).toUpperCase();
}

function parseNum(size: string): number | null {
  const n = parseInt(normalizeSize(size) || String(size).trim(), 10);
  return Number.isNaN(n) ? null : n;
}

/** Talles con stock físico fijo — no consultar variant_sizes. */
export function isPhysicalAlwaysAvailable(
  size: string,
  categoria: string
): boolean {
  const cat = categoria.trim().toLowerCase();
  const token = String(size ?? "").trim();

  if (cat === "calzado") {
    const n = parseNum(token);
    if (n === null) return false;
    return (n >= 35 && n <= 43) || (n >= 25 && n <= 32);
  }

  if (cat === "ropa") {
    const lower = token
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
    if (lower === "unico" || lower === "unica" || lower === "u" || token === "Único") {
      return true;
    }
    if (ROPA_PAIR_LABELS.has(token)) {
      const numPart = token.split("/")[1];
      const n = parseNum(numPart ?? "");
      if (n !== null && n >= 1 && n <= 6) return true;
    }
    const n = parseNum(token);
    if (n !== null && n >= 1 && n <= 6) return true;
    return false;
  }

  return false;
}

/** Mapa inicial: físicos con stock; resto optimista (se refina en background). */
export function buildInitialSizeAvailability(
  catalogSizes: string[],
  categoria: string
): Map<string, SizeAvailability> {
  const map = new Map<string, SizeAvailability>();
  for (const s of catalogSizes) {
    const key = normSizeKey(s);
    map.set(key, {
      exists: true,
      // Optimista: se muestra al instante; background refina no-físicos sin stock.
      hasStock: true,
    });
  }
  return map;
}

export function catalogSizesNeedingStockQuery(
  catalogSizes: string[],
  categoria: string
): string[] {
  return catalogSizes.filter((s) => !isPhysicalAlwaysAvailable(s, categoria));
}

export { normSizeKey };
