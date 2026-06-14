import type { GroupedProduct } from "@/types/catalog";
import { compareCatalogSizes, normalizeSize } from "@/lib/utils/size-normalizer";
import {
  buildRopaUnifiedMainEntries,
  classifyRopaTalle,
  type RopaMainEntry,
} from "@/lib/utils/size-filter-ropa";

export function normalizeCategoryKey(cat: string): string {
  return String(cat || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function productMatchesSizeCategory(
  product: GroupedProduct,
  categoria: string
): boolean {
  const selected = normalizeCategoryKey(categoria);
  const cat = normalizeCategoryKey(product.Categoria);
  const f1 = normalizeCategoryKey(product.Filtro1);

  if (!selected || selected === "all") return true;
  if (selected === cat) return true;
  if (selected === "lenceria" && cat === "otros" && f1.includes("lenceria")) return true;
  if (selected === "marroquineria" && cat === "otros" && f1.includes("marroquineria")) {
    return true;
  }
  return false;
}

/** Expande "37/38" → ["37","38"]. */
export function expandCombinedSizes(sizes: string[]): string[] {
  const out = new Set<string>();
  for (const raw of sizes) {
    const s = String(raw ?? "").trim();
    if (!s) continue;
    if (s.includes("/")) {
      s.split("/")
        .map((p) => p.trim())
        .filter(Boolean)
        .forEach((p) => out.add(p));
    } else {
      out.add(s);
    }
  }
  return Array.from(out);
}

export function extractSizesFromProducts(
  products: GroupedProduct[],
  categoria: string
): string[] {
  const set = new Set<string>();
  for (const p of products) {
    if (!productMatchesSizeCategory(p, categoria)) continue;
    for (const dc of p.DetalleColor ?? []) {
      for (const t of dc.talles ?? []) {
        const trimmed = String(t ?? "").trim();
        if (!trimmed) continue;
        expandCombinedSizes([trimmed]).forEach((x) => set.add(x));
      }
    }
  }
  return Array.from(set).sort(compareCatalogSizes);
}

function parseMeasureSortKey(label: string): number {
  const nums = String(label).match(/\d+(\.\d+)?/g);
  if (!nums?.length) return Number.MAX_SAFE_INTEGER;
  return nums.reduce((sum, n) => sum + parseFloat(n), 0);
}

export function sortMeasureSizes(sizes: string[]): string[] {
  return [...sizes].sort((a, b) => {
    const ka = parseMeasureSortKey(a);
    const kb = parseMeasureSortKey(b);
    if (ka !== kb) return ka - kb;
    return compareCatalogSizes(a, b);
  });
}

export interface SizeFilterSection {
  key: string;
  /** Etiqueta centrada entre líneas (ej. ADULTO · 34 AL 46) */
  title: string;
  subtitle?: string;
  sizes?: string[];
  ropaEntries?: RopaMainEntry[];
  measureLayout?: boolean;
  /** Columnas de la grilla (calzado = 5) */
  gridColumns?: 4 | 5 | 6;
  /** Sección ropa: Único arriba + grilla de equivalencias */
  ropaGeneralLayout?: boolean;
}

export function buildSizeFilterSections(
  sizes: string[],
  categoria: string
): SizeFilterSection[] {
  const cat = normalizeCategoryKey(categoria);

  if (cat === "ropa") {
    const byKey = new Map<string, string>();
    for (const raw of sizes) {
      const c = classifyRopaTalle(raw);
      if (c && !byKey.has(c.key)) byKey.set(c.key, c.filterValue);
    }
    const ropaMain = buildRopaUnifiedMainEntries(byKey);
    const ropaP: string[] = [];
    for (const fv of byKey.values()) {
      const m = classifyRopaTalle(fv);
      if (m?.section === "P") ropaP.push(fv);
    }
    ropaP.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

    return [
      {
        key: "ropa-unified",
        title: "TALLES GENERALES",
        ropaEntries: ropaMain,
        ropaGeneralLayout: true,
        gridColumns: 5 as const,
      },
      {
        key: "pants",
        title: "PANTALÓN",
        sizes: ropaP,
        gridColumns: 5 as const,
      },
    ].filter((s) =>
      s.ropaEntries?.length ? true : (s.sizes?.length ?? 0) > 0
    );
  }

  if (cat === "calzado") {
    const general: string[] = [];
    const ninos: string[] = [];
    const otros: string[] = [];

    for (const size of sizes) {
      const n = parseInt(normalizeSize(size) || size, 10);
      if (Number.isNaN(n)) {
        otros.push(size);
        continue;
      }
      if (n >= 34 && n <= 46) general.push(String(n));
      else if (n >= 18 && n <= 33) ninos.push(String(n));
      else otros.push(size);
    }

    general.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    ninos.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    otros.sort(compareCatalogSizes);

    const sections: SizeFilterSection[] = [];
    if (general.length) {
      sections.push({
        key: "general",
        title: "ADULTO · 34 AL 46",
        sizes: general,
        gridColumns: 5 as const,
      });
    }
    if (ninos.length) {
      sections.push({
        key: "ninos",
        title: "NIÑO/A · 18 AL 33",
        sizes: ninos,
        gridColumns: 5 as const,
      });
    }
    if (otros.length) {
      sections.push({ key: "other", title: "Otros", sizes: otros });
    }
    return sections;
  }

  if (cat === "lenceria") {
    const sorted = [...sizes].sort(compareCatalogSizes);
    return sorted.length
      ? [{ key: "lenceria", title: "Talles de lencería", sizes: sorted }]
      : [];
  }

  if (cat === "marroquineria") {
    const sorted = sortMeasureSizes(sizes);
    return sorted.length
      ? [
          {
            key: "measures",
            title: "Medidas",
            subtitle: "De menor a mayor",
            sizes: sorted,
            measureLayout: true,
          },
        ]
      : [];
  }

  // Otros / fallback numérico + alfabético
  const numeric: string[] = [];
  const alpha: string[] = [];
  for (const s of sizes) {
    if (/^\d+(\.\d+)?$/.test(String(s).trim())) numeric.push(s);
    else alpha.push(s);
  }
  numeric.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  alpha.sort(compareCatalogSizes);
  const merged = [...numeric, ...alpha];
  return merged.length ? [{ key: "all", title: "Talles", sizes: merged }] : [];
}
