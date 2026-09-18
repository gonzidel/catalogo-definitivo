import type { ColorDetail, GroupedProduct } from "@/types/catalog";
import {
  hasValidCatalogPrice,
  parseCatalogPrice,
} from "@/lib/utils/variant-price";

/** `undefined` = unknown / todavía no hay señal. Nunca equivale a comprable. */
export type StockPresence = boolean | undefined;

export function colorStockPresence(
  detail: Pick<ColorDetail, "hasStock"> | null | undefined
): StockPresence {
  if (!detail) return undefined;
  return detail.hasStock;
}

export function colorsHaveAnySellable(
  colors: Array<Pick<ColorDetail, "hasStock">>
): StockPresence {
  const known = colors.filter((c) => c.hasStock !== undefined);
  if (known.length === 0) return undefined;
  return known.some((c) => c.hasStock === true);
}

/**
 * Presencia de stock vendible del producto.
 * unknown si no hay `hasAnyStock` ni colores con `hasStock` definido.
 */
export function productStockPresence(product: GroupedProduct): StockPresence {
  if (product.hasAnyStock === true) return true;
  if (product.hasAnyStock === false) return false;
  return colorsHaveAnySellable(product.DetalleColor ?? []);
}

/** Color con precio de lista > 0 (no se vende a $0). */
export function colorHasSellablePrice(
  detail: Pick<ColorDetail, "Precio"> | null | undefined
): boolean {
  return hasValidCatalogPrice(parseCatalogPrice(detail?.Precio));
}

/**
 * Home / categoría / ofertas: stock explícito + precio > 0.
 * Un color/variante a $0 no es comprable aunque tenga stock.
 */
export function productIsPurchasable(product: GroupedProduct): boolean {
  if (product.hasAnyStock === false) return false;
  const colors = product.DetalleColor ?? [];
  if (colors.length > 0) {
    return colors.some(colorIsPurchasable);
  }
  return (
    product.hasAnyStock === true &&
    hasValidCatalogPrice(parseCatalogPrice(product.Precio))
  );
}

export function productIsOutOfStock(product: GroupedProduct): boolean {
  return productStockPresence(product) === false;
}

export function deriveHasAnyStock(
  colors: Array<Pick<ColorDetail, "hasStock">>,
  fallback?: boolean
): boolean | undefined {
  const fromColors = colorsHaveAnySellable(colors);
  if (fromColors !== undefined) return fromColors;
  return fallback;
}

/** Color comprable ⇔ stock + precio de catálogo > 0. Sin datos ≠ true. */
export function colorIsPurchasable(
  detail: Pick<ColorDetail, "hasStock" | "Precio"> | null | undefined
): boolean {
  return colorStockPresence(detail) === true && colorHasSellablePrice(detail);
}
