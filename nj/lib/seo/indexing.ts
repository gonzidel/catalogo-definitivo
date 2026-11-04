/**
 * Apagado hasta que el cambio de host de www esté autorizado. Encenderlo exige
 * ambas variables: nj sirviendo la raíz (rollout) y la decisión explícita de indexar.
 * Los hosts no canónicos siguen con X-Robots-Tag noindex desde el middleware.
 */
export const NJ_INDEXING_ENABLED =
  process.env.NEXT_PUBLIC_NJ_INDEXING === "1" && process.env.NEXT_PUBLIC_ROLLOUT_ENABLED === "1";

/** Landings HTML servidas por Firebase (proxy en next.config) que hoy figuran en el sitemap de www. */
export const LEGACY_LANDING_PATHS = [
  "/calzado-femenino-por-mayor",
  "/ropa-femenina-por-mayor",
  "/accesorios-por-mayor",
  "/revendedoras",
  "/lenceria-por-mayor",
] as const;
