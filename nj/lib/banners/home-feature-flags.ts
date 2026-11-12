/**
 * Flags públicos del inicio (tabla `home_feature_flags`, migración 383).
 * Solo constantes: lo usan tanto el SSR (presencia) como el cliente (fetch del banner).
 */
export const HOME_FEATURE_FLAGS_TABLE = "home_feature_flags";

/** Check de https://app.fylmoda.com.ar/admin/offers.html que muestra el banner de Ofertas. */
export const HOME_OFFERS_BANNER_FLAG = "home_offers_banner";

/**
 * Revisión visual en un deploy que no es producción: muestra el banner aunque la tabla
 * del check todavía no exista. En producción no se define, así que manda solo el check.
 */
export function offersBannerPreviewOverride(): boolean {
  return process.env.NEXT_PUBLIC_OFFERS_BANNER_PREVIEW === "1";
}
