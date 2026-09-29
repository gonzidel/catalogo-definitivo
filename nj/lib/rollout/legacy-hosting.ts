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

type Rewrite = { source: string; destination: string };
type Redirect = { source: string; destination: string; permanent: false };

/**
 * Archivos del admin vanilla, `customer.html` (QR impresos con el origen del admin) y sus scripts.
 * Tienen extensión: no pasan por middleware y nj no los tiene, así que sin proxy darían 404.
 * Solo archivos con extensión bajo /admin: las rutas del admin nj (/admin/orders…) no llevan.
 */
const LEGACY_FILE_PATHS = [
  "/customer.html",
  "/scripts/:path*",
  "/config.prod.js",
  "/fyl-flags.json",
  "/qz-site.crt",
  "/certs/:path*",
  "/icons/:path*",
  "/styles.css",
] as const;

const LEGACY_ADMIN_FILE = "/admin/:file(.+\\.(?:html|js|css|json|png|jpe?g|svg|webp|ico|mp3|wav))";

export function legacyHostingRewrites(): Rewrite[] {
  return [
    ...LEGACY_LANDING_SLUGS.flatMap((slug) => [
      { source: `/${slug}`, destination: `${LEGACY_HOSTING_ORIGIN}/${slug}` },
      { source: `/${slug}/:path*`, destination: `${LEGACY_HOSTING_ORIGIN}/${slug}` },
    ]),
    ...LEGACY_FILE_PATHS.map((path) => ({ source: path, destination: `${LEGACY_HOSTING_ORIGIN}${path}` })),
    { source: LEGACY_ADMIN_FILE, destination: `${LEGACY_HOSTING_ORIGIN}/admin/:file` },
  ];
}

/** Temporales: con nj en la raíz reemplazan los redirects de catalogo1/Firebase sin fijar nada en caché. */
export function legacyHostingRedirects(): Redirect[] {
  return [
    { source: "/admin", destination: "/admin/index.html", permanent: false },
    { source: "/catalogo.html", destination: "/", permanent: false },
    { source: "/index.html", destination: "/", permanent: false },
    { source: "/client/:path*", destination: "/", permanent: false },
  ];
}
