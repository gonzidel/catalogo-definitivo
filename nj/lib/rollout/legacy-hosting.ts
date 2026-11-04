/** Hosting vanilla (Firebase) que hoy sirve las landings SEO detrás de catalogo1. */
export const LEGACY_HOSTING_ORIGIN = "https://catalogo-fyl-test.web.app";

/** Landings que siguen sirviéndose desde Firebase cuando nj ocupa la raíz. */
export const LEGACY_LANDING_SLUGS = [
  "revendedoras",
  "calzado-femenino-por-mayor",
  "ropa-femenina-por-mayor",
  "lenceria-por-mayor",
  "accesorios-por-mayor",
  "privacy-policy",
  "terms",
] as const;

export function isLegacyLandingPath(pathname: string): boolean {
  const first = pathname.split("/")[1] ?? "";
  return (LEGACY_LANDING_SLUGS as readonly string[]).includes(first);
}
