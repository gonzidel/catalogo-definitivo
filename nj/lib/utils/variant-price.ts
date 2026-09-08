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
 */
export function getColorEffectivePrice(
  color: ColorPriceInput | null | undefined,
  fallback?: ColorPriceInput | null
): ColorEffectivePrice {
  const normalPrice =
    parseCatalogPrice(color?.Precio) || parseCatalogPrice(fallback?.Precio);
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
