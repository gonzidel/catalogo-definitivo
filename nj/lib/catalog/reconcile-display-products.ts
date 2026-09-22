import type { GroupedProduct } from "@/types/catalog";
import { productIsPurchasable } from "@/lib/stock/catalog-availability";

/**
 * Reconciliación estable del grid de catálogo (anti-CLS).
 *
 * Mientras `isEnriching`:
 * - Conserva el orden y la cantidad de slots ya pintados.
 * - Neutraliza hasStock/hasAnyStock → no se muestra stock positivo ni CTA comprable.
 *
 * Cuando el pool enriquecido está listo:
 * - Conserva cada slot si el mismo artículo sigue siendo comprable.
 * - Si un slot debe salir (OOS / sin imágenes), lo reemplaza in-place con el
 *   siguiente del pool, sin colapsar la fila (misma cantidad de slots mientras
 *   haya reemplazo).
 * - Si no hay reemplazo, deja el artículo previo marcado OOS (overlay Sin stock)
 *   para no desplazar el resto del grid.
 * - Los artículos nuevos del pool se agregan solo al final (slots libres).
 *
 * Cambio de filtro (talle / categoría / tags / búsqueda):
 * - Usar `PaintedGridState` + `resolvePreviousForFilter` en render (síncrono).
 * - Si `filterKey` no coincide → previous vacío (nunca arrastrar productos
 *   del filtro anterior como falso OOS).
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
  const purchasable = pool.filter(productIsPurchasable);
  const used = new Set<string>();
  const result: GroupedProduct[] = [];

  const prevSlice = previous.slice(0, slots);
  // No robar del pool artículos que seguirán ocupando su slot previo.
  const reserved = new Set(
    prevSlice
      .filter((prev) =>
        purchasable.some((p) => p.Articulo === prev.Articulo)
      )
      .map((p) => p.Articulo)
  );

  const takeReplacement = (): GroupedProduct | undefined => {
    const next = purchasable.find(
      (p) => !used.has(p.Articulo) && !reserved.has(p.Articulo)
    );
    if (!next) return undefined;
    used.add(next.Articulo);
    return next;
  };

  const takeAnyUnused = (): GroupedProduct | undefined => {
    const next = purchasable.find((p) => !used.has(p.Articulo));
    if (!next) return undefined;
    used.add(next.Articulo);
    return next;
  };

  for (const prev of prevSlice) {
    const updated = purchasable.find((p) => p.Articulo === prev.Articulo);
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

    // Sin reemplazo: conservar geometría del slot, no comprable.
    result.push(markProductOutOfStock(prev));
  }

  while (result.length < slots) {
    const next = takeAnyUnused();
    if (!next) break;
    result.push(next);
  }

  return result;
}

/**
 * Un paso de reconciliación con clave de filtro (render síncrono).
 * Si la clave no coincide, previous = [] → no hay residuos del filtro anterior.
 */
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
