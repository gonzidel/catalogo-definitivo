import { clipGaParam } from "./ga";

/**
 * Medición de banners y clics en productos del catálogo (GA4).
 *
 * Los elementos se marcan con data-attributes y un único listener delegado
 * (CatalogInteractionTracker) arma los eventos. Acá viven solo los payloads.
 *
 * - `data-ga-banner="<slot>"`: contenedor de un banner del inicio.
 * - `data-ga-banner-label="<título>"`: título visible, opcional.
 * - `data-ga-product="<artículo>"`: tarjeta de producto (grilla o banner).
 */
export const GA_BANNER_ATTR = "data-ga-banner";
export const GA_BANNER_LABEL_ATTR = "data-ga-banner-label";
export const GA_PRODUCT_ATTR = "data-ga-product";

/** Slots de banner del inicio; se usan como valor de `data-ga-banner`. */
export const GA_BANNER_SLOTS = {
  info: "info_compra_minima",
  nuevosIngresos: "nuevos_ingresos",
  fylOriginals: "fyl_originals",
  curatedSpecial: "curated_special",
  curated: "curated_banner",
} as const;

/** Desplazamiento horizontal mínimo (px) para contar un banner como deslizado. */
export const BANNER_SWIPE_MIN_PX = 24;

/** Misma lista que usaba el catálogo vanilla para la grilla principal. */
export const CATALOG_GRID_LIST = "catalog_grid";

export type BannerContext = {
  slot: string;
  label?: string;
  position: number;
};

export type GaEventPayload = {
  name: string;
  params: Record<string, unknown>;
};

function bannerParams(banner: BannerContext): Record<string, unknown> {
  const params: Record<string, unknown> = {
    banner: clipGaParam(banner.slot, 60),
    banner_position: banner.position,
  };
  if (banner.label) params.banner_label = clipGaParam(banner.label, 80);
  return params;
}

export function buildBannerViewEvent(banner: BannerContext): GaEventPayload {
  return { name: "banner_view", params: bannerParams(banner) };
}

export function buildBannerSwipeEvent(banner: BannerContext): GaEventPayload {
  return { name: "banner_swipe", params: bannerParams(banner) };
}

/** Clic en el banner que no es un producto (banner completo, «Ver todo», guía). */
export function buildBannerClickEvent(
  banner: BannerContext,
  targetPath: string
): GaEventPayload {
  return {
    name: "banner_click",
    params: { ...bannerParams(banner), banner_target: clipGaParam(targetPath, 100) },
  };
}

/**
 * Clic en un producto. `select_item` es el evento estándar de GA4: se puede
 * reportar por lista (`itemListName`) y por artículo (`itemId`) sin registrar
 * dimensiones personalizadas. Dentro de un banner la lista es el banner.
 */
export function buildProductClickEvent(input: {
  articulo: string;
  index: number;
  banner?: BannerContext | null;
}): GaEventPayload | null {
  const articulo = clipGaParam(input.articulo, 80);
  if (!articulo) return null;
  const listId = input.banner ? `banner_${input.banner.slot}` : CATALOG_GRID_LIST;
  const params: Record<string, unknown> = {
    item_list_id: listId,
    item_list_name: input.banner ? `Banner ${input.banner.slot}` : CATALOG_GRID_LIST,
    items: [
      {
        item_id: articulo,
        item_name: articulo,
        index: Math.max(1, Math.floor(input.index)),
      },
    ],
  };
  if (input.banner) {
    params.banner = clipGaParam(input.banner.slot, 60);
    params.banner_position = input.banner.position;
  }
  return { name: "select_item", params };
}

export function isBannerSwipe(startLeft: number, currentLeft: number): boolean {
  return Math.abs(currentLeft - startLeft) >= BANNER_SWIPE_MIN_PX;
}
