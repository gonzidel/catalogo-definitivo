import type { GroupedProduct } from "@/types/catalog";
import { normalizeText } from "@/lib/utils/search";
import { normalizeCategoryKey } from "@/lib/utils/size-filter-catalog";

/** Mapeo producto → categoría de catálogo (paridad con scripts/main-supabase.js). */
export function mapProductToCatalogCategory(
  product: GroupedProduct
): string | null {
  const categoria = normalizeCategoryKey(product.Categoria ?? "");
  const filtro1 = normalizeCategoryKey(product.Filtro1 ?? "");

  if (categoria === "calzado") return "Calzado";
  if (categoria === "ropa") return "Ropa";
  if (categoria === "lenceria") return "Lenceria";
  if (categoria === "marroquineria") return "Marroquineria";

  if (categoria === "otros") {
    if (filtro1.includes("lenceria")) return "Lenceria";
    if (filtro1.includes("marroquineria")) return "Marroquineria";
  }

  return null;
}

/**
 * Infiere categoría dominante en resultados de búsqueda/tag.
 * Si una categoría supera 2× la segunda, se usa automáticamente.
 */
export function inferCategoryFromProducts(
  products: GroupedProduct[]
): string | null {
  if (!products.length) return null;

  const counts = new Map<string, number>();
  for (const product of products) {
    const mapped = mapProductToCatalogCategory(product);
    if (!mapped) continue;
    counts.set(mapped, (counts.get(mapped) ?? 0) + 1);
  }

  if (counts.size === 0) return null;

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 1) return ranked[0][0];
  if (ranked[0][1] >= ranked[1][1] * 2) return ranked[0][0];

  return null;
}

/** Filtro client-side por Filtro1/2/3 (p. ej. /tags/zapatilla antes de que cargue SWR). */
export function filterProductsByTags(
  products: GroupedProduct[],
  tags: string[]
): GroupedProduct[] {
  if (!tags.length) return products;

  const normTags = tags.map((t) => normalizeText(t)).filter(Boolean);
  if (!normTags.length) return products;

  return products.filter((p) => {
    const fields = [p.Filtro1, p.Filtro2, p.Filtro3].map((f) =>
      normalizeText(f ?? "")
    );
    return normTags.some((tag) => fields.some((f) => f.includes(tag)));
  });
}
