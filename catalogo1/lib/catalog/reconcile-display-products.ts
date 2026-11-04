import type { GroupedProduct } from "@/types/catalog";
import { productHasAnyStock } from "@/lib/utils/catalog-variant-enrich";

/**
 * Reconciliación estable del grid de catálogo (anti-CLS).
 *
 * Adaptado de nj/: usa `productHasAnyStock` (display light) en lugar de
 * `productIsPurchasable` / sellable stock.
 *
 * Mientras `isEnriching`:
 * - Conserva el orden y la cantidad de slots ya pintados.
 * - Neutraliza hasStock/hasAnyStock.
 *
 * Cuando el pool enriquecido está listo:
 * - Conserva cada slot si el mismo artículo sigue con stock.
 * - Si un slot debe salir (OOS / sin imágenes), lo reemplaza in-place.
 * - Sin reemplazo: deja el artículo previo marcado OOS (overlay).
 */

export type PaintedGridState = {
  filterKey: string;
  products: GroupedProduct[];
};

export function resolvePreviousForFilter(
  state: PaintedGridState | null | undefined,
  filterKey: string
): GroupedProduct[] {
  if (!state || state.filterKey !== filterKey) return [];
  return state.products;
}

export function neutralizePendingStock(
  product: GroupedProduct
): GroupedProduct {
  return {
    ...product,
    hasAnyStock: undefined,
    DetalleColor: (product.DetalleColor ?? []).map((dc) => ({
      ...dc,
      hasStock: undefined,
    })),
  };
}

export function markProductOutOfStock(product: GroupedProduct): GroupedProduct {
  return {
    ...product,
    hasAnyStock: false,
    DetalleColor: (product.DetalleColor ?? []).map((dc) => ({
      ...dc,
      hasStock: false,
    })),
  };
}

export function reconcileDisplayProducts(options: {
  previous: GroupedProduct[];
  nextPool: GroupedProduct[];
  slotCount: number;
  isEnriching: boolean;
}): GroupedProduct[] {
  const { previous, nextPool, slotCount, isEnriching } = options;
  const slots = Math.max(0, slotCount);

  if (slots === 0) return [];

  if (isEnriching) {
    const base = previous.length > 0 ? previous : nextPool;
    return base.slice(0, slots).map(neutralizePendingStock);
  }

  const pool = nextPool.filter((p) => (p.DetalleColor?.length ?? 0) > 0);
  const inStock = pool.filter(productHasAnyStock);
  const used = new Set<string>();
  const result: GroupedProduct[] = [];

  const prevSlice = previous.slice(0, slots);
  const reserved = new Set(
    prevSlice
      .filter((prev) =>
        inStock.some((p) => p.Articulo === prev.Articulo)
      )
      .map((p) => p.Articulo)
  );

  const takeReplacement = (): GroupedProduct | undefined => {
    const next = inStock.find(
      (p) => !used.has(p.Articulo) && !reserved.has(p.Articulo)
    );
    if (!next) return undefined;
    used.add(next.Articulo);
    return next;
  };

  const takeAnyUnused = (): GroupedProduct | undefined => {
    const next = inStock.find((p) => !used.has(p.Articulo));
    if (!next) return undefined;
    used.add(next.Articulo);
    return next;
  };

  for (const prev of prevSlice) {
    const updated = inStock.find((p) => p.Articulo === prev.Articulo);
    if (updated && !used.has(updated.Articulo)) {
      result.push(updated);
      used.add(updated.Articulo);
      continue;
    }

    const replacement = takeReplacement();
    if (replacement) {
      result.push(replacement);
      continue;
    }

    result.push(markProductOutOfStock(prev));
  }

  while (result.length < slots) {
    const next = takeAnyUnused();
    if (!next) break;
    result.push(next);
  }

  return result;
}

export function reconcileForFilterKey(options: {
  painted: PaintedGridState;
  filterKey: string;
  nextPool: GroupedProduct[];
  slotCount: number;
  isEnriching: boolean;
}): { products: GroupedProduct[]; painted: PaintedGridState } {
  const previous = resolvePreviousForFilter(options.painted, options.filterKey);
  const products = reconcileDisplayProducts({
    previous,
    nextPool: options.nextPool,
    slotCount: options.slotCount,
    isEnriching: options.isEnriching,
  });
  return {
    products,
    painted: { filterKey: options.filterKey, products },
  };
}
