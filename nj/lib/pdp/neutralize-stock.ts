import type { GroupedProduct } from "@/types/catalog";

/** Quita hasStock para no pintar OOS/disponible antes del sellable cliente. */
export function neutralizePdpStockFlags(product: GroupedProduct): GroupedProduct {
  return {
    ...product,
    hasAnyStock: undefined,
    DetalleColor: (product.DetalleColor ?? []).map((dc) => ({
      ...dc,
      hasStock: undefined,
    })),
  };
}
