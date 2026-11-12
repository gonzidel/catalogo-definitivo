import { CANONICAL_SITE_URL } from "../site-url";

const BOT_UA_RE =
  /bot|crawl|spider|slurp|mediapartners|facebookexternalhit|facebookcatalog|meta-externalagent|whatsapp\/|preview|embedly|quora link|pinterest|bingpreview|headless|phantom|puppeteer|playwright|selenium|lighthouse|pagespeed|gtmetrix|pingdom|uptime|monitor|curl|wget|python|axios|node-fetch|undici|go-http|java\/|okhttp|libwww|httpclient|scrapy|vercel/i;

/** Bots, crawlers, previews de links y clientes HTTP. UA vacío = bot. */
export function isBotUserAgent(ua: string | null | undefined): boolean {
  const value = (ua ?? "").trim();
  if (!value) return true;
  return BOT_UA_RE.test(value);
}

type HeaderGetter = { get(name: string): string | null };

/**
 * Navegación de documento real (no prefetch, no RSC, no fetch de datos).
 * Solo estas pueden consumir cupo o crear grants.
 */
export function isDocumentNavigation(method: string, headers: HeaderGetter): boolean {
  if (method !== "GET") return false;
  if (headers.get("rsc") || headers.get("next-router-prefetch")) return false;
  if (headers.get("next-router-state-tree")) return false;
  if (headers.get("x-middleware-prefetch")) return false;
  const purpose = `${headers.get("purpose") ?? ""} ${headers.get("sec-purpose") ?? ""}`;
  if (/prefetch|prerender/i.test(purpose)) return false;
  const dest = headers.get("sec-fetch-dest");
  if (dest) return dest === "document";
  return (headers.get("accept") ?? "").includes("text/html");
}

export function isNjDoorPath(pathname: string): boolean {
  return pathname === "/nj" || pathname.startsWith("/nj/");
}

export function isLegacyCatalogoPath(pathname: string): boolean {
  return pathname === "/catalogo" || pathname.startsWith("/catalogo/");
}

/**
 * /catalogo/<ruta> → /<ruta>. catalogo1 y nj comparten rutas 1:1
 * (home, categorías, producto, produto, tags, coleccion, banner, como-comprar, quienes-somos).
 */
export function mapLegacyCatalogoPath(pathname: string): string {
  if (pathname === "/catalogo" || pathname === "/catalogo/") return "/";
  return pathname.slice("/catalogo".length) || "/";
}

const MAX_LEGACY_SKU_LENGTH = 100;

/**
 * Destino de un link viejo `/catalogo...`.
 * El feed de Meta y los anuncios ya emitidos apuntan a `/catalogo?sku=<SKU>` (SKU de
 * variante+talle, ej. RA-001-CH-36): ese caso va a la ficha `/producto/<SKU>`.
 * El resto de los parámetros (fbclid, utm_*, color, from) se conservan.
 * Sin `sku` válido se aplica el mapeo 1:1 de `mapLegacyCatalogoPath`.
 */
export function resolveLegacyCatalogoRedirect(
  pathname: string,
  search: string
): { pathname: string; search: string } {
  const params = new URLSearchParams(search);
  const sku = (params.get("sku") ?? "").trim();
  const isCatalogoRoot = pathname === "/catalogo" || pathname === "/catalogo/";

  if (isCatalogoRoot && sku && sku.length <= MAX_LEGACY_SKU_LENGTH) {
    params.delete("sku");
    const rest = params.toString();
    return {
      pathname: `/producto/${encodeURIComponent(sku)}`,
      search: rest ? `?${rest}` : "",
    };
  }

  return { pathname: mapLegacyCatalogoPath(pathname), search };
}

const CANONICAL_HOST = new URL(CANONICAL_SITE_URL).host;

export function isCanonicalHost(host: string | null | undefined): boolean {
  return (host ?? "").trim().toLowerCase() === CANONICAL_HOST;
}
