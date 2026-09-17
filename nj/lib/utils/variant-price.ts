import type { ColorDetail } from "@/types/catalog";

/** Campos mínimos para derivar precio efectivo de un color/variante. */
export interface ColorPriceInput {
  Precio?: number | string | null;
  PrecioOferta?: number | string | null;
  OfertaActiva?: boolean | string | null;
}

export interface ColorEffectivePrice {
  normalPrice: number;
  offerPrice: number | null;
  effectivePrice: number;
  isOffer: boolean;
  savings: number;
}

export function parseCatalogPrice(
  value: number | string | null | undefined
): number {
  if (value == null || value === "") return 0;
  const n =
    typeof value === "string"
      ? parseFloat(value.replace(/[^\d.]/g, ""))
      : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Precio de catálogo usable para vender (lista u oferta efectiva). */
export function hasValidCatalogPrice(price: unknown): boolean {
  return parseCatalogPrice(price as number | string | null | undefined) > 0;
}

export function catalogPriceMissingMessage(productName?: string): string {
  const name = String(productName || "Este producto").trim() || "Este producto";
  return `${name} no tiene precio cargado. No se puede agregar al carrito.`;
}

/** True si el color trae Precio propio (incluye "0.00"); no heredar del artículo. */
export function colorHasOwnListPrice(
  color: ColorPriceInput | null | undefined
): boolean {
  if (!color) return false;
  const raw = color.Precio;
  if (raw == null) return false;
  if (typeof raw === "string" && raw.trim() === "") return false;
  return true;
}

export function isOfferFlagActive(
  value: boolean | string | null | undefined
): boolean {
  return value === true || value === "true";
}

export function findColorDetail(
  colors: ColorDetail[] | null | undefined,
  color: string
): ColorDetail | null {
  const key = String(color ?? "")
    .trim()
    .toLowerCase();
  if (!key) return null;
  return (
    (colors ?? []).find(
      (c) => String(c.color ?? "").trim().toLowerCase() === key
    ) ?? null
  );
}

/**
 * Precio de venta de UN color. No usar GroupedProduct.Precio/OfertaActiva
 * como autoridad cuando hay ColorDetail del color seleccionado.
 * Si el color declara Precio (aunque sea 0), ese valor manda: no heredar
 * el precio de otro color vía el fallback del artículo.
 */
export function getColorEffectivePrice(
  color: ColorPriceInput | null | undefined,
  fallback?: ColorPriceInput | null
): ColorEffectivePrice {
  const normalPrice = colorHasOwnListPrice(color)
    ? parseCatalogPrice(color?.Precio)
    : parseCatalogPrice(fallback?.Precio);
  const offerRaw = parseCatalogPrice(color?.PrecioOferta);
  const isOffer = isOfferFlagActive(color?.OfertaActiva) && offerRaw > 0;
  const offerPrice = isOffer ? offerRaw : null;
  const effectivePrice = isOffer ? offerRaw : normalPrice;
  const savings =
    isOffer && normalPrice > offerRaw ? normalPrice - offerRaw : 0;
  return { normalPrice, offerPrice, effectivePrice, isOffer, savings };
}

export function cartPriceForColor(
  colors: ColorDetail[] | null | undefined,
  color: string,
  fallback?: ColorPriceInput | null
): ColorEffectivePrice {
  return getColorEffectivePrice(findColorDetail(colors, color), fallback);
}
